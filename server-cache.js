const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createWriteStream } = require("node:fs");
const { sanitizeFilename } = require("./media-file");
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class ServerCache {
  constructor({ cacheDir, retentionMs, downloadedRetentionMs = 300000, maxFileBytes, maxCacheBytes, now = Date.now }) {
    Object.assign(this, { root: path.resolve(cacheDir), retentionMs, downloadedRetentionMs, maxFileBytes, maxCacheBytes, now });
    this.entries = new Map();
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.lockFile = path.join(this.root, ".lock");
    try {
      const previous = JSON.parse(await fs.readFile(this.lockFile, "utf8"));
      if (Number.isInteger(previous.pid) && previous.pid > 0) {
        try { process.kill(previous.pid, 0); throw new Error("临时目录正在被另一实例使用，请先停止旧实例。"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      } else throw new Error("临时目录锁文件无效，请检查服务器数据目录。");
      await fs.unlink(this.lockFile);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    this.lockId = randomUUID();
    await fs.writeFile(this.lockFile, JSON.stringify({ pid: process.pid, id: this.lockId }), { flag: "wx", mode: 0o600 });
    try {
      for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
        if (entry.isDirectory() && idPattern.test(entry.name)) await fs.rm(path.join(this.root, entry.name), { recursive: true, force: true });
      }
    } catch (error) { await this.close(); throw error; }
  }
  async create(id) {
    if (!idPattern.test(id)) throw new Error("临时任务编号无效。");
    if (this.entries.size >= 20) throw new Error("服务器已保留 20 个临时任务，请先清除已保存的结果或等待到期清理。");
    const used = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const stat = await fs.statfs(this.root);
    const available = Math.min(this.maxCacheBytes - used, Number(stat.bavail) * Number(stat.bsize) - 64 * 1024 * 1024);
    const maxBytes = Math.min(this.maxFileBytes, Math.floor(available / 3));
    if (maxBytes < 1024 * 1024) throw new Error("服务器临时空间不足，请等待过期文件清理后重试。");
    const directory = path.join(this.root, id);
    await fs.mkdir(directory, { mode: 0o700 });
    this.entries.set(id, { directory, bytes: 0, readers: 0, expiresAt: Infinity });
    return { directory, maxBytes };
  }
  async finish(id, bytes, parts = ["video"]) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxCacheBytes) throw new Error("处理结果超出服务器缓存限制。");
    entry.bytes = bytes;
    entry.pendingParts = new Set(parts);
    entry.deliveries = new Map();
    entry.expiresAt = this.now() + this.retentionMs;
    return entry.expiresAt;
  }
  recordDelivery(id, part, start, end, size) {
    const entry = this.entries.get(id);
    if (!entry?.pendingParts?.has(part)) return;
    const previous = entry.deliveries.get(part);
    const ranges = previous?.size === size ? previous.ranges : [];
    const merged = [];
    for (const range of [...ranges, [start, end]].sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    // Bound bookkeeping for clients issuing many disjoint Range requests.
    entry.deliveries.set(part, { size, ranges: merged.slice(0, 64) });
    if (merged.length !== 1 || merged[0][0] !== 0 || merged[0][1] !== size - 1) return;
    entry.pendingParts.delete(part);
    entry.deliveries.delete(part);
    if (!entry.pendingParts.size) {
      entry.transferredAt = this.now();
      entry.expiresAt = Math.min(entry.expiresAt, entry.transferredAt + this.downloadedRetentionMs);
    }
    return { complete: !entry.pendingParts.size, transferredAt: entry.transferredAt, expiresAt: entry.expiresAt };
  }
  pin(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.deleting || entry.expiresAt <= this.now()) return null;
    entry.readers++;
    return () => { entry.readers--; };
  }
  async remove(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.readers || entry.deleting) return false;
    entry.deleting = true;
    try {
      await fs.rm(entry.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      this.entries.delete(id);
      return true;
    } catch (error) { entry.deleting = false; entry.expiresAt = Math.min(entry.expiresAt, this.now()); throw error; }
  }
  async sweep() {
    const expired = [];
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now() && await this.remove(id)) expired.push(id);
    return expired;
  }
  async close() {
    if (!this.lockId) return;
    try {
      const previous = JSON.parse(await fs.readFile(this.lockFile, "utf8"));
      if (previous.id === this.lockId) {
        for (const id of this.entries.keys()) {
          if (!await this.remove(id)) throw new Error("仍有临时文件正在传输或清理，无法释放缓存锁。");
        }
        await fs.unlink(this.lockFile);
        this.lockId = null;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function receiveVideo(request, directory, { maxBytes, signal, onProgress }) {
  const length = Number(request.headers["content-length"] || request.headers["x-file-size"]);
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes) throw new Error(`视频大小须在 1 字节～${Math.floor(maxBytes / 1024 / 1024)} MB 之间。`);
  let name;
  try { name = decodeURIComponent(request.headers["x-file-name"] || ""); } catch { throw new Error("文件名无法识别。"); }
  if (!name || name.length > 512 || /[/\\\0]/.test(name)) throw new Error("请选择有效的视频文件。");
  const extension = path.extname(name).toLowerCase();
  const source = path.join(directory, `${sanitizeFilename(path.basename(name, extension))}${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".media"}`);
  let received = 0;
  let update = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    received += chunk.length;
    if (received > length || received > maxBytes) return callback(new Error("视频超出上传大小限制。"));
    if (Date.now() - update > 300) { update = Date.now(); onProgress({ received, total: length }); }
    callback(null, chunk);
  } });
  request.setTimeout(60000, () => request.destroy(new Error("视频上传超时，请重试。")));
  await pipeline(request, limit, createWriteStream(source, { flags: "wx", mode: 0o600 }), { signal });
  if (received !== length) throw new Error("视频没有上传完整，请重试。");
  return { source, name };
}

module.exports = { ServerCache, receiveVideo };
