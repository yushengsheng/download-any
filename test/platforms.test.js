const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { projectDir } = require("../runtime");
const { parseInput } = require("../video-input");
const { downloadVideo } = require("../download");
const { resolveMissavVideo, extractMissavDetails } = require("../download_missav");
const { startServer } = require("../app");

const youtube = "https://www.youtube.com/watch?v=YdmNOeQxaFI";
const missav = "https://missav.ws/sample-123";
const media = "https://surrit.com/target/playlist.m3u8";
const packedScript = String.raw`dvd_id: 'sample-123'; const video = document.querySelector('video.player');
eval(function(p,a,c,k,e,d){}('7=\'6://5.4/3/2.1\';',8,8,'unused|m3u8|playlist|target|com|surrit|https|source'.split('|'),0,{}))`;

test("YouTube 长短链接、转义文本、手机网页、Shorts 和嵌入地址归一为同一视频，清理合集参数", () => {
  for (const input of [youtube, "https://youtu.be/YdmNOeQxaFI", `${youtube}&list=PLtest&index=2&t=20`,
    String.raw`https\://www\.youtube.com/watch?v=YdmNOeQxaFI`, String.raw`https\://youtu.be/YdmNOeQxaFI`,
    "https://m.youtube.com/watch?v=YdmNOeQxaFI&si=share", "https://www.youtube.com/shorts/YdmNOeQxaFI",
    "https://www.youtube.com/live/YdmNOeQxaFI", "https://www.youtube-nocookie.com/embed/YdmNOeQxaFI",
    `[分享](${youtube}\\&si=share)`, `${youtube}&amp;si=share`]) {
    assert.deepEqual(parseInput(input), { platform: "youtube", url: youtube });
  }
  for (const input of ["https://www.youtube.com/", "https://www.youtube.com/playlist?list=PLtest", "https://www.youtube.com/@channel",
    "https://youtube.com.evil.test/watch?v=YdmNOeQxaFI", "https://youtu.be/YdmNOeQxaFI/other", "https://www.youtube.com/watch?v=invalid"]) {
    assert.throws(() => parseInput(input));
  }
});

test("MissAV 播放页识别语言路径、分享参数和复制转义，拒绝入口页和仿冒域名", () => {
  for (const input of [missav, "https://www.missav.ws/sample-123?share=copy#player", "https://missav.ws/en/sample-123/",
    String.raw`https\://missav\.ws/sample-123`]) assert.deepEqual(parseInput(input), { platform: "missav", url: missav });
  for (const input of ["https://missav.ws/dm339", "https://missav.ws/", "https://missav.ws/genres/test", "https://missav.ws.evil.test/sample-123"]) {
    assert.throws(() => parseInput(input));
  }
});

test("MissAV 含下划线的视频编号保持完整，语言路径、分享和转义链接定位同一主播放器", () => {
  const target = "https://missav.ws/musume-110226_01";
  for (const input of [target, `${target}?share=copy#player`, "https://www.missav.ws/en/musume-110226_01/",
    String.raw`https\://missav\.ws/musume-110226_01`]) {
    assert.deepEqual(parseInput(input), { platform: "missav", url: target });
    assert.deepEqual(extractMissavDetails([packedScript.replaceAll("sample-123", "musume-110226_01")], input),
      { url: media, title: "MissAV_musume-110226_01" });
  }
  assert.throws(() => extractMissavDetails([packedScript], target), /目标 MissAV/);
  for (const input of ["https://missav.ws/musume-110226_", "https://missav.ws/musume-110226__01", "https://missav.ws/musume-110226_01/other"]) {
    assert.throws(() => parseInput(input));
  }
});

test("MissAV 只解码匹配目标的主播放器，不执行网站脚本，不选择推荐预览或站外地址", () => {
  assert.deepEqual(extractMissavDetails([packedScript], missav), { url: media, title: "MissAV_sample-123" });
  const plain = `dvd_id: 'sample-123'; document.querySelector('video.player'); source='${media}'; globalThis.missavExecuted=true;`;
  assert.equal(extractMissavDetails([plain], missav).url, media);
  assert.equal(globalThis.missavExecuted, undefined);
  assert.throws(() => extractMissavDetails([plain.replace("sample-123", "other-456")], missav), /目标 MissAV/);
  assert.throws(() => extractMissavDetails([plain.replace("video.player", "video.preview")], missav), /目标 MissAV/);
  for (const invalid of ["https://example.com/video.m3u8", "http://surrit.com/video.m3u8", "https://surrit.com.evil.test/video.m3u8"]) {
    assert.throws(() => extractMissavDetails([plain.replace(media, invalid)], missav), /目标 MissAV/);
  }
});

function browserFixture({ scripts = [packedScript], url = missav, cancel } = {}) {
  const calls = { closed: 0, launches: [], navigation: [] };
  return { calls, launch: async config => {
    calls.launches.push(config);
    let evaluations = 0;
    return { browser: {
      close: async () => { calls.closed++; },
      newPage: async () => ({ route: async () => {},
        goto: async target => { calls.navigation.push(target); cancel?.(); }, waitForSelector: async () => {}, url: () => url,
        evaluate: async () => ++evaluations === 1 ? scripts : "test user agent"
      })
    } };
  } };
}

test("MissAV 浏览器在解析成功、失败、跳到其他视频或取消时均关闭，服务器可用无界面模式", async () => {
  const success = browserFixture();
  assert.equal((await resolveMissavVideo(missav, { ...success, headless: true })).url, media);
  assert.equal(success.calls.launches[0].headless, true);
  assert.equal(success.calls.closed, 1);
  const failed = browserFixture({ scripts: [] });
  await assert.rejects(resolveMissavVideo(missav, failed), /未能解析/);
  assert.equal(failed.calls.closed, 1);
  const redirected = browserFixture({ url: "https://missav.ws/other-456" });
  await assert.rejects(resolveMissavVideo(missav, redirected), /没有指向目标/);
  assert.equal(redirected.calls.closed, 1);
  const controller = new AbortController();
  const cancelled = browserFixture({ cancel: () => controller.abort(new Error("测试取消解析")) });
  await assert.rejects(resolveMissavVideo(missav, { ...cancelled, signal: controller.signal }), /测试取消解析/);
  assert.ok(cancelled.calls.closed >= 1);
});

async function toolsFixture(t, { audio = true, duration = 30, live = false, missingMetadata = false } = {}) {
  const root = path.join(projectDir, "output", "tests");
  await fs.mkdir(root, { recursive: true });
  const outputDir = await fs.mkdtemp(path.join(root, "多平台 中文 test "));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true, maxRetries: 3 }));
  const calls = [];
  return { outputDir, calls, ensureTools: async () => ({ ytDlp: "test-ytdlp", ffmpeg: "test-ffmpeg", ffprobe: "test-ffprobe" }), onLog: () => {},
    run: async (tool, args, options) => {
      calls.push({ tool, args });
      if (tool === "test-ffprobe") return JSON.stringify({ streams: [{ codec_type: "video" }, ...(audio ? [{ codec_type: "audio" }] : [])], format: { duration } });
      const directory = args[args.indexOf("--paths") + 1];
      const file = path.join(directory, "media.mp4");
      await fs.writeFile(file, "video fixture");
      await fs.writeFile(path.join(directory, "partial.part"), "partial");
      const missing = args.includes("--output-na-placeholder") ? args[args.indexOf("--output-na-placeholder") + 1] : "NA";
      options.onLine(`DA_LIVE:${missingMetadata ? missing : live}`);
      options.onLine(`DA_TITLE:${missingMetadata ? missing : '"视频测试"'}`);
      options.onLine(`DA_DURATION:${missingMetadata ? missing : 30}`);
      options.onLine(`DA_FILE:${JSON.stringify(file)}`);
      options.signal?.throwIfAborted();
    }
  };
}

test("YouTube 两种分享链接走同一下载入口，显式复用 Node 解析并检查合并结果，保护同名文件", async t => {
  const f = await toolsFixture(t);
  const logs = [];
  const first = await downloadVideo(youtube, { ...f, onLog: text => logs.push(text) });
  const second = await downloadVideo(String.raw`https\://youtu.be/YdmNOeQxaFI`, f);
  assert.equal(first.filename, "视频测试.mp4");
  assert.equal(second.filename, "视频测试 (1).mp4");
  assert.ok(logs.includes("已识别平台：YouTube"));
  for (const { args } of f.calls.filter(call => call.tool === "test-ytdlp")) {
    assert.equal(args.at(-1), youtube);
    assert.equal(args[args.indexOf("--js-runtimes") + 1], `node:${process.execPath}`);
    assert.equal(args[args.indexOf("--playlist-items") + 1], "1");
    assert.ok(args.includes("--no-playlist") && args.includes("--ignore-config"));
    assert.ok(!args.includes("--cookies-from-browser") && !args.includes("--remote-components"));
  }
  assert.deepEqual((await fs.readdir(f.outputDir)).sort(), [first.filename, second.filename].sort());
});

test("MissAV 关闭解析浏览器后下载主视频，保留播放页来源和标题并清理分片", async t => {
  const f = await toolsFixture(t);
  const browser = browserFixture();
  const run = f.run;
  f.run = (...args) => { assert.equal(browser.calls.closed, 1); return run(...args); };
  const result = await downloadVideo(missav, { ...f, ...browser });
  assert.equal(result.filename, "MissAV_sample-123.mp4");
  const args = f.calls[0].args;
  assert.equal(args.at(-1), media);
  assert.equal(args[args.indexOf("--referer") + 1], missav);
  assert.equal(args[args.indexOf("--user-agent") + 1], "test user agent");
  assert.deepEqual(await fs.readdir(f.outputDir), [result.filename]);
});

test("HLS 缺失直播状态、标题或时长时使用 JSON null，不把 NA 当 JSON 解析或覆盖文件名", async t => {
  const f = await toolsFixture(t, { missingMetadata: true });
  const result = await downloadVideo(missav, { ...f, ...browserFixture() });
  assert.equal(result.filename, "MissAV_sample-123.mp4");
  const args = f.calls[0].args;
  assert.equal(args[args.indexOf("--output-na-placeholder") + 1], "null");
  const youtubeResult = await downloadVideo(youtube, f);
  assert.equal(youtubeResult.filename, "watch.mp4");
  assert.deepEqual((await fs.readdir(f.outputDir)).sort(), [result.filename, youtubeResult.filename].sort());
});

test("新平台缺失音轨、时长不足、直播和取消均不发布结果，清理本次临时文件", async t => {
  for (const [config, error] of [[{ audio: false }, /音轨/], [{ duration: 1 }, /时长校验失败/], [{ live: true }, /直播/]]) {
    const f = await toolsFixture(t, config);
    await assert.rejects(downloadVideo(youtube, f), error);
    assert.deepEqual(await fs.readdir(f.outputDir), []);
  }
  const f = await toolsFixture(t);
  const controller = new AbortController();
  const run = f.run;
  await assert.rejects(downloadVideo(youtube, { ...f, signal: controller.signal, run: async (...args) => {
    await run(...args); controller.abort(new Error("取消下载"));
  } }), /取消下载/);
  assert.deepEqual(await fs.readdir(f.outputDir), []);
});

test("同一任务接口自动识别 YouTube 和 MissAV，首页不会误开下载任务", async t => {
  const f = await toolsFixture(t);
  const app = await startServer({ outputDir: f.outputDir, download: (input, options) => downloadVideo(input, { ...f, ...browserFixture(), ...options }) });
  t.after(() => app.close());
  const state = await (await fetch(`${app.url}/api/state`)).json();
  const post = input => fetch(`${app.url}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", "X-App-Token": state.token }, body: JSON.stringify({ input }) });
  for (const input of [youtube, "https://youtu.be/YdmNOeQxaFI", missav]) {
    assert.equal((await post(input)).status, 202);
    let job;
    for (let index = 0; index < 100; index++) {
      job = (await (await fetch(`${app.url}/api/state`)).json()).jobs[0];
      if (job.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.platform, parseInput(input).platform);
    assert.equal(job.status, "completed", job.error);
  }
  assert.equal((await post("https://www.youtube.com/")).status, 400);
  assert.equal((await post("https://missav.ws/dm339")).status, 400);
});
