const { spawnSync } = require("node:child_process");
const { projectDir, getDownloadDir, launchBrowser, openPath } = require("./runtime");

function installDependencies() {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("请安装 Node.js 20 或更新的 LTS 版本：https://nodejs.org/");
  try { require.resolve("playwright-core"); } catch {
    console.log("首次启动，正在安装项目依赖（需要联网）……");
    // npm.cmd is a batch file. Only constant arguments are passed through cmd.
    const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
    const args = process.platform === "win32" ? ["/d", "/c", "npm.cmd install --no-audit --no-fund"] : ["install", "--no-audit", "--no-fund"];
    const result = spawnSync(command, args, { cwd: projectDir, stdio: "inherit", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error("依赖安装失败。请检查网络后重试，或在项目目录执行 npm install。");
  }
}

async function main() {
  installDependencies();
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const { browser, name } = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.goto("data:text/html,<title>download-any check</title>");
      console.log(`浏览器检查通过：${name}`);
      console.log(`项目目录：${projectDir}`);
      console.log(`下载目录：${getDownloadDir()}`);
    } finally { await browser.close(); }
    return;
  }
  if (args[0] === "--cli") { await require("./download").runCli(args.slice(1)); return; }
  let serverMode;
  if (args.includes("--server")) {
    const path = require("node:path");
    const configIndex = args.indexOf("--config");
    const configFile = configIndex >= 0 ? args[configIndex + 1] : path.join(projectDir, ".server-data", "server.json");
    serverMode = await require("./server-config").loadServerConfig(configFile);
    process.env.DOWNLOAD_ANY_TOOLS_DIR = path.join(serverMode.dataDir, "tools");
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(serverMode.dataDir, "browsers");
  }
  const app = await require("./app").startServer({ serverMode });
  console.log(`下载工具已启动：${serverMode?.publicUrl || app.url}`);
  console.log(serverMode ? `服务器临时文件保留 ${serverMode.retentionHours} 小时，结果请保存到你的电脑。` : `视频保存到：${getDownloadDir()}`);
  console.log("使用期间请保留此窗口，按 Ctrl+C 退出。");
  if (!serverMode && !args.includes("--no-open")) {
    try { await openPath(app.url); } catch { console.log(`无法自动打开浏览器，请手动访问：${app.url}`); }
  }
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // Allow active downloads to release their browser, sockets and temporary file.
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    try { await app.close(); process.exitCode = 0; }
    catch (error) { console.error(`退出失败：${error.message}`); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, shutdown);
}

if (require.main === module) main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
module.exports = { installDependencies, main };
