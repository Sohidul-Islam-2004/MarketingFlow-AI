// Publishes content to Facebook Pages and Instagram.
// The background job (jobs.js) calls publishDuePosts() every 30 seconds.
//
// Supported posts: text only (Facebook), 1 image, several images (album / carousel), 1 video (Instagram: Reel).
// Each target (Page / Instagram account) is tried up to 3 times. Instagram videos need a few seconds of
// processing, so the item stays "Publishing" until Instagram is ready.
const fs = require("fs");
const path = require("path");
const { ContentItem, MediaAsset, SocialAccount } = require("../models");
const { graph, GRAPH, GRAPH_VIDEO } = require("../lib/graph");
const { decrypt } = require("../lib/crypto");
const { fail } = require("../lib/errors");
const { notify } = require("../lib/notify");
const { PUBLIC_BASE_URL } = require("../config");

const MAX_TRIES = 3;
const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
const isPublicServer = () => /^https:\/\//.test(PUBLIC_BASE_URL) && !/localhost|127\.0\.0\.1/.test(PUBLIC_BASE_URL);
const publicUrl = (media) => (/^https?:\/\//.test(media.url) ? media.url : isPublicServer() ? PUBLIC_BASE_URL + media.url : null);

function captionFor(item, platform) {
  const text = platform === "Instagram" && item.instagramText ? item.instagramText : item.text;
  const tags = (item.hashtags || []).filter((h) => !text.includes(h));
  return [text, tags.join(" ")].filter(Boolean).join("\n\n").trim();
}

async function mediaOf(item) {
  const rows = await MediaAsset.find({ _id: { $in: item.mediaIds }, organizationId: item.organizationId }).lean();
  return item.mediaIds.map((id) => rows.find((m) => m._id === id)).filter(Boolean);
}

// Problems that would make Meta reject the post. Shown before scheduling and stored on failure.
function checkPost(item, platform, media) {
  const problems = [];
  const text = captionFor(item, platform);
  const videos = media.filter((m) => m.kind === "video");
  if (videos.length && media.length > 1) problems.push("Use either one video or images, not both");
  if (platform === "Facebook" && !text && !media.length) problems.push("Write a caption or add a photo");
  if (platform === "Instagram") {
    if (!media.length) problems.push("Instagram needs at least one photo or video");
    if (media.length > 10) problems.push("Instagram allows max 10 photos");
    if (text.length > 2200) problems.push("Instagram caption is longer than 2,200 characters");
    if ((text.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) problems.push("Instagram allows max 30 hashtags");
    if (media.some((m) => m.kind === "image" && m.mimeType && !/jpe?g/i.test(m.mimeType))) problems.push("Instagram accepts JPG photos only");
    if (media.some((m) => !publicUrl(m))) problems.push("Instagram needs PUBLIC_BASE_URL (your https tunnel/domain) in .env");
  }
  return problems;
}

async function checkItem(item) {
  const media = await mediaOf(item);
  const problems = [];
  for (const t of item.targets) problems.push(...checkPost(item, t.platform, media).map((p) => `${t.accountName}: ${p}`));
  if (!item.targets.length) problems.push("Choose at least one Page or Instagram account");
  return problems;
}

// Facebook upload: by public URL when the server is public, otherwise by sending the file
async function uploadToFacebook(endpoint, token, media, fields, isVideo) {
  const base = isVideo ? GRAPH_VIDEO : GRAPH;
  const url = publicUrl(media);
  if (url) return graph(endpoint, { token, method: "POST", base, body: { ...fields, [isVideo ? "file_url" : "url"]: url } });
  const file = path.join(UPLOAD_DIR, media.file || "");
  if (!media.file || !fs.existsSync(file)) throw fail(400, `File missing: ${media.name}`);
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append("source", new Blob([fs.readFileSync(file)], { type: media.mimeType }), media.file);
  const res = await fetch(`${base}${endpoint}?access_token=${encodeURIComponent(token)}`, { method: "POST", body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw fail(502, json.error?.message || `Upload failed (${res.status})`);
  return json;
}

async function publishToFacebook(item, account, media) {
  const token = decrypt(account.accessToken), page = account.accountId, text = captionFor(item, "Facebook");
  const video = media.find((m) => m.kind === "video");
  const images = media.filter((m) => m.kind === "image");
  let postId;
  if (video) postId = (await uploadToFacebook(`/${page}/videos`, token, video, { description: text }, true)).id;
  else if (images.length === 1) { const r = await uploadToFacebook(`/${page}/photos`, token, images[0], { message: text }); postId = r.post_id || r.id; }
  else if (images.length > 1) {
    const photoIds = [];
    for (const img of images.slice(0, 10)) photoIds.push((await uploadToFacebook(`/${page}/photos`, token, img, { published: false })).id);
    postId = (await graph(`/${page}/feed`, { token, method: "POST", body: { message: text, attached_media: photoIds.map((id) => ({ media_fbid: id })) } })).id;
  } else postId = (await graph(`/${page}/feed`, { token, method: "POST", body: { message: text } })).id;
  const info = await graph(`/${postId}`, { token, params: { fields: "permalink_url" } }).catch(() => ({}));
  return { postId, permalink: info.permalink_url || null };
}

async function publishToInstagram(item, target, account, media) {
  const token = decrypt(account.accessToken), ig = account.accountId, caption = captionFor(item, "Instagram");
  if (!target.containerId) {
    const video = media.find((m) => m.kind === "video");
    let body;
    if (video) body = { media_type: "REELS", video_url: publicUrl(video), caption, share_to_feed: true };
    else if (media.length === 1) body = { image_url: publicUrl(media[0]), caption };
    else {
      const children = [];
      for (const img of media.slice(0, 10)) children.push((await graph(`/${ig}/media`, { token, method: "POST", body: { image_url: publicUrl(img), is_carousel_item: true } })).id);
      body = { media_type: "CAROUSEL", children: children.join(","), caption };
    }
    target.containerId = (await graph(`/${ig}/media`, { token, method: "POST", body })).id;
  }
  const state = await graph(`/${target.containerId}`, { token, params: { fields: "status_code" } });
  if (state.status_code === "IN_PROGRESS") return { processing: true };
  if (state.status_code === "ERROR" || state.status_code === "EXPIRED") { target.containerId = null; throw fail(502, "Instagram couldn't process the media"); }
  const published = await graph(`/${ig}/media_publish`, { token, method: "POST", body: { creation_id: target.containerId } });
  const info = await graph(`/${published.id}`, { token, params: { fields: "permalink" } }).catch(() => ({}));
  return { postId: published.id, permalink: info.permalink || null };
}

async function publishItem(item) {
  const media = await mediaOf(item);
  let retryLater = false, stillProcessing = false;
  for (const t of item.targets) {
    if (t.status === "published" || (t.status === "failed" && t.attempts >= MAX_TRIES)) continue;
    try {
      const account = await SocialAccount.findOne({ _id: t.accountId, organizationId: item.organizationId }).select("+accessToken");
      if (!account) throw fail(400, "Account was disconnected");
      const problems = checkPost(item, account.platform, media);
      if (problems.length) { Object.assign(t, { status: "failed", attempts: MAX_TRIES, error: problems.join("; ") }); continue; }
      const r = account.platform === "Instagram" ? await publishToInstagram(item, t, account, media) : await publishToFacebook(item, account, media);
      if (r.processing) { t.status = "processing"; stillProcessing = true; }
      else Object.assign(t, { status: "published", postId: r.postId, permalink: r.permalink, error: null });
    } catch (e) {
      t.attempts += 1;
      t.error = e.message;
      t.status = t.attempts >= MAX_TRIES ? "failed" : "pending";
      if (t.status === "pending") retryLater = true;
    }
  }
  if (retryLater || stillProcessing) {
    item.status = "Publishing";
    item.nextTryAt = new Date(Date.now() + (retryLater ? 2 * 60e3 : 20e3));
  } else {
    const ok = item.targets.filter((t) => t.status === "published").length;
    item.status = ok === item.targets.length ? "Published" : ok ? "Partly published" : "Failed";
    item.publishedAt = ok ? new Date() : null;
    item.nextTryAt = null;
    const failed = item.targets.filter((t) => t.status === "failed");
    item.lastError = failed.map((t) => `${t.accountName}: ${t.error}`).join(" | ") || null;
    if (failed.length) await notify(item.organizationId, `Post failed: ${item.title || "untitled"}`, item.lastError, "content");
  }
  item.lockedUntil = null;
  item.markModified("targets");
  await item.save();
}

// Picks scheduled posts one by one. The lock stops two servers publishing the same post.
async function publishDuePosts() {
  const now = new Date();
  for (let i = 0; i < 20; i++) {
    const item = await ContentItem.findOneAndUpdate(
      {
        status: { $in: ["Scheduled", "Publishing"] },
        scheduledAt: { $lte: now },
        $and: [{ $or: [{ nextTryAt: null }, { nextTryAt: { $lte: now } }] }, { $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] }],
      },
      { $set: { status: "Publishing", lockedUntil: new Date(Date.now() + 5 * 60e3) } },
      { new: true, sort: { scheduledAt: 1 } }
    );
    if (!item) return;
    await publishItem(item).catch(async (e) => {
      console.error("publish:", e.message);
      await ContentItem.updateOne({ _id: item._id }, { lockedUntil: null, nextTryAt: new Date(Date.now() + 2 * 60e3) });
    });
  }
}

module.exports = { checkItem, publishDuePosts, captionFor };
