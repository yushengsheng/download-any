const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { projectDir, getDownloadDir } = require("../runtime");
const { extractUrl, getVideoDetails, sanitizeFilename, saveVideo } = require("../download_douyin_core");
const { startServer } = require("../app");
const { readDirectorySettings, getDownloadDir: savedDownloadDir, saveDownloadDir } = require("../settings");

async function temporary(t) {
  const root = path.join(projectDir, "output", "tests");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "适配 test "));
  t.after(async () => {
    const relative = path.relative(root, directory);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function fixture(t) {
  const bytes = Buffer.from("00000018ftypmp42 fixture video bytes");
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/video" }); response.end(); }
    else if (request.url === "/video") { response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length }); response.end(bytes); }
    else if (request.url === "/broken") {
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": 1000 });
      response.write(bytes);
      setTimeout(() => response.destroy(), 10);
    } else if (request.url === "/slow") {
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length * 1000 });
      const timer = setInterval(() => response.write(bytes), 20);
      response.on("close", () => clearInterval(timer));
    } else { response.writeHead(403, { "Content-Type": "text/html" }); response.end("blocked"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, bytes };
}

test("目录与调用时的工作目录无关，支持中文、空格和相对保存位置", () => {
  assert.equal(getDownloadDir("我的视频 test"), path.join(projectDir, "我的视频 test"));
  const result = execFileSync(process.execPath, ["-e", `console.log(require(${JSON.stringify(path.join(projectDir, "runtime.js"))}).getDownloadDir('downloads'))`], {
    cwd: path.parse(projectDir).root, encoding: "utf8"
  });
  assert.equal(result.trim(), path.join(projectDir, "downloads"));
});

test("保存目录默认值、内外部路径记忆、目录迁移和损坏配置恢复", async t => {
  const directory = await temporary(t);
  const project = path.join(directory, "project 中文");
  const moved = path.join(directory, "moved 中文");
  await fs.mkdir(project);
  await fs.mkdir(moved);
  const settingsFile = path.join(project, ".download-any.json");
  assert.equal(savedDownloadDir("", settingsFile), path.join(project, "downloads"));
  await saveDownloadDir(path.join(project, "自定义 目录"), settingsFile);
  assert.equal(readDirectorySettings(settingsFile).downloadDir, "自定义 目录");
  assert.equal(savedDownloadDir("", settingsFile), path.join(project, "自定义 目录"));
  const movedSettings = path.join(moved, ".download-any.json");
  await fs.copyFile(settingsFile, movedSettings);
  assert.equal(savedDownloadDir("", movedSettings), path.join(moved, "自定义 目录"));
  const external = path.join(directory, "external 中文");
  await saveDownloadDir(external, settingsFile);
  assert.equal(savedDownloadDir("", settingsFile), external);
  await fs.writeFile(settingsFile, "broken json");
  assert.match(readDirectorySettings(settingsFile).warning, /无法读取/);
  assert.equal(savedDownloadDir("", settingsFile), path.join(project, "downloads"));
});

test("选择目录后实际保存，取消或无效目录不改设置，重新启动记住选择", async t => {
  const directory = await temporary(t);
  const settingsFile = path.join(directory, ".download-any.json");
  const chosen = path.join(directory, "我的 视频 & '目录'");
  const source = await fixture(t);
  let selected = null;
  const options = { settingsFile, chooseFolder: async () => selected,
    download: (_input, config) => saveVideo(`${source.url}/video`, { ...config, title: "自选目录" }) };
  let app = await startServer(options);
  t.after(() => app.close());
  let state = await (await fetch(`${app.url}/api/state`)).json();
  assert.equal(state.outputDir, path.join(directory, "downloads"));
  const post = (route, body = {}) => fetch(`${app.url}${route}`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-App-Token": state.token
  }, body: JSON.stringify(body) });
  assert.equal((await (await post("/api/choose-folder")).json()).directory, null);
  assert.equal((await (await fetch(`${app.url}/api/state`)).json()).outputDir, state.outputDir);
  await assert.rejects(fs.stat(settingsFile), { code: "ENOENT" });
  selected = chosen;
  assert.equal((await (await post("/api/choose-folder")).json()).directory, chosen);
  assert.equal((await post("/api/directory", { directory: chosen })).status, 200);
  assert.equal(app.outputDir, chosen);
  const saved = await fs.readFile(settingsFile, "utf8");
  const invalid = path.join(directory, "普通文件");
  await fs.writeFile(invalid, "keep");
  assert.equal((await post("/api/directory", { directory: invalid })).status, 400);
  assert.equal(app.outputDir, chosen);
  assert.equal(await fs.readFile(settingsFile, "utf8"), saved);
  await post("/api/jobs", { input: "https://www.douyin.com/video/1" });
  let job;
  for (let index = 0; index < 100; index++) {
    job = (await (await fetch(`${app.url}/api/state`)).json()).jobs[0];
    if (job.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "completed");
  assert.equal(path.dirname(job.result.file), chosen);
  assert.deepEqual(await fs.readFile(job.result.file), source.bytes);
  await app.close();
  app = await startServer(options);
  state = await (await fetch(`${app.url}/api/state`)).json();
  assert.equal(state.outputDir, chosen);
  assert.equal((await post("/api/directory", { directory: state.defaultDir })).status, 200);
  assert.equal(app.outputDir, path.join(directory, "downloads"));
});

test("本地文件选择等待超过普通请求超时后仍能返回结果", { timeout: 45000 }, async t => {
  const outputDir = await temporary(t);
  const chosen = path.join(outputDir, "视频.mp4");
  const app = await startServer({ outputDir, chooseFile: () => new Promise(resolve => setTimeout(() => resolve(chosen), 31000)) });
  t.after(() => app.close());
  const state = await (await fetch(`${app.url}/api/state`)).json();
  const response = await fetch(`${app.url}/api/choose-video`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-App-Token": state.token
  }, body: "{}", signal: AbortSignal.timeout(40000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).file, chosen);
});

test("上次目录不可用时仍能打开界面，修正设置后恢复下载", async t => {
  const directory = await temporary(t);
  const settingsFile = path.join(directory, ".download-any.json");
  const invalid = path.join(directory, "失效目录");
  await fs.writeFile(invalid, "file, not a folder");
  await saveDownloadDir(invalid, settingsFile);
  const app = await startServer({ settingsFile });
  t.after(() => app.close());
  const state = await (await fetch(`${app.url}/api/state`)).json();
  assert.equal(state.outputDir, invalid);
  assert.match(state.directoryError, /不可用/);
  const post = (route, body) => fetch(`${app.url}${route}`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-App-Token": state.token
  }, body: JSON.stringify(body) });
  assert.equal((await post("/api/jobs", { input: "https://www.douyin.com/video/1" })).status, 400);
  assert.equal((await post("/api/directory", { directory: state.defaultDir })).status, 200);
  assert.equal((await (await fetch(`${app.url}/api/state`)).json()).directoryError, null);
});

test("识别分享文案，拒绝其他平台，生成 Windows 可用的文件名", () => {
  assert.equal(extractUrl("复制此链接 https://v.douyin.com/AbCd/，打开抖音"), "https://v.douyin.com/AbCd/");
  assert.equal(extractUrl("https://www.douyin.com/video/123"), "https://www.douyin.com/video/123");
  assert.throws(() => extractUrl("https://douyin.com.example.com/video/1"), /目前支持抖音/);
  assert.throws(() => extractUrl("没有链接"), /请粘贴/);
  assert.equal(sanitizeFilename('CON.txt. '), "_CON.txt");
  assert.equal(sanitizeFilename('风景:你好? /测试\\.'), "风景_你好_ _测试_");
  assert.ok(!/[. ]$/.test(sanitizeFilename("...")));
});

test("用户的分享文案、搜索弹层地址和视频地址自动识别，保留完整视频编号", () => {
  const canonical = "https://www.douyin.com/video/7667476840059096383";
  const web = "https://www.douyin.com/jingxuan/search/%E6%89%8B%E7%BB%98%E8%A7%86%E9%A2%91?aid=0c7cf9f4-fdbe-495e-b57b-6220231b412d&modal_id=7667476840059096383&type=general";
  const share = String.raw`5.87 04/11 b@n.qr UlP:/ :1pm 用codex制作火柴人动画 # 火柴人动画 https\://v.douyin.com/987Y-4zEs7w/ 复制此链接，打开Dou音搜索，直接观看视频！`;
  assert.equal(extractUrl(share), "https://v.douyin.com/987Y-4zEs7w/");
  assert.equal(extractUrl(web), canonical);
  assert.equal(extractUrl(`[点击观看](${web.replaceAll("&", "\\&")})`), canonical);
  assert.equal(extractUrl(web.replaceAll("&", "&amp;")), canonical);
  assert.equal(extractUrl("https://www.iesdouyin.com/share/video/7667476840059096383/?region=CN"), canonical);
  assert.equal(extractUrl(`${canonical}?enter_from=search_result`), canonical);
  assert.equal(extractUrl("https://www.douyin.com/user/123?modal_id=7667476840059096383"), canonical);
  assert.throws(() => extractUrl("https://www.douyin.com/jingxuan/search/test?modal_id=invalid"), /视频编号/);
  assert.throws(() => extractUrl("https://www.douyin.com/jingxuan/search/test?aid=123"), /没有包含视频编号/);
});

test("真实 HTTP 下载支持重定向、自动建目录和同名文件，错误时清除临时文件", async t => {
  const directory = await temporary(t);
  const source = await fixture(t);
  const outputDir = path.join(directory, "新建 下载");
  const first = await saveVideo(`${source.url}/redirect`, { outputDir, title: "测试:视频" });
  const second = await saveVideo(`${source.url}/video`, { outputDir, title: "测试:视频" });
  assert.equal(first.filename, "测试_视频.mp4");
  assert.equal(second.filename, "测试_视频 (1).mp4");
  assert.deepEqual(await fs.readFile(first.file), source.bytes);
  await assert.rejects(saveVideo(`${source.url}/forbidden`, { outputDir, title: "错误" }), /HTTP 403/);
  await assert.rejects(saveVideo(`${source.url}/broken`, { outputDir, title: "错误" }));
  assert.deepEqual((await fs.readdir(outputDir)).sort(), ["测试_视频 (1).mp4", "测试_视频.mp4"].sort());
});

test("持续缓慢的响应也有总超时，取消和超时后清理临时文件", async t => {
  const outputDir = await temporary(t);
  const source = await fixture(t);
  await assert.rejects(saveVideo(`${source.url}/slow`, { outputDir, title: "超时", timeoutMs: 100 }), /下载超时/);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("测试取消")), 100);
  try {
    await assert.rejects(saveVideo(`${source.url}/slow`, { outputDir, title: "取消", signal: controller.signal }), /测试取消/);
  } finally { clearTimeout(timer); }
  assert.deepEqual(await fs.readdir(outputDir), []);
});

test("只接受目标作品的详情，候选地址去重、有上限且保留较高码率", () => {
  const aweme = { aweme_id: "7667476840059096383", desc: "目标作品", video: {
    bit_rate: [
      { bit_rate: 100, play_addr: { url_list: ["https://example.com/same", "https://example.com/low"] } },
      { bit_rate: 900, play_addr: { url_list: ["https://example.com/same", "https://example.com/high"] } }
    ]
  } };
  assert.equal(getVideoDetails(aweme, "7667476840059096384"), null);
  const details = getVideoDetails(aweme, aweme.aweme_id);
  assert.equal(details.title, "目标作品");
  assert.equal(details.streams.length, 3);
  assert.deepEqual(details.streams[0], { url: "https://example.com/same", br: 900 });
  aweme.video.bit_rate[1].play_addr.url_list = Array.from({ length: 200 }, (_, index) => `https://example.com/${index}`);
  assert.equal(getVideoDetails(aweme, aweme.aweme_id).streams.length, 64);
});

test("关闭服务会取消正在下载的任务并释放连接", async t => {
  const outputDir = await temporary(t);
  let cancelled = false;
  const app = await startServer({ outputDir, download: (_input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
  }) });
  t.after(() => app.close());
  const state = await (await fetch(`${app.url}/api/state`)).json();
  const options = { method: "POST", headers: { "Content-Type": "application/json", "X-App-Token": state.token }, body: JSON.stringify({ input: "https://www.douyin.com/video/1" }) };
  const statuses = await Promise.all([fetch(`${app.url}/api/jobs`, options), fetch(`${app.url}/api/jobs`, options)]);
  assert.deepEqual(statuses.map(item => item.status).sort(), [202, 409]);
  const change = await fetch(`${app.url}/api/directory`, { ...options, body: JSON.stringify({ directory: outputDir }) });
  assert.equal(change.status, 409);
  await app.close();
  assert.equal(cancelled, true);
  assert.equal(app.server.listening, false);
});

test("本地界面的任务接口完成实际保存、文件下载和失败提示", async t => {
  const directory = await temporary(t);
  const source = await fixture(t);
  let folderOpened;
  const app = await startServer({
    outputDir: directory,
    openDirectory: async target => { folderOpened = target; },
    download: async (input, options) => {
      options.onLog("正在测试本地保存");
      if (input.endsWith("/0")) throw new Error("作品不可访问");
      return saveVideo(`${source.url}/video`, { ...options, title: "界面测试" });
    }
  });
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  assert.equal(app.server.address().address, "127.0.0.1");
  assert.match(await (await fetch(app.url)).text(), /视频即刻保存/);
  const state = await (await fetch(`${app.url}/api/state`)).json();
  const headers = { "Content-Type": "application/json", "X-App-Token": state.token };
  const post = body => fetch(`${app.url}/api/jobs`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await fetch(`${app.url}/api/jobs`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(`${app.url}/api/jobs`, { method: "POST", headers: { ...headers, Origin: "https://example.com" }, body: "{}" })).status, 403);
  assert.equal((await post({ input: "错误链接" })).status, 400);
  assert.equal((await post({ input: "https://www.douyin.com/jingxuan/search/test?modal_id=1&type=general" })).status, 202);
  let job;
  for (let index = 0; index < 100; index++) {
    job = (await (await fetch(`${app.url}/api/state`)).json()).jobs[0];
    if (job.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "completed");
  assert.equal(job.url, "https://www.douyin.com/video/1");
  const file = await fetch(`${app.url}/api/file?id=${job.id}`);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), source.bytes);
  assert.equal((await fetch(`${app.url}/api/file?id=unknown`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/open-folder`, { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal(folderOpened, directory);
  await post({ input: "https://www.douyin.com/video/0" });
  for (let index = 0; index < 100; index++) {
    job = (await (await fetch(`${app.url}/api/state`)).json()).jobs[0];
    if (job.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(job.status, "failed");
  assert.equal(job.error, "作品不可访问");
});

test("项目复制到另一中文空格目录后，可从外部目录通过启动入口运行", { timeout: 120000 }, async t => {
  const directory = await temporary(t);
  for (const file of ["start.js", "runtime.js", "settings.js", "folder-picker.js", "app.js", "server-auth.js", "server-config.js", "server-cache.js", "download.js", "video-input.js", "download_bilibili.js", "download-tools.js", "tools-manifest.json", "process-runner.js", "media-file.js", "media-toolbox.js", "download_douyin_core.js", "双击运行下载.cmd", "package.json"]) {
    await fs.copyFile(path.join(projectDir, file), path.join(directory, file));
  }
  await fs.cp(path.join(projectDir, "node_modules"), path.join(directory, "node_modules"), { recursive: true });
  await fs.cp(path.join(projectDir, "web"), path.join(directory, "web"), { recursive: true });
  const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : process.execPath;
  const args = process.platform === "win32" ? ["/d", "/s", "/c", `""${path.join(directory, "双击运行下载.cmd")}" --check"`] : [path.join(directory, "start.js"), "--check"];
  const result = execFileSync(command, args, { cwd: path.parse(projectDir).root, encoding: "utf8", timeout: 60000, windowsHide: true, windowsVerbatimArguments: process.platform === "win32" });
  assert.match(result, /浏览器检查通过/);
  assert.ok(result.includes(directory));
  assert.ok(result.includes(path.join(directory, "downloads")));
  const script = `(async () => {
    const app = await require(${JSON.stringify(path.join(directory, "app.js"))}).startServer();
    try {
      const response = await fetch(app.url);
      if (!response.ok || !(await response.text()).includes('视频即刻保存')) throw new Error('界面加载失败');
      const state = await (await fetch(app.url + '/api/state')).json();
      console.log(state.outputDir);
    } finally { app.server.close(); app.server.closeAllConnections(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const movedOutput = execFileSync(process.execPath, ["-e", script], { cwd: path.parse(projectDir).root, encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(movedOutput.trim(), path.join(directory, "downloads"));
});
