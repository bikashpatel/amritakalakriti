'use strict';
// Image uploads for the admin. Files are held in memory, checked by their actual bytes (not just the
// extension) and only then written to public/uploads with a random name.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

fs.mkdirSync(config.uploadDir, { recursive: true });

const MAX_MB = 8;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 10 },
});

function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'gif';
  if (buf.toString('ascii', 4, 12) === 'ftypavif') return 'avif';
  return null;
}

// Saves multer files and returns their public paths. Non-images are skipped and reported.
function saveImages(files = []) {
  const saved = [];
  const rejected = [];
  for (const f of files) {
    if (!f || !f.buffer || !f.size) continue;
    const ext = sniff(f.buffer);
    if (!ext) { rejected.push(f.originalname); continue; }
    const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(config.uploadDir, name), f.buffer);
    saved.push(`/uploads/${name}`);
  }
  return { saved, rejected };
}

// Deletes an uploaded file, but never touches bundled images outside /uploads.
function removeImage(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return;
  const file = path.join(config.uploadDir, path.basename(publicPath));
  fs.rm(file, { force: true }, () => {});
}

module.exports = { upload, saveImages, removeImage, MAX_MB };
