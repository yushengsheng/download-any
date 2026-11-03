const fsp = require("node:fs/promises");
const path = require("node:path");
const { parseInput } = require("./video-input");
const { getDownloadDir } = require("./runtime");
const { ensureDownloadTools, ensureMediaTools } = require("./download-tools");
const { runProcess } = require("./process-runner");
const { saveVideo } = require("./download_douyin_core");
const { publishVideo } = require("./media-file");

function twitterMediaUrl(value) {
  try {
    const target = parseInput(value);
    return target.platform === "twitter" && new URL(target.url).hostname === "video.twimg.com" ? target.url : null;
  } catch { return null; }
}

function mediaCandidates(formats, fallback) {
  const candidates = formats.slice(0, 64).map(format => ({ url: twitterMediaUrl(format.url), bitrate: Number(format.bitrate || format.tbr) || 0 }))
    .filter(format => format.url).sort((a, b) => b.bitrate - a.bitrate).map(format => format.url);
  if (twitterMediaUrl(fallback)) candidates.push(twitterMediaUrl(fallback));
  return [...new Set(candidates)].slice(0, 3);
}

async function fallbackDetails(id, index, { signal }) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(20000);
      const response = await fetch(`https://api.fxtwitter.com/status/${id}`, {
        redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Accept: "application/json" }
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`推特备用解析失败（HTTP ${response.status}）。`); }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error("推特解析数据过大，已停止处理。");
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (data.code !== 200 || data.tweet?.id !== id) throw new Error("未能获取目标推特帖子的公开视频信息。");
      const media = data.tweet.media?.all || data.tweet.media?.videos || [];
      const selected = index ? media[Number(index) - 1] : media.find(item => ["video", "gif"].includes(item.type));
      if (!selected || !["video", "gif"].includes(selected.type)) throw new Error("该推特帖子中没有对应的视频。");
      const candidates = mediaCandidates(selected.formats || selected.variants || [], selected.url);
      if (!candidates.length) throw new Error("未能获取目标推特视频的 MP4 地址。");
      return { title: `推特_${id}${index ? `_${index}` : ""}`, duration: Number(selected.duration), candidates };
    } catch (error) { signal?.throwIfAborted(); lastError = error; }
  }
  throw lastError;
}

async function resolveTwitterVideo(url, { tools, run = runProcess, signal, onLog = () => {} }) {
  const parsed = new URL(url);
  if (parsed.hostname === "video.twimg.com") {
    return { title: `推特_${path.basename(parsed.pathname, ".mp4")}`, candidates: [url] };
  }
  const [, id, index] = parsed.pathname.match(/\/status\/(\d+)(?:\/video\/(\d+))?/);
  try {
    const raw = await run(tools.ytDlp, [
      "--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-playlist", "--playlist-items", "1",
      "--socket-timeout", "15", "--retries", "2", "--extractor-retries", "1",
      "--format", "b[ext=mp4]/bv[ext=mp4]", "--skip-download", "--dump-single-json", url
    ], { signal, timeoutMs: 60000, maxOutput: 2 * 1024 * 1024 });
    const data = JSON.parse(raw);
    const media = data.entries ? data.entries[0] : data;
    if (!media || media.display_id !== id) throw new Error("推特解析结果与目标帖子不一致。");
    const candidates = mediaCandidates(media.formats || [], media.url);
    if (!candidates.length) throw new Error("未能获取目标推特视频的 MP4 地址。");
    return { title: media.title || `推特_${id}`, duration: Number(media.duration), candidates };
  } catch {
    signal?.throwIfAborted();
    onLog("未能通过官方接口解析视频，正在使用 FxTwitter 备用解析……");
    return fallbackDetails(id, index, { signal });
  }
}

async function downloadTwitter(input, { outputDir = getDownloadDir(), onLog = console.log, onProgress, signal,
  ensureTools, run = runProcess, save = saveVideo, timeoutMs = 300000, maxBytes = 20 * 1024 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  const target = parseInput(input);
  if (target.platform !== "twitter") throw new Error("这不是推特视频链接。");
  const direct = new URL(target.url).hostname === "video.twimg.com";
  const tools = await (ensureTools || (direct ? ensureMediaTools : ensureDownloadTools))({ signal, onLog });
  onLog(`正在解析推特视频：${target.url}`);
  const details = await resolveTwitterVideo(target.url, { tools, run, signal, onLog });
  signal?.throwIfAborted();
  await fsp.mkdir(outputDir, { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(outputDir, ".download-any-"));
  let lastError;
  try {
    for (const candidate of details.candidates) {
      let downloaded;
      try {
        signal?.throwIfAborted();
        downloaded = await save(candidate, { outputDir: scratch, title: "media", signal, onProgress, timeoutMs, maxBytes,
          headers: { Referer: "https://x.com/" } });
        onLog("正在检查推特视频完整性……");
        const probe = JSON.parse(await run(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", downloaded.file], { signal, timeoutMs: 30000 }));
        if (!probe.streams?.some(stream => stream.codec_type === "video")) throw new Error("下载文件缺少视频画面，未保存为成功结果。");
        const duration = Number(probe.format?.duration);
        if (!(duration > 0) || (details.duration > 0 && duration < details.duration - Math.max(3, details.duration * 0.01))) throw new Error("视频时长校验失败，文件可能不完整，请重试。");
        const result = await publishVideo(downloaded.file, { outputDir, title: details.title, signal });
        onLog(`下载完成：${result.file}`);
        return result;
      } catch (error) {
        signal?.throwIfAborted(); lastError = error;
        onLog(`该地址下载失败：${error.message}`);
      } finally { if (downloaded) await fsp.rm(downloaded.file, { force: true }); }
    }
    throw lastError;
  } finally { await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

module.exports = { downloadTwitter, resolveTwitterVideo };
