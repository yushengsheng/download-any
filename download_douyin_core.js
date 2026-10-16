const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { randomUUID } = require("node:crypto");
const { getDownloadDir, launchBrowser } = require("./runtime");
const { sanitizeFilename, publishVideo } = require("./media-file");

function extractUrl(text) {
  const normalized = String(text || "")
    .replace(/\\([:/?&#=])/g, "$1")
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, "&");
  const match = normalized.match(/https?:\/\/[^\s<>"「」，。！？；（）【】]+/i);
  if (!match) throw new Error("请粘贴抖音视频链接，或包含链接的分享文案。");
  const url = new URL(match[0].replace(/[),，。！!？?；;）】]+$/, ""));
  if (!["douyin.com", "iesdouyin.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error("目前支持抖音视频，请输入 douyin.com 的视频链接或分享文案。");
  }
  if (url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("视频链接格式不正确。");
  const videoId = getVideoId(url);
  if (videoId) return `https://www.douyin.com/video/${videoId}`;
  if (["v.douyin.com", "vm.iesdouyin.com"].includes(url.hostname) && /^\/[^/]+\/?$/.test(url.pathname)) return url.href;
  throw new Error("该网页链接没有包含视频编号，请打开具体视频后复制地址，或使用视频分享链接。");
}

function getVideoId(value) {
  const url = value instanceof URL ? value : new URL(value);
  for (const key of ["modal_id", "aweme_id", "item_id"]) {
    const id = url.searchParams.get(key);
    if (id !== null) {
      if (!/^\d+$/.test(id)) throw new Error("视频编号格式不正确，请重新复制视频链接。");
      return id;
    }
  }
  return url.pathname.match(/^\/(?:share\/|jingxuan\/)?video\/(\d+)(?:\/|$)/)?.[1] || null;
}

function getResponse(url, headers, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return reject(new Error("视频地址协议不受支持。"));
    const request = (parsed.protocol === "https:" ? https : http).get(parsed, { headers, signal }, response => {
      response.on("error", reject);
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || redirects >= 5) return reject(new Error("视频下载重定向次数过多。"));
        try { resolve(getResponse(new URL(response.headers.location, parsed).href, headers, signal, redirects + 1)); }
        catch (error) { reject(error); }
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`视频下载失败（HTTP ${response.statusCode}），请重新解析链接。`));
      }
      if (/(?:text\/|json|xml|html)/i.test(response.headers["content-type"] || "")) {
        response.resume();
        return reject(new Error("服务器返回的内容不是视频，请重新解析链接。"));
      }
      response.setTimeout(60000, () => response.destroy(new Error("视频下载超时，请重试。")));
      resolve(response);
    });
    request.setTimeout(60000, () => request.destroy(new Error("视频连接超时，请重试。")));
    request.on("error", reject);
  });
}

async function saveVideo(url, { outputDir, title, headers = {}, onProgress = () => {}, signal, timeoutMs = 300000, maxBytes = Infinity }) {
  signal?.throwIfAborted();
  await fsp.mkdir(outputDir, { recursive: true });
  const partial = path.join(outputDir, `.${randomUUID()}.part`);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error("视频下载超时，请重试。")), timeoutMs);
  timer.unref();
  try {
    const response = await getResponse(url, headers, controller.signal);
    const total = Number(response.headers["content-length"] || 0);
    if (total > maxBytes) { response.destroy(); throw new Error("视频超过当前服务器的文件大小或可用空间限制。"); }
    let received = 0;
    let lastUpdate = 0;
    const counter = new Transform({ transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) return callback(new Error("视频超过当前服务器的文件大小或可用空间限制。"));
      try {
        if (Date.now() - lastUpdate > 500) { lastUpdate = Date.now(); onProgress({ received, total }); }
        callback(null, chunk);
      } catch (error) { callback(error); }
    } });
    await pipeline(response, counter, fs.createWriteStream(partial, { flags: "wx" }), { signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!received) throw new Error("下载的视频为空，请重试。");
    if (total && received !== total) throw new Error("视频未下载完整，请重试。");
    const result = await publishVideo(partial, { outputDir, title, signal: controller.signal });
    onProgress({ received, total: total || received });
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    await fsp.rm(partial, { force: true });
  }
}

function addStream(streams, url, br = 0) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
  if (streams.has(url)) streams.get(url).br = Math.max(streams.get(url).br, br);
  else if (streams.size < 64) streams.set(url, { url, br });
}

function getVideoDetails(aweme, videoId) {
  if (!aweme || !videoId || String(aweme.aweme_id) !== videoId) return null;
  const streams = new Map();
  for (const rate of [...(aweme.video?.bit_rate || [])].sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))) {
    for (const address of rate.play_addr?.url_list || []) addStream(streams, address, rate.bit_rate || 0);
  }
  for (const address of aweme.video?.play_addr?.url_list || []) addStream(streams, address);
  return { title: aweme.desc || "", streams: [...streams.values()] };
}

async function downloadVideo(input, { outputDir = getDownloadDir(), onLog = console.log, onProgress, signal, maxBytes } = {}) {
  signal?.throwIfAborted();
  const targetUrl = extractUrl(input);
  let videoId = getVideoId(targetUrl);
  onLog(`正在解析：${targetUrl}`);
  const { browser, name } = await launchBrowser({ signal, onLog });
  let fallbackStreams = [];
  let detailStreams = [];
  const pending = new Set();
  let resolveDetails;
  const detailsReady = new Promise(resolve => { resolveDetails = resolve; });
  let videoTitle = "";
  let userAgent;
  const cancel = () => { browser.close().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    onLog(`使用浏览器：${name}`);
    const context = await browser.newContext();
    const page = await context.newPage();
    userAgent = await page.evaluate(() => navigator.userAgent);
    page.on("framenavigated", frame => {
      if (videoId || frame !== page.mainFrame()) return;
      try { videoId = getVideoId(extractUrl(frame.url())); } catch {}
    });
    page.on("response", response => {
      const url = response.url();
      if (url.includes("/aweme/v1/web/aweme/detail/") && !detailStreams.length && pending.size < 4) {
        const task = (async () => {
          try {
            const details = getVideoDetails((await response.json())?.aweme_detail, videoId);
            if (details?.streams.length) {
              videoTitle = details.title;
              detailStreams = details.streams;
              resolveDetails();
            }
          } catch {}
        })();
        pending.add(task);
        task.finally(() => pending.delete(task));
      }
    });
    try {
      await page.goto(targetUrl, { timeout: 30000, waitUntil: "domcontentloaded" });
    } catch (error) { signal?.throwIfAborted(); onLog(`页面加载提示：${error.message}`); }
    await Promise.race([detailsReady, page.waitForTimeout(5000)]);
    await Promise.race([Promise.allSettled([...pending]), page.waitForTimeout(1500)]);
    signal?.throwIfAborted();
    if (!detailStreams.length) {
      // Use the active player instead of unrelated recommendation/prefetch responses.
      const source = await page.evaluate(() => {
        const videos = [...document.querySelectorAll("video")];
        const video = videos.find(item => !item.paused && item.currentTime > 0) || videos[0];
        return video?.currentSrc || video?.src || "";
      }).catch(() => "");
      if (/^https?:\/\//i.test(source)) fallbackStreams = [{ url: source, br: 0 }];
    }
    if (!videoTitle) videoTitle = (await page.title().catch(() => "")).replace(/\s*[-–|]\s*抖音.*$/, "");
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await browser.close();
  }
  signal?.throwIfAborted();
  const candidates = (detailStreams.length ? detailStreams : fallbackStreams).sort((a, b) => b.br - a.br);
  if (!candidates.length) throw new Error("未能解析到视频。请确认作品公开且链接有效；如页面要求登录或验证，请稍后重试。");
  onLog(`找到 ${candidates.length} 个视频地址，正在保存视频……`);
  let lastError;
  for (const candidate of candidates.slice(0, 3)) {
    try {
      signal?.throwIfAborted();
      const result = await saveVideo(candidate.url, {
        outputDir, title: videoTitle, onProgress, signal, maxBytes,
        headers: { "User-Agent": userAgent, Referer: "https://www.douyin.com/" }
      });
      onLog(`下载完成：${result.file}`);
      return result;
    } catch (error) { signal?.throwIfAborted(); lastError = error; onLog(`该地址下载失败：${error.message}`); }
  }
  throw lastError;
}

async function runCli(args = process.argv.slice(2)) {
  return require("./download").runCli(args);
}

if (require.main === module) runCli().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
module.exports = { extractUrl, getVideoId, getVideoDetails, sanitizeFilename, saveVideo, downloadVideo, runCli };
