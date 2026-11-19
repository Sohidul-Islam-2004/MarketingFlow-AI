// Photos and videos are NOT kept. They are uploaded only when a post is published or scheduled,
// sent to Facebook / Instagram, then deleted (file + database row).
//   - Publish now: deleted as soon as every account is done (Instagram may need a few minutes for a video)
//   - Schedule on Facebook: sent to Facebook straight away (Facebook keeps the scheduled post), then deleted
//   - Anything left behind (closed browser, failed request): deleted after 24 hours
const fs = require("fs");
const path = require("path");
const { MediaAsset, ContentItem } = require("../models");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");

async function removeMedia(org, ids = []) {
  if (!ids.length) return;
  const rows = await MediaAsset.find({ organizationId: org, _id: { $in: ids } }).select("file").lean();
  for (const m of rows) if (m.file) await fs.promises.unlink(path.join(UPLOAD_DIR, m.file)).catch(() => {});
  await MediaAsset.deleteMany({ organizationId: org, _id: { $in: ids } });
}

// After a post is done with its files: remember how many there were, then delete them
async function releasePostMedia(item) {
  if (!item.mediaIds?.length) return;
  item.mediaCount = item.mediaIds.length;
  await removeMedia(item.organizationId, item.mediaIds);
  item.mediaIds = [];
}

// Files older than a day that no post is still sending
let lastSweep = 0;
async function sweepOldMedia() {
  if (Date.now() - lastSweep < 30 * 60e3) return; // at most every 30 minutes
  lastSweep = Date.now();
  const old = await MediaAsset.find({ createdAt: { $lt: new Date(Date.now() - 24 * 3600e3) } }).select("organizationId file").lean();
  for (const m of old) {
    if (await ContentItem.exists({ mediaIds: m._id, status: { $in: ["Publishing", "Scheduled"] } })) continue;
    if (m.file) await fs.promises.unlink(path.join(UPLOAD_DIR, m.file)).catch(() => {});
    await MediaAsset.deleteOne({ _id: m._id });
  }
}

module.exports = { removeMedia, releasePostMedia, sweepOldMedia, UPLOAD_DIR };
