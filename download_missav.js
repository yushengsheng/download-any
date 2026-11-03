const { parseInput } = require("./video-input");
const { launchBrowser } = require("./runtime");
const { downloadWithYtDlp } = require("./download-ytdlp");

// Decode string literals and the site's packed source assignments without executing website code in Node.
function stringValue(literal) {
  return literal.slice(1, -1).replace(/\\(u[0-9a-f]{4}|x[0-9a-f]{2}|[\s\S])/gi, (_, value) => {
    if (/^[ux]/i.test(value) && value.length > 1) return String.fromCharCode(parseInt(value.slice(1), 16));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" })[value] ?? value;
  });
}

function extractMissavDetails(scripts, input) {
  const target = parseInput(input);
  if (target.platform !== "missav") throw new Error("这不是 MissAV 视频链接。");
  const slug = new URL(target.url).pathname.slice(1);
  const marker = new RegExp(`\\bdvd_id\\s*:\\s*['"]${slug}['"]`);
  const literal = String.raw`('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")`;
  const packed = new RegExp(String.raw`}\s*\(\s*${literal}\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*${literal}\.split\(\s*['"]\|['"]\s*\)`, "g");
  for (const script of scripts.slice(0, 128)) {
    if (typeof script !== "string" || script.length > 256 * 1024 || !script.includes("video.player") || !marker.test(script)) continue;
    const sources = [script];
    for (const match of [...script.matchAll(packed)].slice(0, 4)) {
      const radix = Number(match[2]);
      const count = Number(match[3]);
      if (radix < 2 || radix > 36 || count > 2048) continue;
      const words = stringValue(match[4]).split("|");
      const dictionary = new Map(words.slice(0, count).map((word, index) => [index.toString(radix), word]));
      sources.push(stringValue(match[1]).replace(/\b[0-9a-z]+\b/g, word => dictionary.get(word) || word));
    }
    for (const source of sources) {
      const assignment = source.match(new RegExp(String.raw`\bsource\s*=\s*${literal}`));
      if (!assignment) continue;
      let url;
      try { url = new URL(stringValue(assignment[1])); } catch { continue; }
      if (url.protocol !== "https:" || url.username || url.password || url.port || !(url.hostname === "surrit.com" || url.hostname.endsWith(".surrit.com"))
        || !/\.(?:m3u8|mp4)$/i.test(url.pathname)) continue;
      return { url: url.href, title: `MissAV_${slug}` };
    }
  }
  throw new Error("未能解析目标 MissAV 视频；页面可能需要验证、登录，或播放格式已变化。");
}

async function resolveMissavVideo(input, { signal, onLog = () => {}, launch = launchBrowser,
  headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY } = {}) {
  const target = parseInput(input);
  if (target.platform !== "missav") throw new Error("这不是 MissAV 视频链接。");
  signal?.throwIfAborted();
  onLog("正在使用独立浏览器解析 MissAV 主播放器……");
  const { browser } = await launch({ signal, onLog, headless });
  const cancel = () => { browser.close().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const page = await browser.newPage();
    await page.route("**/*", route => {
      if (["image", "font", "media"].includes(route.request().resourceType())) return route.abort().catch(() => {});
      return route.continue().catch(() => {});
    });
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("video.player", { timeout: 20000 }).catch(() => {});
    signal?.throwIfAborted();
    let current;
    try { current = parseInput(page.url()); } catch {}
    if (current?.url !== target.url) throw new Error("MissAV 页面没有指向目标视频，请重新复制具体播放页地址。");
    const scripts = await page.evaluate(() => [...document.scripts].slice(0, 128)
      .map(script => script.textContent.slice(0, 256 * 1024)).filter(script => script.includes("video.player")));
    const details = extractMissavDetails(scripts, target.url);
    return { ...details, userAgent: await page.evaluate(() => navigator.userAgent) };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); await browser.close(); }
}

async function downloadMissav(input, options = {}) {
  const target = parseInput(input);
  const details = await resolveMissavVideo(target.url, options);
  return downloadWithYtDlp(details.url, { name: "MissAV", title: details.title,
    extraArgs: ["--referer", target.url, "--user-agent", details.userAgent] }, options);
}

module.exports = { downloadMissav, resolveMissavVideo, extractMissavDetails };
