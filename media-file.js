const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function sanitizeFilename(name) {
  const characters = Array.from(String(name || "").replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").trim()).slice(0, 80);
  while (Buffer.byteLength(characters.join(""), "utf8") > 200) characters.pop();
  let result = characters.join("").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result && result !== "." && result !== ".." ? result : `video_${Date.now()}`;
}

async function publishFile(partial, { outputDir, title, extension = ".mp4", signal }) {
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) throw new Error("导出文件格式无效。");
  signal?.throwIfAborted();
  const stat = await fsp.stat(partial);
  if (!stat.isFile() || !stat.size) throw new Error("下载的视频为空，请重试。");
  const safeName = sanitizeFilename(title);
  for (let index = 0; ; index++) {
    signal?.throwIfAborted();
    const candidate = path.join(outputDir, `${safeName}${index ? ` (${index})` : ""}${extension}`);
    try {
      try { await fsp.link(partial, candidate); }
      catch (error) {
        if (!["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL"].includes(error.code)) throw error;
        await fsp.copyFile(partial, candidate, fs.constants.COPYFILE_EXCL);
      }
      return { file: candidate, filename: path.basename(candidate), bytes: stat.size };
    } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
}

function publishVideo(partial, options) { return publishFile(partial, options); }

module.exports = { sanitizeFilename, publishFile, publishVideo };
