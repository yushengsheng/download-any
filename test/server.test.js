const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { hashPassword, createAuth } = require("../server-auth");
const { loadServerConfig } = require("../server-config");
const { ServerCache } = require("../server-cache");
const { startServer } = require("../app");
const { saveVideo } = require("../download_douyin_core");
const { splitMedia } = require("../media-toolbox");
const { findExecutable } = require("../download-tools");
const { runProcess } = require("../process-runner");
const { projectDir } = require("../runtime");
const password = "Only-For-Tests-2026!";
const credentials = hashPassword(password);

async function temporary(t) {
  const root = path.join(projectDir, "output", "tests");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "服务器 中文 test "));
  t.after(async () => {
    const relative = path.relative(root, directory);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return directory;
}
async function serverOptions(t, overrides = {}) {
  const dataDir = await temporary(t);
  return { dataDir, cacheDir: path.join(dataDir, "cache"), publicUrl: "http://203.0.113.1:8686", bind: "127.0.0.1", port: 0,
    credentials: await credentials, retentionMs: 7200000, maxFileBytes: 8 * 1024 * 1024, maxCacheBytes: 100 * 1024 * 1024, ...overrides };
}
async function login(app) {
  const response = await fetch(`${app.url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const state = await (await fetch(`${app.url}/api/state`, { headers: { Cookie: cookie } })).json();
  const headers = { Cookie: cookie, "Content-Type": "application/json", "X-App-Token": state.token };
  return { cookie, headers, post: (route, body = {}) => fetch(`${app.url}${route}`, { method: "POST", headers, body: JSON.stringify(body) }) };
}
async function waitJob(app, cookie) {
  let job;
  for (let count = 0; count < 200; count++) {
    job = (await (await fetch(`${app.url}/api/state`, { headers: { Cookie: cookie } })).json()).jobs[0];
    if (job && job.status !== "running") return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`任务未结束：${JSON.stringify(job)}`);
}

test("密码使用 scrypt 保存，会话可过期和退出，错误尝试受到限制", async () => {
  const value = await credentials;
  assert.ok(!JSON.stringify(value).includes(password));
  await assert.rejects(hashPassword("short"), /12/);
  let now = 1000;
  const auth = createAuth(value, { secure: true, now: () => now, lifetimeMs: 1000, maxAttempts: 2 });
  assert.equal((await auth.login("wrong", "client")).status, 401);
  assert.equal((await auth.login("wrong", "client")).status, 401);
  assert.equal((await auth.login(password, "client")).status, 429);
  const result = await auth.login(password, "second");
  assert.match(result.cookie, /HttpOnly; SameSite=Strict/);
  assert.match(result.cookie, /Secure/);
  assert.ok(auth.getSession(result.cookie));
  now += 1001;
  assert.equal(auth.getSession(result.cookie), undefined);
  const next = await auth.login(password, "second");
  auth.logout(next.cookie);
  assert.equal(auth.getSession(next.cookie), undefined);
  assert.equal(auth.getSession("download_any_session=malformed"), undefined);
});

test("服务器配置记住密码哈希和参数，可从其他目录启动，重复配置不会重置密码", async t => {
  const directory = await temporary(t);
  const configFile = path.join(directory, "data", "server.json");
  const args = [path.join(projectDir, "server-config.js"), "--config", configFile, "--password-stdin"];
  const output = execFileSync(process.execPath, args, { input: password, encoding: "utf8", cwd: path.parse(projectDir).root });
  assert.ok(!output.includes(password));
  const first = await loadServerConfig(configFile);
  assert.equal(first.dataDir, path.dirname(configFile));
  execFileSync(process.execPath, [path.join(projectDir, "server-config.js"), "--config", configFile], { encoding: "utf8" });
  const second = await loadServerConfig(configFile);
  assert.deepEqual(second.credentials, first.credentials);
  assert.equal(second.port, 8686);
  assert.equal(second.retentionMs, 7200000);
  assert.ok(!(await fs.readFile(configFile, "utf8")).includes(password));
});

test("首次部署必须自定义密码；明确填写新密码时更新已有配置，输入错误保护原设置", async t => {
  const directory = await temporary(t);
  const file = path.join(directory, "自定义部署", "server.json");
  const script = path.join(projectDir, "server-config.js");
  const cleanEnv = { ...process.env };
  for (const key of ["DOWNLOAD_ANY_PASSWORD", "DOWNLOAD_ANY_PORT", "DOWNLOAD_ANY_PUBLIC_URL", "DOWNLOAD_ANY_BIND"]) delete cleanEnv[key];
  const execute = (args, options = {}) => execFileSync(process.execPath, [script, "--config", file, ...args], { encoding: "utf8", env: cleanEnv, stdio: ["pipe", "pipe", "pipe"], ...options });
  assert.throws(() => execute([]), error => error.stderr.includes("自定义访问密码"));
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  assert.throws(() => execute(["--password-stdin"], { input: "" }), error => error.stderr.includes("12"));
  const customPassword = "My Video!$`\"'密码2026";
  const firstOutput = execute(["--password-stdin"], { input: customPassword, env: { ...cleanEnv, DOWNLOAD_ANY_PORT: "8877", DOWNLOAD_ANY_PUBLIC_URL: "http://203.0.113.10:8877" } });
  assert.ok(!firstOutput.includes(customPassword));
  let config = await loadServerConfig(file);
  assert.equal(config.port, 8877);
  assert.equal(config.publicUrl, "http://203.0.113.10:8877");
  assert.equal((await createAuth(config.credentials).login(customPassword, "test")).status, 200);
  const replacement = "MyOtherCustomPass2026!";
  execute(["--password-stdin"], { input: replacement, env: { ...cleanEnv, DOWNLOAD_ANY_PORT: "9988", DOWNLOAD_ANY_PUBLIC_URL: "http://203.0.113.11:9988" } });
  config = await loadServerConfig(file);
  assert.equal(config.port, 9988);
  assert.equal(config.publicUrl, "http://203.0.113.11:9988");
  const auth = createAuth(config.credentials);
  assert.equal((await auth.login(replacement, "test")).status, 200);
  assert.equal((await auth.login(customPassword, "test")).status, 401);
  const saved = await fs.readFile(file, "utf8");
  assert.throws(() => execute(["--password-stdin"], { input: "short" }), error => error.stderr.includes("12"));
  assert.throws(() => execute(["--reset-password"]), error => error.stderr.includes("自定义访问密码"));
  assert.equal(await fs.readFile(file, "utf8"), saved);
  const preserved = config.credentials;
  execute([]);
  assert.deepEqual((await loadServerConfig(file)).credentials, preserved);
  assert.ok(!saved.includes(customPassword) && !saved.includes(replacement));
});

const bash = process.platform === "win32"
  ? [process.env.GIT_BASH_PATH, process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Git", "bin", "bash.exe")].filter(Boolean).find(file => require("node:fs").existsSync(file))
  : "/bin/bash";
test("部署脚本识别 IP、端口、密码三个参数，提前拒绝错误输入且不回显密码", { skip: !bash }, () => {
  const script = path.join(projectDir, "deploy-linux.sh").replaceAll("\\", "/");
  const call = args => {
    try { return { status: 0, output: execFileSync(bash, [script, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }) }; }
    catch (error) { return { status: error.status, output: String(error.stdout) + String(error.stderr) }; }
  };
  const help = call(["--help"]);
  assert.equal(help.status, 0); assert.match(help.output, /公网IP 端口 '自定义密码'/);
  const validPassword = "Custom Password!$`2026";
  for (const [args, expected] of [
    [["203.0.113.10", "8686"], /共三个参数/],
    [["https://203.0.113.10", "8686", validPassword], /IP 格式不正确/],
    [["999.0.0.1", "8686", validPassword], /IPv4 地址/],
    [["203.0.113.10", "0", validPassword], /端口必须/],
    [["203.0.113.10", "65536", validPassword], /端口必须/],
    [["203.0.113.10", "abc", validPassword], /端口必须/],
    [["203.0.113.10", "8686", "short"], /至少 12/],
    [["203.0.113.10", "8686", ""], /至少 12/],
    [["203.0.113.10", "8686", "x".repeat(513)], /最多 512/]
  ]) {
    const result = call(args);
    assert.notEqual(result.status, 0); assert.match(result.output, expected);
    assert.ok(!result.output.includes(validPassword));
  }
  if (process.platform === "win32") {
    for (const address of ["203.0.113.10", "0.0.0.0", "2001:db8::1", "[2001:db8::1]"]) {
      const result = call([address, "8686", validPassword]);
      assert.match(result.output, /需要在 Linux 服务器运行/);
      assert.ok(!result.output.includes(validPassword));
    }
  }
});

test("服务器模式保护页面、状态和文件，校验来源，拒绝本地磁盘操作并支持退出", async t => {
  const mode = await serverOptions(t);
  const app = await startServer({ serverMode: mode });
  t.after(() => app.close());
  for (const route of ["/api/state", "/api/file?id=anything"]) assert.equal((await fetch(`${app.url}${route}`)).status, 401);
  const page = await fetch(app.url, { redirect: "manual" });
  assert.equal(page.status, 303); assert.match(page.headers.get("location"), /^\/login/);
  assert.match(await (await fetch(`${app.url}/login`)).text(), /访问密码/);
  assert.equal((await fetch(`${app.url}/app.js`, { redirect: "manual" })).status, 303);
  assert.equal((await fetch(`${app.url}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ password }) })).status, 403);
  const session = await login(app);
  const badHost = await new Promise((resolve, reject) => {
    const request = http.get(`${app.url}/api/state`, { headers: { Cookie: session.cookie, Host: "evil.example" } }, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(`${app.url}/api/jobs`, { method: "POST", headers: { Cookie: session.cookie, "Content-Type": "application/json" }, body: "{}" })).status, 403);
  for (const route of ["/api/open-folder", "/api/choose-folder", "/api/choose-video", "/api/directory", "/api/toolbox/split"]) assert.equal((await session.post(route, { file: "secret.mp4" })).status, 403);
  assert.equal((await session.post("/api/logout")).status, 200);
  assert.equal((await fetch(`${app.url}/api/state`, { headers: { Cookie: session.cookie } })).status, 401);
  assert.equal((await fetch(`${app.url}/healthz`)).status, 204);
});

test("远程下载保存为独立临时结果，支持鉴权、断点读取、过期删除，源文件不受影响", async t => {
  let now = 10000;
  const mode = await serverOptions(t, { now: () => now, retentionMs: 1000 });
  const app = await startServer({ serverMode: mode, download: async (_input, options) => {
    await fs.mkdir(options.outputDir, { recursive: true });
    const file = path.join(options.outputDir, "视频.mp4");
    await fs.writeFile(file, "1234567890");
    return { file, filename: "视频.mp4", bytes: 10 };
  } });
  t.after(() => app.close());
  const session = await login(app);
  assert.equal((await session.post("/api/jobs", { input: "https://www.douyin.com/video/123" })).status, 202);
  const job = await waitJob(app, session.cookie);
  assert.equal(job.status, "completed", job.error);
  assert.ok(job.result.file.startsWith(mode.cacheDir));
  const partial = await fetch(`${app.url}/api/file?id=${job.id}`, { headers: { Cookie: session.cookie, Range: "bytes=2-5" } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), "3456");
  assert.equal((await fetch(`${app.url}/api/file?id=${job.id}`, { headers: { Cookie: session.cookie, Range: "bytes=99-100" } })).status, 416);
  assert.equal((await fetch(`${app.url}/api/file?id=${job.id}`)).status, 401);
  now += 2000; await app.sweep();
  await assert.rejects(fs.stat(job.result.file), { code: "ENOENT" });
  assert.equal((await fetch(`${app.url}/api/file?id=${job.id}`, { headers: { Cookie: session.cookie } })).status, 404);
});

test("缓存锁防止多实例互删，下载中的文件不会被过期清理，重启仅清理自己的临时任务", async t => {
  let now = 0;
  const mode = await serverOptions(t, { now: () => now, retentionMs: 100 });
  const cache = new ServerCache(mode);
  await cache.init();
  t.after(() => cache.close());
  await assert.rejects(new ServerCache(mode).init(), /另一实例/);
  const untouched = path.join(mode.cacheDir, "用户文件.txt");
  await fs.writeFile(untouched, "preserve");
  const id = randomUUID(); const { directory } = await cache.create(id);
  await fs.writeFile(path.join(directory, "video.mp4"), "media");
  await cache.finish(id, 5);
  const release = cache.pin(id); assert.ok(release);
  now = 200; assert.deepEqual(await cache.sweep(), []);
  release(); assert.deepEqual(await cache.sweep(), [id]);
  const orphan = await cache.create(randomUUID());
  await fs.writeFile(path.join(orphan.directory, "source.mp4"), "orphan");
  await cache.close();
  const restarted = new ServerCache(mode); await restarted.init();
  t.after(() => restarted.close());
  await assert.rejects(fs.stat(orphan.directory), { code: "ENOENT" });
  assert.equal(await fs.readFile(untouched, "utf8"), "preserve");
});

test("缓存配额限制当前任务，不会通过删除未过期结果来腾空间", async t => {
  const mode = await serverOptions(t, { maxFileBytes: 8 * 1024 * 1024, maxCacheBytes: 12 * 1024 * 1024 });
  const cache = new ServerCache(mode); await cache.init(); t.after(() => cache.close());
  const firstId = randomUUID();
  const first = await cache.create(firstId);
  assert.equal(first.maxBytes, 4 * 1024 * 1024);
  await fs.writeFile(path.join(first.directory, "keep.mp4"), "keep");
  await cache.finish(firstId, 11 * 1024 * 1024);
  await assert.rejects(cache.create(randomUUID()), /空间不足/);
  assert.equal(await fs.readFile(path.join(first.directory, "keep.mp4"), "utf8"), "keep");
  await cache.remove(firstId);
  assert.ok((await cache.create(randomUUID())).maxBytes > 0);
});

test("服务器缓存满后拒绝新任务，旧结果仍能下载和清除，清除后可继续处理", async t => {
  const mode = await serverOptions(t);
  const app = await startServer({ serverMode: mode, download: async (_input, options) => {
    await fs.mkdir(options.outputDir, { recursive: true });
    const file = path.join(options.outputDir, "video.mp4");
    await fs.writeFile(file, "keep");
    return { file, filename: "video.mp4", bytes: 4 };
  } });
  t.after(() => app.close());
  const session = await login(app);
  let first;
  for (let index = 0; index < 20; index++) {
    assert.equal((await session.post("/api/jobs", { input: "https://www.douyin.com/video/123" })).status, 202);
    const job = await waitJob(app, session.cookie);
    assert.equal(job.status, "completed", job.error);
    first ||= job;
  }
  // Repeated failures must not evict successful results or grow history without a bound.
  for (let index = 0; index < 22; index++) {
    await session.post("/api/jobs", { input: "https://www.douyin.com/video/123" });
    const job = await waitJob(app, session.cookie);
    assert.equal(job.status, "failed");
    assert.match(job.error, /20 个临时任务/);
  }
  const state = await (await fetch(`${app.url}/api/state`, { headers: { Cookie: session.cookie } })).json();
  assert.ok(state.jobs.length <= 40);
  assert.equal(state.jobs.filter(job => job.status === "completed").length, 20);
  const file = await fetch(`${app.url}/api/file?id=${first.id}`, { headers: { Cookie: session.cookie } });
  assert.equal(file.status, 200); assert.equal(await file.text(), "keep");
  assert.equal((await session.post("/api/clear-job", { id: first.id })).status, 200);
  await session.post("/api/jobs", { input: "https://www.douyin.com/video/123" });
  assert.equal((await waitJob(app, session.cookie)).status, "completed");
});

const mediaTools = { ffmpeg: findExecutable("ffmpeg", process.env.FFMPEG_PATH), ffprobe: findExecutable("ffprobe", process.env.FFPROBE_PATH) };
test("远程上传实际分离音画，输入自动删除，结果可分别下载并手动清理", { skip: !mediaTools.ffmpeg || !mediaTools.ffprobe }, async t => {
  const mode = await serverOptions(t);
  const source = path.join(mode.dataDir, "原始.mp4");
  await runProcess(mediaTools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=10", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "1", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", source]);
  const bytes = await fs.readFile(source);
  const app = await startServer({ serverMode: mode, split: (input, options) => splitMedia(input, { ...options, ensureTools: async () => mediaTools }) });
  t.after(() => app.close());
  const session = await login(app);
  const upload = (name, data = bytes) => fetch(`${app.url}/api/toolbox/upload`, { method: "POST", headers: { ...session.headers, "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) }, body: data });
  const response = await upload("我的 视频.mp4");
  assert.equal(response.status, 202, await response.text());
  const job = await waitJob(app, session.cookie);
  assert.equal(job.status, "completed", job.error);
  assert.deepEqual(job.result.files.map(file => file.kind), ["video", "audio"]);
  await assert.rejects(fs.stat(path.join(mode.cacheDir, job.id, "input")), { code: "ENOENT" });
  for (const file of job.result.files) {
    const result = await fetch(`${app.url}/api/file?id=${job.id}&part=${file.kind}`, { headers: { Cookie: session.cookie } });
    assert.equal(result.status, 200);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), await fs.readFile(file.file));
  }
  assert.equal((await session.post("/api/clear-job", { id: job.id })).status, 200);
  await assert.rejects(fs.stat(path.join(mode.cacheDir, job.id)), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(source), bytes);
  const playlist = Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n");
  assert.equal((await upload("伪装视频.mp4", playlist)).status, 202);
  const invalid = await waitJob(app, session.cookie);
  assert.equal(invalid.status, "failed"); assert.match(invalid.error, /无法读取/);
  assert.equal((await upload("../逃逸.mp4")).status, 400);
  await waitJob(app, session.cookie);
});

test("上传中断会取消任务并清理，过大文件在处理前拒绝", async t => {
  const mode = await serverOptions(t, { maxFileBytes: 1024 * 1024 });
  const app = await startServer({ serverMode: mode }); t.after(() => app.close());
  const session = await login(app);
  const oversized = await fetch(`${app.url}/api/toolbox/upload`, { method: "POST", headers: { ...session.headers, "Content-Type": "application/octet-stream", "X-File-Name": "large.mp4" }, body: Buffer.alloc(1024 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  const request = http.request(`${app.url}/api/toolbox/upload`, { method: "POST", headers: {
    ...session.headers, "Content-Type": "application/octet-stream", "X-File-Name": "cancel.mp4", "X-File-Size": "1000000"
  } });
  request.on("error", () => {}); request.write(Buffer.alloc(100));
  await new Promise(resolve => setTimeout(resolve, 80)); request.destroy();
  const job = await waitJob(app, session.cookie);
  assert.equal(job.status, "cancelled", job.error);
  await assert.rejects(fs.stat(path.join(mode.cacheDir, job.id)), { code: "ENOENT" });
});

test("没有 Content-Length 的下载仍然执行大小上限并清理部分文件", async t => {
  const directory = await temporary(t);
  const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "video/mp4" }); response.end(Buffer.alloc(3000)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await assert.rejects(saveVideo(`http://127.0.0.1:${server.address().port}`, { outputDir: directory, title: "超大", maxBytes: 2000 }), /大小|空间/);
  assert.deepEqual(await fs.readdir(directory), []);
});
