const { extractUrl: extractDouyinUrl } = require("./download_douyin_core");

const platformNames = { douyin: "抖音", bilibili: "B 站" };
function isHost(hostname, domain) { return hostname === domain || hostname.endsWith(`.${domain}`); }

function parseInput(text) {
  const normalized = String(text || "").replace(/\\([.:/?&#=])/g, "$1")
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, "&");
  const match = normalized.match(/https?:\/\/[^\s<>"「」，。！？；（）【】]+/i);
  if (!match) throw new Error("请粘贴抖音或 B 站视频链接，或包含链接的分享文案。");
  let url;
  try { url = new URL(match[0].replace(/[),，。！!？?；;）】]+$/, "")); }
  catch { throw new Error("视频链接格式不正确，请重新复制。"); }
  if (url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("视频链接格式不正确。");
  if (isHost(url.hostname, "douyin.com") || isHost(url.hostname, "iesdouyin.com")) {
    return { platform: "douyin", url: extractDouyinUrl(url.href) };
  }
  if (isHost(url.hostname, "bilibili.com")) {
    const id = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)(?:\/|$)/)?.[1];
    if (!id) throw new Error("请打开 B 站具体视频后复制 BV 或 av 视频地址。");
    const part = url.searchParams.get("p");
    if (part !== null && (!/^[1-9]\d{0,5}$/.test(part))) throw new Error("B 站分 P 编号不正确，请重新复制视频链接。");
    return { platform: "bilibili", url: `https://www.bilibili.com/video/${id}/${part ? `?p=${part}` : ""}` };
  }
  if (url.hostname === "b23.tv" && /^\/[0-9A-Za-z_-]+\/?$/.test(url.pathname)) {
    return { platform: "bilibili", url: `https://b23.tv${url.pathname}` };
  }
  throw new Error("目前支持抖音和 B 站，请粘贴这两个平台的视频链接或分享文案。");
}

module.exports = { parseInput, platformNames };
