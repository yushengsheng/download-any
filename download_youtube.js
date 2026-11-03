const { parseInput } = require("./video-input");
const { downloadWithYtDlp } = require("./download-ytdlp");

function downloadYoutube(input, options = {}) {
  const target = parseInput(input);
  if (target.platform !== "youtube") throw new Error("这不是 YouTube 视频链接。");
  return downloadWithYtDlp(target.url, { name: "YouTube", extraArgs: ["--js-runtimes", `node:${process.execPath}`] }, options);
}

module.exports = { downloadYoutube };
