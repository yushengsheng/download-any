const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { projectDir } = require("../runtime");
const { findExecutable } = require("../download-tools");
const { runProcess } = require("../process-runner");
const { downloadWithYtDlp } = require("../download-ytdlp");

const tools = { ytDlp: findExecutable("yt-dlp", process.env.YTDLP_PATH), ffmpeg: findExecutable("ffmpeg", process.env.FFMPEG_PATH), ffprobe: findExecutable("ffprobe", process.env.FFPROBE_PATH) };

test("真实 HLS 从完整清单下载全部分片、合并和校验，缺失元数据也能完成", { skip: !Object.values(tools).every(Boolean), timeout: 60000 }, async t => {
  const root = path.join(projectDir, "output", "tests");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "HLS 完整下载 "));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const source = path.join(directory, "source.m3u8");
  await runProcess(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=10", "-f", "lavfi", "-i", "sine=sample_rate=48000",
    "-t", "2", "-c:v", "libx264", "-threads", "1", "-g", "10", "-c:a", "aac", "-hls_time", "0.5", "-hls_list_size", "0", source]);
  const manifest = await fs.readFile(source, "utf8");
  const segments = manifest.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  assert.ok(segments.length >= 2);
  const assets = new Map(await Promise.all(["source.m3u8", ...segments].map(async name => [name, await fs.readFile(path.join(directory, name))])));
  const fetched = new Set();
  const server = http.createServer((request, response) => {
    const name = request.url.slice(1);
    const bytes = assets.get(name);
    if (!bytes) { response.writeHead(404); response.end(); return; }
    fetched.add(name);
    response.writeHead(200, { "Content-Type": name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t", "Content-Length": bytes.length });
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const outputDir = path.join(directory, "结果");
  const result = await downloadWithYtDlp(`http://127.0.0.1:${server.address().port}/source.m3u8`, { name: "HLS", title: "完整视频" },
    { outputDir, ensureTools: async () => tools, onLog: () => {} });
  const probe = JSON.parse(await runProcess(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", result.file]));
  assert.ok(probe.streams.some(stream => stream.codec_type === "video") && probe.streams.some(stream => stream.codec_type === "audio"));
  assert.ok(Number(probe.format.duration) >= 1.9);
  assert.ok(segments.every(name => fetched.has(name)));
  assert.deepEqual(await fs.readdir(outputDir), ["完整视频.mp4"]);
});
