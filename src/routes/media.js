// Photo and video uploads for a post. Temporary: deleted once the post is sent (services/tempMedia.js).
const router = require("express").Router();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { MediaAsset, ContentItem } = require("../models");
const { handle, fail } = require("../lib/errors");
const { removeMedia } = require("../services/tempMedia");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || (file.mimetype.startsWith("video") ? ".mp4" : ".jpg")).toLowerCase().replace(/[^.a-z0-9]/g, "");
      cb(null, `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype)),
});

router.post("/", upload.array("files", 10), handle(async (req, res) => {
  if (!req.files?.length) throw fail(400, "Choose a photo or video");
  const saved = [];
  for (const f of req.files) {
    saved.push(await MediaAsset.create({
      organizationId: req.org, name: f.originalname, kind: f.mimetype.startsWith("video") ? "video" : "image",
      mimeType: f.mimetype, size: f.size, file: f.filename, url: `/uploads/${f.filename}`,
    }));
  }
  res.json(saved);
}));

// The browser calls this when publishing failed, so the files don't wait 24 hours: { ids: [...] }
router.post("/discard", handle(async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(String);
  const busy = await ContentItem.find({ organizationId: req.org, mediaIds: { $in: ids }, status: { $in: ["Scheduled", "Publishing"] } }).select("mediaIds").lean();
  const inUse = new Set(busy.flatMap((b) => b.mediaIds));
  await removeMedia(req.org, ids.filter((id) => !inUse.has(id)));
  res.json({ ok: true });
}));

module.exports = router;
