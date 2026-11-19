// Product photos and photos the shop sends in chats (models/Photo.js).
// The browser makes them small first, so they fit in the database; Facebook and Instagram fetch them from /photos/<id>.
const { Photo, Product } = require("../models");
const { fail } = require("../lib/errors");
const { PUBLIC_BASE_URL } = require("../config");

const MAX_BYTES = 1.5 * 1024 * 1024;
const CHAT_PHOTO_DAYS = 7;

// "data:image/jpeg;base64,..." -> a saved Photo. Returns its path "/photos/<id>".
async function savePhoto(org, dataUrl, { kind = "product", productId = null } = {}) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw fail(400, "Choose a JPG, PNG or WebP photo");
  const size = Math.floor((m[2].length * 3) / 4);
  if (size > MAX_BYTES) throw fail(400, "The photo is too big (max 1.5 MB)");
  const photo = await Photo.create({ organizationId: org, kind, productId, mimeType: m[1], data: m[2], size });
  return `/photos/${photo._id}`;
}

// A product's new photo (the old one is deleted)
async function setProductPhoto(org, productId, dataUrl) {
  const product = await Product.findOne({ _id: productId, organizationId: org });
  if (!product) throw fail(404, "Product not found");
  const url = await savePhoto(org, dataUrl, { kind: "product", productId });
  await removeProductPhoto(org, product, url);
  product.imageUrl = url;
  await product.save();
  return url;
}

// Deletes the product's saved photos (except keepUrl)
async function removeProductPhoto(org, product, keepUrl = null) {
  const keep = keepUrl ? keepUrl.split("/").pop() : null;
  const ids = (await Photo.find({ organizationId: org, productId: product._id }).select("_id").lean()).map((p) => p._id).filter((id) => id !== keep);
  if (ids.length) await Photo.deleteMany({ _id: { $in: ids } });
}

// GET /photos/:id  (public: Facebook and Instagram download it from here)
async function servePhoto(req, res) {
  let photo = null;
  try { photo = await Photo.findById(String(req.params.id).replace(/\.\w+$/, "")).lean(); } catch { /* bad id */ }
  if (!photo) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("Content-Type", photo.mimeType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // a new photo always gets a new id
  res.end(Buffer.from(photo.data, "base64"));
}

// Full address Facebook can download: "/photos/x" -> "https://your-site/photos/x". null when the server isn't public.
function publicPhotoUrl(url) {
  if (/^https:\/\//.test(url || "")) return url;
  if (!url || !/^https:\/\//.test(PUBLIC_BASE_URL) || /localhost|127\.0\.0\.1/.test(PUBLIC_BASE_URL)) return null;
  return PUBLIC_BASE_URL + url;
}

// Photos sent from the Inbox are only needed for a few days
async function sweepChatPhotos() {
  await Photo.deleteMany({ kind: "chat", createdAt: { $lt: new Date(Date.now() - CHAT_PHOTO_DAYS * 86400e3) } });
}

module.exports = { savePhoto, setProductPhoto, removeProductPhoto, servePhoto, publicPhotoUrl, sweepChatPhotos };
