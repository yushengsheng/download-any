const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { getDownloadDir } = require("./settings");
const { runProcess } = require("./process-runner");
const projectDir = __dirname;

function browserCandidates({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const candidates = [];
  const add = (name, executablePath) => { if (executablePath) candidates.push({ name, executablePath }); };
  add("自定义浏览器", env.BROWSER_PATH && path.resolve(projectDir, env.BROWSER_PATH));
  if (platform === "win32") {
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
      if (!base) continue;
      add("Google Chrome", path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
      add("Microsoft Edge", path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
      add("Chromium", path.join(base, "Chromium", "Application", "chrome.exe"));
    }
  } else if (platform === "darwin") {
    for (const base of ["/Applications", path.join(home, "Applications")]) {
      add("Google Chrome", path.join(base, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"));
      add("Microsoft Edge", path.join(base, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"));
      add("Chromium", path.join(base, "Chromium.app", "Contents", "MacOS", "Chromium"));
    }
  } else {
    for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      const result = spawnSync("which", [command], { encoding: "utf8", windowsHide: true });
      if (result.status === 0) add(command, result.stdout.trim());
    }
  }
  try { add("Playwright Chromium", require("playwright-core").chromium.executablePath()); } catch {}
  return candidates.filter((candidate, index, all) => fs.existsSync(candidate.executablePath)
    && all.findIndex(item => item.executablePath === candidate.executablePath) === index);
}

async function launchBrowser({ signal, onLog = console.log } = {}) {
  const { chromium } = require("playwright-core");
  signal?.throwIfAborted();
  if (!browserCandidates().length) {
    onLog("解析抖音需要浏览器，正在安装 Chromium（需要联网）……");
    const cli = path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
    try {
      await runProcess(process.execPath, [cli, "install", "chromium", "--no-shell"], {
        cwd: projectDir, signal, timeoutMs: 300000, capture: false, onLine: line => onLog(line.slice(0, 1200))
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Chromium 安装失败，请检查网络或安装 Chrome / Edge。${error.message}`);
    }
  }
  signal?.throwIfAborted();
  const errors = [];
  for (const candidate of browserCandidates()) {
    try {
      const browser = await chromium.launch({ executablePath: candidate.executablePath, headless: true, handleSIGINT: false, handleSIGTERM: false });
      return { browser, name: candidate.name };
    } catch (error) { errors.push(`${candidate.name}: ${error.message}`); }
  }
  throw new Error(errors.length
    ? `浏览器启动失败，请用 BROWSER_PATH 指定可用的 Chromium 浏览器。\n${errors.join("\n")}`
    : "未找到 Chrome、Edge 或 Chromium。请安装浏览器，或设置 BROWSER_PATH。");
}

function openPath(target, { directory = false } = {}) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = directory ? "explorer.exe" : "rundll32.exe";
    args = directory ? [target] : ["url.dll,FileProtocolHandler", target];
  } else {
    command = process.platform === "darwin" ? "open" : "xdg-open";
    args = [target];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

module.exports = { projectDir, getDownloadDir, browserCandidates, launchBrowser, openPath };
