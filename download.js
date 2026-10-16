const { parseInput, platformNames } = require("./video-input");
const { downloadVideo: downloadDouyin } = require("./download_douyin_core");
const { downloadBilibili } = require("./download_bilibili");
const { getDownloadDir } = require("./runtime");

async function downloadVideo(input, options = {}) {
  const target = parseInput(input);
  (options.onLog || console.log)(`已识别平台：${platformNames[target.platform]}`);
  return (target.platform === "bilibili" ? downloadBilibili : downloadDouyin)(target.url, options);
}

async function runCli(args = process.argv.slice(2)) {
  let outputDir;
  const input = [];
  for (let index = 0; index < args.length; index++) {
    if (["--output", "-o"].includes(args[index])) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--output 后需要提供保存目录。");
      outputDir = getDownloadDir(args[++index]);
    } else if (["--help", "-h"].includes(args[index])) {
      console.log('用法：npm run download -- "抖音 / B 站链接或分享文案" [--output 保存目录]');
      return;
    } else input.push(args[index]);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("下载已取消。"));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, cancel);
  try {
    const result = await downloadVideo(input.join(" "), { outputDir, signal: controller.signal });
    console.log(`SUCCESS:${result.file}`);
  } finally { for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, cancel); }
}

if (require.main === module) runCli().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
module.exports = { downloadVideo, runCli };
