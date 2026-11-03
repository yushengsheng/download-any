const { parseInput } = require("./video-input");
const { ensureBilibiliTools } = require("./download-tools");
const { downloadWithYtDlp } = require("./download-ytdlp");

async function resolveVideoUrl(input, signal) {
  let target = parseInput(input);
  if (target.platform !== "bilibili") throw new Error("这不是 B 站视频链接。");
  for (let count = 0; ["b23.tv", "bili2233.cn"].includes(new URL(target.url).hostname); count++) {
    if (count >= 5) throw new Error("B 站短链接跳转次数过多，请使用视频网页地址。");
    const response = await fetch(target.url, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    });
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get("location")) throw new Error("B 站短链接无法解析，请使用视频网页地址。");
    target = parseInput(new URL(response.headers.get("location"), target.url).href);
    if (target.platform !== "bilibili") throw new Error("B 站短链接没有指向 B 站视频。");
  }
  return target.url;
}

async function downloadBilibili(input, options = {}) {
  const url = await resolveVideoUrl(input, options.signal);
  return downloadWithYtDlp(url, { name: "B 站", extraArgs: ["--add-header", "Referer:https://www.bilibili.com/"] },
    { ensureTools: ensureBilibiliTools, ...options });
}

module.exports = { downloadBilibili, resolveVideoUrl };
