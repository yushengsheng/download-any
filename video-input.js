const { extractUrl: extractDouyinUrl } = require("./download_douyin_core");

const platformNames = { douyin: "抖音", bilibili: "B 站", twitter: "推特", youtube: "YouTube", missav: "MissAV" };
function isHost(hostname, domain) { return hostname === domain || hostname.endsWith(`.${domain}`); }

function parseInput(text) {
  const normalized = String(text || "").replace(/\\([.:/?&#=])/g, "$1")
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, "&");
  const match = normalized.match(/https?:\/\/[^\s<>"「」，。！？；（）【】]+/i);
  if (!match) throw new Error("请粘贴支持平台的具体视频链接，或包含链接的分享文案。");
  let url;
  try { url = new URL(match[0].replace(/[),，。！!？?；;）】]+$/, "")); }
  catch { throw new Error("视频链接格式不正确，请重新复制。"); }
  if (url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("视频链接格式不正确。");
  if (isHost(url.hostname, "douyin.com") || isHost(url.hostname, "iesdouyin.com")) {
    return { platform: "douyin", url: extractDouyinUrl(url.href) };
  }
  if (isHost(url.hostname, "bilibili.com")) {
    if (url.hostname === "live.bilibili.com" || /^\/bangumi\/play\//.test(url.pathname)) {
      throw new Error("暂不支持 B 站直播或番剧链接，请粘贴普通投稿视频（BV 或 av）地址。");
    }
    const rawId = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)(?:\/|$)/i)?.[1]
      || (url.searchParams.get("bvid")?.match(/^BV[0-9A-Za-z]{10}$/)?.[0]);
    if (!rawId) throw new Error("请打开 B 站具体视频后复制 BV 或 av 视频地址。");
    const id = /^av/i.test(rawId) ? `av${rawId.slice(2)}` : `BV${rawId.slice(2)}`;
    const part = url.searchParams.get("p");
    if (part !== null && (!/^[1-9]\d{0,5}$/.test(part))) throw new Error("B 站分 P 编号不正确，请重新复制视频链接。");
    return { platform: "bilibili", url: `https://www.bilibili.com/video/${id}/${part ? `?p=${part}` : ""}` };
  }
  if (["b23.tv", "bili2233.cn"].includes(url.hostname) && /^\/[0-9A-Za-z_-]+\/?$/.test(url.pathname)) {
    return { platform: "bilibili", url: `https://${url.hostname}${url.pathname}` };
  }
  if (["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(url.hostname)) {
    const post = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/video\/([1-9]\d{0,2}))?\/?$/);
    if (!post) throw new Error("请粘贴推特具体帖子的 status 链接，或 video.twimg.com 视频直链。");
    return { platform: "twitter", url: `https://x.com/${post[1]}/status/${post[2]}${post[3] ? `/video/${post[3]}` : ""}` };
  }
  if (url.hostname === "video.twimg.com") {
    if (!/^\/(?:amplify_video|ext_tw_video|tweet_video)\/[A-Za-z0-9_./-]+\.mp4$/i.test(url.pathname)) throw new Error("请粘贴 video.twimg.com 的 MP4 视频直链。");
    url.protocol = "https:";
    url.hash = "";
    return { platform: "twitter", url: url.href };
  }
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(url.hostname)) {
    const id = ["youtu.be", "www.youtu.be"].includes(url.hostname) ? url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1]
      : url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("请打开 YouTube 具体视频后复制 watch、youtu.be 或 Shorts 链接，首页和频道地址不能下载。");
    return { platform: "youtube", url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (["missav.ws", "www.missav.ws"].includes(url.hostname)) {
    const slug = url.pathname.match(/^\/(?:[a-z]{2}\/)?([a-z0-9]+(?:[-_][a-z0-9]+)+)\/?$/i)?.[1];
    if (!slug) throw new Error("请打开 MissAV 具体视频播放页后复制地址，首页和分类页不能下载。");
    return { platform: "missav", url: `https://missav.ws/${slug}` };
  }
  throw new Error("目前支持抖音、B 站、推特、YouTube 和 MissAV，请粘贴具体视频链接或分享文案。");
}

module.exports = { parseInput, platformNames };
