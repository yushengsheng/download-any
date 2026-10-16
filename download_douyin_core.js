const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const https = require("https");

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  if (!match) return null;
  let url = match[0];
  return url.replace(/[),，。！!？?]+$/, "");
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, "_").trim().slice(0, 80);
}

async function main() {
  const rawInput = process.argv[2];
  if (!rawInput) {
    console.error("ERROR: 未提供视频链接");
    process.exit(1);
  }

  const targetUrl = extractUrl(rawInput);
  if (!targetUrl) {
    console.error("ERROR: 无法从输入内容中识别出有效的网页链接");
    process.exit(1);
  }

  console.log("正在解析视频链接:", targetUrl);

  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  let directStreamUrl = null;
  let fallbackStreams = [];
  let videoTitle = "";

  page.on("response", async (res) => {
    const url = res.url();
    // 监听官方详情 API，精准获取最高画质（1080P）流地址
    if (url.includes("/aweme/v1/web/aweme/detail/")) {
      try {
        const json = await res.json();
        const aweme = json?.aweme_detail;
        if (aweme) {
          if (aweme.desc && !videoTitle) {
            videoTitle = aweme.desc;
          }
          const bitRates = aweme.video?.bit_rate || [];
          if (bitRates.length > 0) {
            // 按码率从大到小排序，首选 1080P / 最高码率
            bitRates.sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
            const top = bitRates[0];
            const topUrls = top.play_addr?.url_list || [];
            if (topUrls.length > 0 && !directStreamUrl) {
              directStreamUrl = topUrls[0];
              console.log(`已获取最高画质流: ${top.gear_name || "1080p"}, 码率: ${top.bit_rate}`);
            }
          }
        }
      } catch (e) {}
    }

    if (url.includes(".douyinvod.com") && url.includes("/video/tos/")) {
      // 提取 url 中的 br 码率参数
      const brMatch = url.match(/[?&]br=(\d+)/);
      const br = brMatch ? parseInt(brMatch[1], 10) : 0;
      fallbackStreams.push({ url, br });
    }
  });

  try {
    await page.goto(targetUrl, { timeout: 18000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    if (!videoTitle) {
      const pageTitle = await page.title();
      if (pageTitle && !pageTitle.includes("抖音") && pageTitle.length > 2) {
        videoTitle = pageTitle;
      }
    }
  } catch (e) {
    console.log("页面加载等待提示:", e.message);
  }

  await browser.close();

  // 决定最终下载地址
  let bestUrl = directStreamUrl;
  if (!bestUrl && fallbackStreams.length > 0) {
    fallbackStreams.sort((a, b) => b.br - a.br);
    bestUrl = fallbackStreams[0].url;
  }

  if (!bestUrl) {
    console.error("ERROR: 未能解析到高清视频地址，请确认该视频是否为公开作品。");
    process.exit(1);
  }

  const saveDir = "/Users/ys/Downloads/视频下载";
  const safeName = videoTitle ? sanitizeFilename(videoTitle) : `douyin_${Date.now()}`;
  let finalFile = path.join(saveDir, `${safeName}.mp4`);

  console.log("正在保存文件至:", finalFile);

  const file = fs.createWriteStream(finalFile);
  https.get(bestUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Referer": "https://www.douyin.com/"
    }
  }, (resp) => {
    resp.pipe(file);
    file.on("finish", () => {
      file.close();
      console.log("SUCCESS:" + finalFile);
    });
  }).on("error", (err) => {
    console.error("ERROR: 下载写入失败: " + err.message);
    process.exit(1);
  });
}

main().catch(err => {
  console.error("ERROR: " + err.message);
  process.exit(1);
});
