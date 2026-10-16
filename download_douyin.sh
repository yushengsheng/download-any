#!/usr/bin/env bash
if [ -z "$1" ]; then
  echo "使用方法: ./download_douyin.sh <抖音链接>"
  exit 1
fi

TARGET_URL="$1"
NODE_BIN="/Users/ys/.local/share/pi-node/node-v22.23.2-darwin-arm64/bin/node"
NODE_MODULES="/Users/ys/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"

NODE_PATH="$NODE_MODULES" "$NODE_BIN" -e '
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const https = require("https");

const targetUrl = process.argv[1];

(async () => {
  console.log("正在解析视频地址: " + targetUrl);
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true
  });
  const page = await browser.newPage();
  let candidateUrls = [];

  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes(".douyinvod.com") && url.includes("/video/tos/")) {
      candidateUrls.push(url);
    }
  });

  try {
    await page.goto(targetUrl, { timeout: 15000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
  } catch (e) {}

  await browser.close();

  if (candidateUrls.length === 0) {
    console.error("未能捕获到视频直链，请检查链接是否正确。");
    process.exit(1);
  }

  // 选取最高码率直链
  const bestUrl = candidateUrls[candidateUrls.length - 1];
  console.log("成功捕获高清视频流!");

  const timestamp = Date.now();
  const outFile = path.join(process.cwd(), `douyin_${timestamp}.mp4`);
  console.log("正在下载保存至: " + outFile);

  const file = fs.createWriteStream(outFile);
  https.get(bestUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Referer": "https://www.douyin.com/"
    }
  }, (resp) => {
    resp.pipe(file);
    file.on("finish", () => {
      file.close();
      console.log("下载完成: " + outFile);
    });
  }).on("error", (err) => {
    console.error("下载失败: " + err.message);
  });
})();
' "$TARGET_URL"
