const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { gzipSync } = require("node:zlib");
const { createHash } = require("node:crypto");
const { projectDir } = require("../runtime");
const { parseInput } = require("../video-input");
const { downloadVideo } = require("../download");
const { downloadBilibili, resolveVideoUrl } = require("../download_bilibili");
const { runProcess } = require("../process-runner");
const { installAsset } = require("../download-tools");
const { startServer } = require("../app");

const canonical = "https://www.bilibili.com/video/BV1DzYy6FEqy/";
const share = String.raw`【时速最少160以上飞过去了】 https\://www\.bilibili.com/video/BV1DzYy6FEqy/?share_source=copy_web&vd_source=6ec1cc4ffc7702547093e399842c0a40`;
const web = `${canonical}?trackid=web_pegasus_0.router-web-pegasus-2479516-sm4rx.1792140352082.907&spm_id_from=333.1007.tianma.5-4-18.click&vd_source=f2d8fed286cd685c2814fb48eb2a6328`;

async function temporary(t) {
  const root = path.join(projectDir, "output", "tests");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "B站 中文 test "));
  t.after(async () => {
    const relative = path.relative(root, directory);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return directory;
}

test("同一输入自动识别两平台，清理 B 站分享和网页参数，保留 BV 大小写和分 P", () => {
  for (const input of [share, web, `[视频](${web.replaceAll("&", "\\&")})`, web.replaceAll("&", "&amp;")]) {
    assert.deepEqual(parseInput(input), { platform: "bilibili", url: canonical });
  }
  assert.equal(parseInput(`${canonical}?p=2&spm_id_from=copy`).url, `${canonical}?p=2`);
  assert.equal(parseInput("https://m.bilibili.com/video/av123/?p=3").url, "https://www.bilibili.com/video/av123/?p=3");
  assert.equal(parseInput("https://b23.tv/AbCd123?share=copy").url, "https://b23.tv/AbCd123");
  assert.deepEqual(parseInput("https://v.douyin.com/987Y-4zEs7w/"), { platform: "douyin", url: "https://v.douyin.com/987Y-4zEs7w/" });
  assert.equal(parseInput("https://www.douyin.com/jingxuan/search/test?modal_id=7667476840059096383&type=general").url, "https://www.douyin.com/video/7667476840059096383");
  for (const input of ["https://bilibili.com.evil.test/video/BV1DzYy6FEqy/", "https://example.com/", "https://www.bilibili.com/", `${canonical}?p=0`, `${canonical}?p=2oops`, "https://user:pass@www.bilibili.com/video/BV1DzYy6FEqy/", "https://www.bilibili.com:9000/video/BV1DzYy6FEqy/"]) assert.throws(() => parseInput(input));
});

test("B 站短链接只跟随有限次跳转并要求最终指向具体 B 站视频", async t => {
  let count = 0;
  t.mock.method(global, "fetch", async () => { count++; return new Response(null, { status: 302, headers: { Location: `${canonical}?p=2&share=copy` } }); });
  assert.equal(await resolveVideoUrl("https://b23.tv/test"), `${canonical}?p=2`);
  assert.equal(count, 1);
  global.fetch.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: "https://b23.tv/loop" } }));
  await assert.rejects(resolveVideoUrl("https://b23.tv/test"), /跳转次数/);
  global.fetch.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: "https://example.com/private" } }));
  await assert.rejects(resolveVideoUrl("https://b23.tv/test"), /目前支持/);
  global.fetch.mock.mockImplementation(async () => new Response(null, { status: 200 }));
  await assert.rejects(resolveVideoUrl("https://b23.tv/test"), /无法解析/);
});

function simulatedTools({ audio = true, fail = false } = {}) {
  const calls = [];
  return { calls, ensureTools: async () => ({ ytDlp: "test-ytdlp", ffmpeg: "test-ffmpeg", ffprobe: "test-ffprobe" }),
    run: async (tool, args, options) => {
      calls.push({ tool, args });
      if (tool === "test-ffprobe") return JSON.stringify({ streams: [{ codec_type: "video" }, ...(audio ? [{ codec_type: "audio" }] : [])], format: { duration: "270" } });
      const scratch = args[args.indexOf("--paths") + 1];
      const file = path.join(scratch, "media.mp4");
      await fs.writeFile(file, "completed media fixture");
      await fs.writeFile(path.join(scratch, "partial.f30080.mp4.part"), "partial");
      options.onLine(`DA_TITLE:${JSON.stringify("时速:160")}`);
      options.onLine("DA_DURATION:270");
      options.onLine(`DA_PROGRESS:${JSON.stringify({ filename: "video.mp4", downloaded_bytes: 100, total_bytes: 100 })}`);
      options.onLine(`DA_PROGRESS:${JSON.stringify({ filename: "audio.m4a", downloaded_bytes: 10, total_bytes: 20 })}`);
      options.onLine(`DA_FILE:${JSON.stringify(file)}`);
      if (fail) throw new Error("模拟网络失败");
      options.signal?.throwIfAborted();
      return "";
    } };
}

test("统一下载入口调度 B 站，合并检查后发布，同名文件不覆盖且清理分片", async t => {
  const outputDir = await temporary(t);
  const tools = simulatedTools();
  const logs = [];
  const progress = [];
  const first = await downloadVideo(share, { outputDir, ...tools, onLog: text => logs.push(text), onProgress: value => progress.push(value) });
  const second = await downloadBilibili(web, { outputDir, ...tools, onLog: () => {} });
  assert.equal(first.filename, "时速_160.mp4");
  assert.equal(second.filename, "时速_160 (1).mp4");
  assert.equal(await fs.readFile(first.file, "utf8"), "completed media fixture");
  assert.ok(logs.some(line => line.includes("已识别平台：B 站")));
  assert.ok(progress.some(value => value.received === 110 && value.total === 120));
  const args = tools.calls[0].args;
  assert.equal(args.at(-1), canonical);
  assert.ok(args.includes("--no-playlist") && args.includes("--ignore-config") && args.includes("--abort-on-unavailable-fragments"));
  assert.deepEqual((await fs.readdir(outputDir)).sort(), [first.filename, second.filename].sort());
});

test("音轨缺失、下载失败和取消都不发布结果并清理临时目录", async t => {
  const outputDir = await temporary(t);
  await assert.rejects(downloadBilibili(canonical, { outputDir, ...simulatedTools({ audio: false }), onLog: () => {} }), /音轨/);
  await assert.rejects(downloadBilibili(canonical, { outputDir, ...simulatedTools({ fail: true }), onLog: () => {} }), /模拟网络失败/);
  const controller = new AbortController();
  const tools = simulatedTools();
  const run = tools.run;
  tools.run = async (...args) => { const result = await run(...args); controller.abort(new Error("测试取消")); return result; };
  await assert.rejects(downloadBilibili(canonical, { outputDir, ...tools, signal: controller.signal, onLog: () => {} }), /测试取消/);
  assert.deepEqual(await fs.readdir(outputDir), []);
});

test("下载进程成功但文件时长不完整时，不产生成功文件", async t => {
  const outputDir = await temporary(t);
  const tools = simulatedTools();
  const run = tools.run;
  tools.run = (tool, ...args) => tool === "test-ffprobe" ? JSON.stringify({ streams: [{ codec_type: "video" }, { codec_type: "audio" }], format: { duration: "30" } }) : run(tool, ...args);
  await assert.rejects(downloadBilibili(canonical, { outputDir, ...tools, onLog: () => {} }), /时长校验失败/);
  assert.deepEqual(await fs.readdir(outputDir), []);
});

test("同一个任务接口识别并调度 B 站与抖音，无需选择平台", async t => {
  const outputDir = await temporary(t);
  const received = [];
  const app = await startServer({ outputDir, download: async url => { received.push(url); return { file: "test.mp4", filename: "test.mp4", bytes: 1 }; } });
  t.after(() => app.close());
  const state = await (await fetch(`${app.url}/api/state`)).json();
  for (const input of [share, "https://www.douyin.com/jingxuan/search/test?modal_id=7667476840059096383"]) {
    const response = await fetch(`${app.url}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", "X-App-Token": state.token }, body: JSON.stringify({ input }) });
    assert.equal(response.status, 202);
    const current = await (await fetch(`${app.url}/api/state`)).json();
    assert.equal(current.jobs[0].platform, parseInput(input).platform);
  }
  assert.deepEqual(received, [canonical, "https://www.douyin.com/video/7667476840059096383"]);
});

test("子进程超时和取消会结束进程树，输出按 UTF-8 解码并限制大小", { timeout: 20000 }, async () => {
  assert.equal(await runProcess(process.execPath, ["-e", "const b=Buffer.from('中文');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),20)"]), "中文");
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"], { maxOutput: 100 }), /内容过多/);
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 }), /超时/);
  const controller = new AbortController();
  let descendant;
  const script = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',`console.log('READY');setInterval(()=>{},1000)`],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>console.log('CHILD:'+c.pid));setInterval(()=>{},1000);";
  try {
    await assert.rejects(runProcess(process.execPath, ["-e", script], { signal: controller.signal, onLine: line => {
      if (line.startsWith("CHILD:")) { descendant = Number(line.slice(6)); controller.abort(new Error("测试取消进程树")); }
    } }), /测试取消进程树/);
    assert.ok(descendant);
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt++) {
      try { process.kill(descendant, 0); await new Promise(resolve => setTimeout(resolve, 50)); }
      catch { alive = false; }
    }
    assert.equal(alive, false, "子进程应在取消后退出");
  } finally { if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} } }
});

test("按需安装工具校验解压后的 SHA-256，复用已验证文件，失败和取消保护旧工具", async t => {
  const outputDir = await temporary(t);
  const bytes = Buffer.from("test tool executable");
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    if (request.url === "/slow") { response.writeHead(200); const timer = setInterval(() => response.write("x"), 20); response.on("close", () => clearInterval(timer)); }
    else response.end(gzipSync(request.url === "/bad" ? Buffer.from("corrupt") : bytes));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const spec = { url, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), gzip: true };
  const target = path.join(outputDir, "工具 exe");
  await installAsset(spec, target);
  await installAsset(spec, target);
  assert.equal(requests, 1);
  await assert.rejects(installAsset({ ...spec, url: `${url}/bad`, sha256: "0".repeat(64) }, target), /校验失败/);
  assert.deepEqual(await fs.readFile(target), bytes);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("取消工具安装")), 80);
  try { await assert.rejects(installAsset({ ...spec, url: `${url}/slow`, size: 100000, gzip: false }, path.join(outputDir, "取消"), { signal: controller.signal }), /取消工具安装/); }
  finally { clearTimeout(timer); }
  assert.deepEqual(await fs.readdir(outputDir), [path.basename(target)]);
});
