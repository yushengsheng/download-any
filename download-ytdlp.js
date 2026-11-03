const fsp = require("node:fs/promises");
const path = require("node:path");
const { getDownloadDir } = require("./runtime");
const { ensureDownloadTools } = require("./download-tools");
const { runProcess } = require("./process-runner");
const { publishVideo } = require("./media-file");

async function downloadWithYtDlp(url, { name, extraArgs = [], title: preferredTitle }, { outputDir = getDownloadDir(), onLog = console.log, onProgress = () => {}, signal,
  ensureTools = ensureDownloadTools, run = runProcess, timeoutMs = 7200000, maxBytes = 20 * 1024 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  const tools = await ensureTools({ signal, onLog });
  signal?.throwIfAborted();
  await fsp.mkdir(outputDir, { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(outputDir, ".download-any-"));
  const file = path.join(scratch, "media.mp4");
  let title = preferredTitle || new URL(url).pathname.split("/").filter(Boolean).at(-1);
  let duration;
  let finalFile;
  const streams = new Map();
  try {
    onLog(`正在解析 ${name} 视频：${url}`);
    // Missing fields otherwise produce bare NA, even with JSON output templates.
    await run(tools.ytDlp, [
      "--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-playlist", "--no-simulate", "--no-colors",
      "--encoding", "utf-8", "--output-na-placeholder", "null", "--socket-timeout", "15", "--retries", "2", "--fragment-retries", "2", "--extractor-retries", "1",
      "--concurrent-fragments", "1", "--abort-on-unavailable-fragments", "--max-filesize", String(maxBytes), "--no-continue", "--no-overwrites",
      "--playlist-items", "1", ...extraArgs,
      "--ffmpeg-location", tools.ffmpeg, "--merge-output-format", "mp4", "--remux-video", "mp4",
      "--format", "bv[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/b[vcodec^=avc1][acodec^=mp4a][ext=mp4]/bv[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
      "--paths", scratch, "--output", "media.%(ext)s",
      "--newline", "--progress", "--progress-delta", "1", "--progress-template", "download:DA_PROGRESS:%(progress)j",
      "--print", "before_dl:DA_LIVE:%(is_live)j", "--print", "before_dl:DA_TITLE:%(title)j", "--print", "before_dl:DA_DURATION:%(duration)j", "--print", "after_move:DA_FILE:%(filepath)j", url
    ], { signal, timeoutMs, cwd: scratch, capture: false, onLine: line => {
      if (line.startsWith("DA_LIVE:")) { if (JSON.parse(line.slice(8)) === true) throw new Error("暂不支持正在进行的直播，请等待直播结束后下载。"); }
      else if (line.startsWith("DA_TITLE:")) { const value = JSON.parse(line.slice(9)); if (!preferredTitle && typeof value === "string" && value.trim()) title = value; }
      else if (line.startsWith("DA_DURATION:")) duration = Number(JSON.parse(line.slice(12)));
      else if (line.startsWith("DA_FILE:")) finalFile = JSON.parse(line.slice(8));
      else if (line.startsWith("DA_PROGRESS:")) {
        const progress = JSON.parse(line.slice(12));
        const received = Number(progress.downloaded_bytes) || 0;
        const total = Number(progress.total_bytes || progress.total_bytes_estimate) || 0;
        if (!streams.has(progress.filename)) {
          if (streams.size >= 4) throw new Error("视频流数量异常，已停止下载。");
          onLog(streams.size ? "正在下载音轨……" : "正在下载视频画面……");
        }
        // Audio and video arrive separately; retain progress for both streams.
        streams.set(progress.filename, { received, total });
        const all = [...streams.values()];
        if (all.reduce((sum, item) => sum + item.received, 0) > maxBytes) throw new Error("视频超过当前服务器的文件大小或可用空间限制。");
        onProgress({ received: all.reduce((sum, item) => sum + item.received, 0), total: all.every(item => item.total > 0) ? all.reduce((sum, item) => sum + Math.max(item.received, item.total), 0) : 0 });
      } else onLog(line.slice(0, 1200));
    } });
    signal?.throwIfAborted();
    if (!finalFile || path.resolve(finalFile) !== file) throw new Error(`${name} 下载未生成完整的 MP4 文件，请重试。`);
    onProgress({ received: 0, total: 0 });
    onLog("音视频已合并，正在检查文件完整性……");
    const probe = JSON.parse(await run(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file], { signal, timeoutMs: 30000 }));
    if (!probe.streams?.some(stream => stream.codec_type === "video") || !probe.streams?.some(stream => stream.codec_type === "audio")) throw new Error("下载文件缺少画面或音轨，未保存为成功结果，请重试。");
    const actualDuration = Number(probe.format?.duration);
    if (!(actualDuration > 0) || (duration > 0 && actualDuration < duration - Math.max(3, duration * 0.01))) throw new Error("视频时长校验失败，文件可能不完整，请重试。");
    if ((await fsp.stat(file)).size > maxBytes) throw new Error("视频超过当前服务器的文件大小或可用空间限制。");
    const result = await publishVideo(file, { outputDir, title, signal });
    onProgress({ received: result.bytes, total: result.bytes });
    onLog(`下载完成：${result.file}`);
    return result;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = { downloadWithYtDlp };
