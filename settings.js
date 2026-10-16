const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const settingsFile = path.join(__dirname, ".download-any.json");

function readDirectorySettings(file = settingsFile) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof value?.downloadDir !== "string" || !value.downloadDir.trim()) throw new Error("Invalid directory setting");
    if (value.platform && value.platform !== process.platform
      && (path.win32.isAbsolute(value.downloadDir) || path.posix.isAbsolute(value.downloadDir))) {
      return { warning: "上次的保存目录来自其他系统，当前使用默认目录。" };
    }
    return { downloadDir: value.downloadDir };
  } catch (error) {
    return error.code === "ENOENT" ? {} : { warning: "保存目录设置无法读取，当前使用默认目录；可重新选择保存。" };
  }
}

function getDownloadDir(directory = process.env.DOWNLOAD_DIR, file = settingsFile) {
  return path.resolve(path.dirname(file), directory || readDirectorySettings(file).downloadDir || "downloads");
}

async function ensureWritableDir(directory) {
  await fsp.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.download-any-${randomUUID()}.tmp`);
  // A real write also checks Windows ACLs, which access(W_OK) does not reliably test.
  const handle = await fsp.open(probe, "wx", 0o600);
  try { await handle.close(); }
  finally { await fsp.rm(probe, { force: true }); }
}

async function saveDownloadDir(directory, file = settingsFile) {
  const root = path.dirname(file);
  const relative = path.relative(root, directory);
  const insideProject = !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  const downloadDir = insideProject ? (relative || ".").split(path.sep).join("/") : directory;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify({ downloadDir, platform: process.platform }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await fsp.rename(temporary, file);
  } finally { await fsp.rm(temporary, { force: true }); }
}

module.exports = { settingsFile, readDirectorySettings, getDownloadDir, ensureWritableDir, saveDownloadDir };
