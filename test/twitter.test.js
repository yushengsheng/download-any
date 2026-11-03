const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { projectDir } = require("../runtime");
const { parseInput, platformNames } = require("../video-input");
const { downloadVideo } = require("../download");
const { downloadTwitter } = require("../download_twitter");
const { saveVideo } = require("../download_douyin_core");
const { startServer } = require("../app");

const id = "2116171711179833617";
const post = `https://x.com/77pornTV/status/${id}`;
const direct = "https://video.twimg.com/amplify_video/2116170438770561024/vid/avc1/720x1280/W9ybx8VjxS7KKmCi.mp4?tag=14";
const inputs = [post, `${post}/video/1`, `${post}?a=NSuHrpZVkFRA-4tSN0c&s=20`, direct];

test("四种用户链接及推特旧域名自动识别，视频编号保持字符串并保留视频序号和直链参数", () => {
  assert.equal(platformNames.twitter, "推特");
  for (const [index, input] of inputs.entries()) {
    assert.deepEqual(parseInput(input), { platform: "twitter", url: index === 2 ? post : input });
  }
  for (const domain of ["twitter.com", "www.twitter.com", "mobile.twitter.com", "www.x.com"]) {
    assert.equal(parseInput(`https://${domain}/77pornTV/status/${id}?s=20`).url, post);
  }
  assert.equal(parseInput(`${post}/video/2?s=20`).url, `${post}/video/2`);
  assert.equal(parseInput(`分享 [推特视频](${inputs[2].replaceAll("&", "\\&")})`).url, post);
  assert.equal(parseInput(direct.replaceAll("&", "&amp;")).url, direct);
  for (const invalid of ["https://x.com/77pornTV", `${post}/video/0`, `${post}/video/wrong`,
    `https://x.com.evil.test/77pornTV/status/${id}`, `https://user:pass@x.com/77pornTV/status/${id}`,
    "https://video.twimg.com.evil.test/amplify_video/a.mp4", "https://video.twimg.com/amplify_video/a.html", "https://example.com/video.mp4"]) {
    assert.throws(() => parseInput(invalid));
  }
});

async function fixture(t, { audio = true, duration = 12, metadataError = false, broken = false } = {}) {
  const root = path.join(projectDir, "output", "tests");
  await fs.mkdir(root, { recursive: true });
  const outputDir = await fs.mkdtemp(path.join(root, "推特 中文 test "));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true, maxRetries: 3 }));
  const bytes = Buffer.from("00000018ftypmp42 twitter video fixture");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": broken ? bytes.length + 10 : bytes.length });
    if (broken) { response.write(bytes); response.destroy(); }
    else response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const calls = [];
  const metadata = { display_id: id, title: "推特测试", duration: 12, url: direct, formats: [{ url: direct, tbr: 1000 }] };
  const options = { outputDir, onLog: () => {},
    ensureTools: async () => ({ ytDlp: "test-ytdlp", ffmpeg: "test-ffmpeg", ffprobe: "test-ffprobe" }),
    run: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === "test-ytdlp") {
        if (metadataError) throw new Error("No video could be found in this tweet");
        return JSON.stringify(metadata);
      }
      return JSON.stringify({ streams: [{ codec_type: "video" }, ...(audio ? [{ codec_type: "audio" }] : [])], format: { duration } });
    },
    save: (url, options) => { calls.push({ url }); return saveVideo(`http://127.0.0.1:${server.address().port}`, options); }
  };
  return { outputDir, options, calls, bytes, metadata };
}

test("统一入口下载四种推特链接，同一视频数据一致，直链跳过帖子解析且同名不覆盖", async t => {
  const f = await fixture(t);
  const results = [];
  for (const input of inputs) results.push(await downloadVideo(input, f.options));
  for (const result of results) assert.deepEqual(await fs.readFile(result.file), f.bytes);
  assert.equal(results[0].filename, "推特测试.mp4");
  assert.equal(results[1].filename, "推特测试 (1).mp4");
  assert.equal(f.calls.filter(call => call.tool === "test-ytdlp").length, 3);
  for (const call of f.calls.filter(call => call.tool === "test-ytdlp")) {
    assert.ok(call.args.includes("--ignore-config") && call.args.includes("--no-playlist"));
    assert.equal(call.args[call.args.indexOf("--playlist-items") + 1], "1");
    assert.ok(!call.args.includes("--cookies-from-browser"));
  }
  assert.deepEqual(f.calls.filter(call => call.url).map(call => call.url), inputs.map(() => direct));
  assert.deepEqual((await fs.readdir(f.outputDir)).sort(), results.map(result => result.filename).sort());
});

function fallbackResponse(media = [{ type: "video", duration: 12, url: direct, formats: [{ url: direct, bitrate: 1000 }] }]) {
  return { code: 200, tweet: { id, media: { all: media } } };
}

test("官方解析失败后校对备用信息中的帖子编号，保留指定媒体序号并忽略引用帖子", async t => {
  const f = await fixture(t, { metadataError: true });
  const data = fallbackResponse([{ type: "photo" }, { type: "video", duration: 12, url: direct }]);
  data.tweet.quote = { media: { all: [{ type: "video", url: "https://example.com/wrong.mp4" }] } };
  const requests = [];
  t.mock.method(global, "fetch", async (url, config) => {
    requests.push({ url, config });
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  });
  const result = await downloadTwitter(`${post}/video/2`, f.options);
  assert.deepEqual(await fs.readFile(result.file), f.bytes);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://api.fxtwitter.com/status/${id}`);
  assert.equal(requests[0].config.redirect, "error");
  assert.deepEqual(f.calls.filter(call => call.url).map(call => call.url), [direct]);
  await assert.rejects(downloadTwitter(`${post}/video/1`, f.options), /没有对应的视频/);
});

test("备用解析拒绝错误帖子、站外地址和只有引用视频的帖子，不发布或下载错误文件", async t => {
  const f = await fixture(t, { metadataError: true });
  let data = fallbackResponse();
  data.tweet.id = "2116171711179833618";
  t.mock.method(global, "fetch", async () => new Response(JSON.stringify(data)));
  await assert.rejects(downloadTwitter(post, f.options), /目标推特帖子/);
  data = fallbackResponse([{ type: "video", url: "https://example.com/wrong.mp4" }]);
  await assert.rejects(downloadTwitter(post, f.options), /MP4 地址/);
  data = fallbackResponse([]);
  data.tweet.quote = { media: { all: [{ type: "video", url: direct }] } };
  await assert.rejects(downloadTwitter(post, f.options), /没有对应的视频/);
  assert.equal(f.calls.filter(call => call.url).length, 0);
  assert.deepEqual(await fs.readdir(f.outputDir), []);
});

test("推特允许无声视频，时长不足、下载中断和超限时清理文件并保护已有结果", async t => {
  const f = await fixture(t, { audio: false });
  const silent = await downloadTwitter(post, f.options);
  await assert.rejects(downloadTwitter(post, { ...f.options, maxBytes: 1 }), /超过/);
  const truncated = await fixture(t, { duration: 1 });
  await assert.rejects(downloadTwitter(post, truncated.options), /时长校验失败/);
  assert.deepEqual(await fs.readdir(truncated.outputDir), []);
  const broken = await fixture(t, { broken: true });
  await assert.rejects(downloadTwitter(post, broken.options));
  assert.deepEqual(await fs.readdir(broken.outputDir), []);
  assert.deepEqual(await fs.readdir(f.outputDir), [silent.filename]);
  assert.deepEqual(await fs.readFile(silent.file), f.bytes);
});

test("取消官方解析时不请求备用接口，取消文件下载或校验时不发布结果", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let fallbackRequests = 0;
  t.mock.method(global, "fetch", async () => { fallbackRequests++; throw new Error("不应访问备用解析"); });
  await assert.rejects(downloadTwitter(post, { ...f.options, signal: controller.signal, run: async () => {
    controller.abort(new Error("取消帖子解析")); throw controller.signal.reason;
  } }), /取消帖子解析/);
  assert.equal(fallbackRequests, 0);
  const downloadController = new AbortController();
  await assert.rejects(downloadTwitter(direct, { ...f.options, signal: downloadController.signal,
    onProgress: () => downloadController.abort(new Error("取消视频下载")) }), /取消视频下载/);
  const probeController = new AbortController();
  await assert.rejects(downloadTwitter(direct, { ...f.options, signal: probeController.signal, run: async () => {
    probeController.abort(new Error("取消成品校验")); throw probeController.signal.reason;
  } }), /取消成品校验/);
  assert.deepEqual(await fs.readdir(f.outputDir), []);
});

test("网页任务接口将四种地址识别为推特并使用同一个下载入口", async t => {
  const f = await fixture(t);
  const app = await startServer({ outputDir: f.outputDir, download: (input, options) => downloadVideo(input, { ...f.options, ...options }) });
  t.after(() => app.close());
  assert.match(await (await fetch(app.url)).text(), /抖音、B 站、推特、YouTube 和 MissAV/);
  const state = await (await fetch(`${app.url}/api/state`)).json();
  for (const input of inputs) {
    const response = await fetch(`${app.url}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", "X-App-Token": state.token }, body: JSON.stringify({ input }) });
    assert.equal(response.status, 202);
    let job;
    for (let count = 0; count < 100; count++) {
      job = (await (await fetch(`${app.url}/api/state`)).json()).jobs[0];
      if (job.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.platform, "twitter");
    assert.equal(job.status, "completed", job.error);
    const result = await fetch(`${app.url}/api/file?id=${job.id}`);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), f.bytes);
  }
});
