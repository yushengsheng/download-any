const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { projectDir } = require("../runtime");
const { splitMedia, localVideoPath } = require("../media-toolbox");
const { findExecutable } = require("../download-tools");
const { runProcess } = require("../process-runner");
const { publishFile } = require("../media-file");
const { startServer } = require("../app");

const tools = { ffmpeg: findExecutable("ffmpeg", process.env.FFMPEG_PATH), ffprobe: findExecutable("ffprobe", process.env.FFPROBE_PATH) };
const mediaTest = tools.ffmpeg && tools.ffprobe ? test : test.skip;
const options = { ensureTools: async () => tools, onLog: () => {} };

async function temporary(t) {
  const root = path.join(projectDir, "output", "tests");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "工具箱 中文 & ' % test "));
  t.after(async () => {
    const relative = path.relative(root, directory);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return directory;
}

async function makeVideo(directory, ext = "mp4", videoCodec = "libx264", audioCodec = "aac") {
  const file = path.join(directory, `原始 视频.${ext}`);
  await runProcess(tools.ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", videoCodec, "-threads", "1",
    "-c:a", audioCodec, "-b:a", "64k", "-ar", "48000", "-pix_fmt", "yuv420p", file], { timeoutMs: 30000 });
  return file;
}

async function probe(file) {
  return JSON.parse(await runProcess(tools.ffprobe, ["-v", "error", "-show_streams", "-of", "json", file]));
}
async function streamHash(file, type) {
  return (await runProcess(tools.ffmpeg, ["-v", "error", "-i", file, "-map", `0:${type}:0`, "-c", "copy", "-f", "hash", "-hash", "sha256", "-"])).trim();
}
async function hash(file) { return createHash("sha256").update(await fs.readFile(file)).digest("hex"); }

test("工具箱只接受本地文件路径，相对目录以项目位置为准", () => {
  assert.equal(localVideoPath('"downloads/原视频.mp4"'), path.join(projectDir, "downloads", "原视频.mp4"));
  for (const input of [null, "", "https://example.com/a.mp4", "file:///tmp/a.mp4", "video\0.mp4"]) assert.throws(() => localVideoPath(input));
});

mediaTest("MP4 实际分离后只有单独画面和音轨，数据不转码、原文件不变、重名不覆盖", async t => {
  const directory = await temporary(t);
  const file = await makeVideo(directory);
  const originalHash = await hash(file);
  const outputDir = path.join(directory, "结果");
  const first = await splitMedia(file, { ...options, outputDir });
  assert.deepEqual(first.files.map(item => path.extname(item.file)), [".mp4", ".m4a"]);
  for (const result of first.files) {
    const data = await probe(result.file);
    assert.equal(data.streams.length, 1);
    assert.equal(data.streams[0].codec_type, result.kind);
    assert.equal(await streamHash(result.file, result.kind === "video" ? "v" : "a"), await streamHash(file, result.kind === "video" ? "v" : "a"));
  }
  const second = await splitMedia(file, { ...options, outputDir });
  assert.ok(second.files.every(item => item.filename.includes(" (1)")));
  assert.deepEqual(await fs.readdir(outputDir), [...first.files, ...second.files].map(item => item.filename).sort());
  assert.equal(await hash(file), originalHash);
});

mediaTest("实际处理常见容器与编码组合，自动匹配独立输出格式", { timeout: 120000 }, async t => {
  const root = await temporary(t);
  for (const [ext, video, audio, outputs] of [
    ["mov", "libx264", "pcm_s16le", [".mp4", ".wav"]],
    ["mkv", "ffv1", "flac", [".mkv", ".flac"]],
    ["avi", "mpeg4", "pcm_s16le", [".mp4", ".wav"]],
    ["webm", "libvpx-vp9", "libopus", [".webm", ".opus"]],
    ["flv", "flv", "libmp3lame", [".mkv", ".mp3"]],
    ["ts", "mpeg2video", "mp2", [".mkv", ".mka"]],
    ["wmv", "wmv2", "wmav2", [".mkv", ".wma"]],
    ["3gp", "h263", "aac", [".mkv", ".m4a"]],
    ["mpg", "mpeg2video", "mp2", [".mkv", ".mka"]]
  ]) {
    await t.test(ext.toUpperCase(), async () => {
      const directory = path.join(root, ext);
      await fs.mkdir(directory);
      const source = await makeVideo(directory, ext, video, audio);
      const original = await probe(source);
      const result = await splitMedia(source, { ...options, restrictInput: true, outputDir: path.join(directory, "导出") });
      assert.deepEqual(result.files.map(file => path.extname(file.file)), outputs);
      for (const file of result.files) {
        const data = await probe(file.file);
        assert.equal(data.streams.length, 1);
        assert.equal(data.streams[0].codec_type, file.kind);
        assert.equal(data.streams[0].codec_name, original.streams.find(stream => stream.codec_type === file.kind).codec_name);
      }
    });
  }
});

mediaTest("不依赖文件后缀识别真实格式，缺失音轨、只有音频和损坏文件有明确提示", async t => {
  const directory = await temporary(t);
  const source = await makeVideo(directory);
  const withoutExt = path.join(directory, "没有后缀");
  await fs.copyFile(source, withoutExt);
  const result = await splitMedia(withoutExt, { ...options, outputDir: directory });
  await assert.rejects(splitMedia(result.files[0].file, { ...options, outputDir: directory }), /没有音轨/);
  await assert.rejects(splitMedia(result.files[1].file, { ...options, outputDir: directory }), /没有可分离的视频/);
  const damaged = path.join(directory, "损坏.mp4");
  await fs.writeFile(damaged, "this is not a video");
  await assert.rejects(splitMedia(damaged, { ...options, outputDir: directory }), /无法读取媒体文件/);
  assert.ok((await fs.readdir(directory)).every(name => !name.startsWith(".download-any-")));
});

mediaTest("包含多条音轨时提取默认音轨，而非误取第一条", async t => {
  const directory = await temporary(t);
  const first = await makeVideo(directory);
  const source = path.join(directory, "双音轨.mkv");
  await runProcess(tools.ffmpeg, ["-v", "error", "-i", first, "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
    "-map", "0:v:0", "-map", "0:a:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-t", "1", "-disposition:a:0", "0", "-disposition:a:1", "default", source]);
  const result = await splitMedia(source, { ...options, outputDir: path.join(directory, "导出") });
  const expected = (await runProcess(tools.ffmpeg, ["-v", "error", "-i", source, "-map", "0:a:1", "-c", "copy", "-f", "hash", "-hash", "sha256", "-"])).trim();
  const actual = await streamHash(result.files.find(file => file.kind === "audio").file, "a");
  assert.equal(actual, expected);
  assert.notEqual(actual, await streamHash(source, "a"));
});

mediaTest("第二个文件发布失败时回滚第一个，取消时清理未完成文件", async t => {
  const directory = await temporary(t);
  const file = await makeVideo(directory);
  const outputDir = path.join(directory, "失败测试");
  let published = 0;
  await assert.rejects(splitMedia(file, { ...options, outputDir, publish: async (...args) => {
    if (++published === 2) throw new Error("模拟磁盘写入失败");
    return publishFile(...args);
  } }), /模拟磁盘写入失败/);
  assert.deepEqual(await fs.readdir(outputDir), []);
  const controller = new AbortController();
  await assert.rejects(splitMedia(file, { ...options, outputDir, signal: controller.signal,
    onProgress: () => controller.abort(new Error("测试取消分离")),
    run: (command, args, config) => runProcess(command, command === tools.ffmpeg ? ["-re", ...args] : args, config)
  }), /测试取消分离/);
  assert.deepEqual(await fs.readdir(outputDir), []);
});

mediaTest("工具箱页面和接口完成真实文件分离，两个结果均可下载，复用保存目录", async t => {
  const directory = await temporary(t);
  const source = await makeVideo(directory);
  const outputDir = path.join(directory, "设置的保存目录");
  const app = await startServer({ outputDir, chooseFile: async () => source, split: (file, config) => splitMedia(file, { ...config, ...options }) });
  t.after(() => app.close());
  assert.match(await (await fetch(`${app.url}/toolbox`)).text(), /视频工具箱/);
  const state = await (await fetch(`${app.url}/api/state`)).json();
  const post = (route, body = {}) => fetch(`${app.url}${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-App-Token": state.token }, body: JSON.stringify(body) });
  assert.equal((await (await post("/api/choose-video")).json()).file, source);
  assert.equal((await post("/api/toolbox/split", { file: "https://example.com/video.mp4" })).status, 400);
  assert.equal((await post("/api/toolbox/split", { file: source })).status, 202);
  let job;
  for (let count = 0; count < 150; count++) {
    job = (await (await fetch(`${app.url}/api/state`)).json()).jobs[0];
    if (job.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.type, "split");
  assert.equal(job.result.files.length, 2);
  for (const file of job.result.files) {
    assert.equal(path.dirname(file.file), outputDir);
    const response = await fetch(`${app.url}/api/file?id=${job.id}&part=${file.kind}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), file.kind === "video" ? "video/mp4" : "audio/mp4");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(file.file));
  }
  assert.equal((await fetch(`${app.url}/api/file?id=${job.id}&part=other`)).status, 404);
});

test("分离与下载共享并发限制，能取消任务，关闭时终止正在处理的分离", async t => {
  const directory = await temporary(t);
  let cancelled = 0;
  const app = await startServer({ outputDir: directory, split: (_file, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { cancelled++; reject(signal.reason); }, { once: true });
  }) });
  t.after(() => app.close());
  const state = await (await fetch(`${app.url}/api/state`)).json();
  const post = (route, body = {}) => fetch(`${app.url}${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-App-Token": state.token }, body: JSON.stringify(body) });
  let response = await post("/api/toolbox/split", { file: path.join(directory, "源视频.mp4") });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.equal((await post("/api/jobs", { input: "https://www.douyin.com/video/1" })).status, 409);
  assert.equal((await post("/api/directory", { directory })).status, 409);
  assert.equal((await post("/api/choose-video")).status, 409);
  assert.equal((await post("/api/cancel", { id: "invalid" })).status, 409);
  assert.equal((await post("/api/cancel", { id })).status, 200);
  assert.equal((await (await fetch(`${app.url}/api/state`)).json()).jobs[0].status, "cancelled");
  response = await post("/api/toolbox/split", { file: path.join(directory, "源视频.mp4") });
  assert.equal(response.status, 202);
  await app.close();
  assert.equal(cancelled, 2);
});
