const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createGunzip } = require("node:zlib");
const { projectDir } = require("./runtime");
const { runProcess } = require("./process-runner");
const manifest = require("./tools-manifest.json");

function findExecutable(name, override, extraDirectories = []) {
  if (override) return path.resolve(projectDir, override);
  const filename = `${name}${process.platform === "win32" ? ".exe" : ""}`;
  const directories = [...extraDirectories, ...(process.env.PATH || "").split(path.delimiter)];
  if (process.platform === "darwin") directories.push("/opt/homebrew/bin", "/usr/local/bin");
  return directories.filter(Boolean).map(directory => path.resolve(directory.replace(/^"|"$/g, ""), filename))
    .find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
}

async function fileHash(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function installAsset(spec, target, { signal, onLog = () => {} } = {}) {
  signal?.throwIfAborted();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    if ((await fsp.stat(target)).size === spec.size && await fileHash(target) === spec.sha256) return target;
    onLog("本地工具校验未通过，正在重新安装……");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (let attempt = 0; attempt < 2; attempt++) {
    const partial = `${target}.${randomUUID()}.part`;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let idle;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new Error("下载工具连接超时。")), 60000); idle.unref(); };
    const timer = setTimeout(() => controller.abort(new Error("下载工具安装超时，请检查网络后重试。")), 300000);
    timer.unref();
    try {
      touch();
      const response = await fetch(spec.url, { signal: combined });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`下载工具失败（HTTP ${response.status}）。`); }
      const hash = createHash("sha256");
      let received = 0;
      let rawBytes = 0;
      const rawLimit = new Transform({ transform(chunk, encoding, callback) {
        touch(); rawBytes += chunk.length;
        callback(rawBytes > 150 * 1024 * 1024 ? new Error("工具安装包超出大小限制。") : null, chunk);
      } });
      const verify = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length; hash.update(chunk);
        callback(received > spec.size ? new Error("工具大小校验失败。") : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), rawLimit, ...(spec.gzip ? [createGunzip()] : []), verify,
        fs.createWriteStream(partial, { flags: "wx", mode: 0o755 }), { signal: combined });
      combined.throwIfAborted();
      if (received !== spec.size || hash.digest("hex") !== spec.sha256) throw new Error("工具 SHA-256 校验失败，请重试。");
      await fsp.chmod(partial, 0o755);
      await fsp.rename(partial, target);
      return target;
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === 1) throw controller.signal.aborted ? controller.signal.reason : error;
      onLog("工具安装未完成，正在重试一次……");
    } finally {
      clearTimeout(timer); clearTimeout(idle);
      await fsp.rm(partial, { force: true });
    }
  }
}

async function ensureTools(names, { signal, onLog = () => {} } = {}) {
  const specs = manifest[`${process.platform}-${process.arch}`];
  const result = {};
  for (const [name, variable] of [["yt-dlp", "YTDLP_PATH"], ["ffmpeg", "FFMPEG_PATH"], ["ffprobe", "FFPROBE_PATH"]]) {
    if (!names.includes(name)) continue;
    signal?.throwIfAborted();
    const extra = name === "ffprobe" && result.ffmpeg ? [path.dirname(result.ffmpeg)] : [];
    let executable = findExecutable(name, process.env[variable], extra);
    if (executable) {
      try { await runProcess(executable, [name === "yt-dlp" ? "--version" : "-version"], { signal, timeoutMs: 15000 }); }
      catch (error) {
        signal?.throwIfAborted();
        if (process.env[variable]) throw new Error(`${variable} 指定的工具无法运行：${error.message}`);
        onLog(`${name} 无法运行，将安装兼容版本。`); executable = null;
      }
    }
    if (!executable) {
      if (!specs) throw new Error(`此系统请先安装 yt-dlp、FFmpeg 和 ffprobe，并加入 PATH：${process.platform}/${process.arch}`);
      const spec = specs[name];
      executable = path.join(path.resolve(projectDir, process.env.DOWNLOAD_ANY_TOOLS_DIR || ".tools"), `${process.platform}-${process.arch}`, spec.version, `${name}${process.platform === "win32" ? ".exe" : ""}`);
      if (!fs.existsSync(executable)) onLog(`正在安装 ${name} ${spec.version}（需要联网）……`);
      await installAsset(spec, executable, { signal, onLog });
      await runProcess(executable, [name === "yt-dlp" ? "--version" : "-version"], { signal, timeoutMs: 15000 });
    }
    result[name === "yt-dlp" ? "ytDlp" : name] = executable;
  }
  return result;
}

async function ensureBilibiliTools(options = {}) {
  const result = await ensureTools(["yt-dlp", "ffmpeg", "ffprobe"], options);
  options.onLog?.("B 站下载工具已就绪。");
  return result;
}

function ensureMediaTools(options) { return ensureTools(["ffmpeg", "ffprobe"], options); }

module.exports = { ensureBilibiliTools, ensureMediaTools, installAsset, findExecutable };
