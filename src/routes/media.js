// Photo and video uploads (stored in /uploads)
const router = require("express").Router();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { MediaAsset, ContentItem } = require("../models");
const { handle, fail } = require("../lib/errors");

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

router.get("/", handle(async (req, res) => {
  res.json(await MediaAsset.find({ organizationId: req.org }).sort({ createdAt: -1 }).limit(200).lean());
}));

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

router.delete("/:id", handle(async (req, res) => {
  const m = await MediaAsset.findOne({ _id: req.params.id, organizationId: req.org });
  if (!m) throw fail(404, "File not found");
  if (await ContentItem.exists({ organizationId: req.org, mediaIds: m._id, status: { $in: ["Scheduled", "Publishing"] } })) throw fail(400, "A scheduled post uses this file");
  if (m.file) fs.promises.unlink(path.join(UPLOAD_DIR, m.file)).catch(() => {});
  await m.deleteOne();
  res.json({ ok: true });
}));

module.exports = router;
