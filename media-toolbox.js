const fsp = require("node:fs/promises");
const path = require("node:path");
const { projectDir, getDownloadDir } = require("./runtime");
const { ensureMediaTools } = require("./download-tools");
const { runProcess } = require("./process-runner");
const { publishFile } = require("./media-file");

function localVideoPath(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) throw new Error("请选择本地视频，或输入文件的完整路径。");
  const file = value.trim().replace(/^"(.*)"$/, "$1");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file) || (!path.isAbsolute(file) && file.includes(":"))) throw new Error("工具箱需要本地视频文件，请选择电脑上的视频。");
  return path.resolve(projectDir, file);
}

function outputExtensions(videoCodec, audioCodec) {
  const video = ["h264", "hevc", "av1", "mpeg4"].includes(videoCodec) ? ".mp4"
    : ["vp8", "vp9"].includes(videoCodec) ? ".webm"
      : ["prores", "dnxhd", "qtrle", "png", "mjpeg"].includes(videoCodec) ? ".mov" : ".mkv";
  const audio = ({ aac: ".m4a", alac: ".m4a", mp3: ".mp3", opus: ".opus", vorbis: ".ogg", flac: ".flac", ac3: ".ac3", eac3: ".eac3", dts: ".dts", wmav1: ".wma", wmav2: ".wma", wmapro: ".wma", wmalossless: ".wma" })[audioCodec]
    || (/^pcm_(?:u8|s(?:16|24|32)le|f(?:32|64)le|alaw|mulaw)$/.test(audioCodec) ? ".wav" : ".mka");
  return { video, audio };
}

const remoteInputFormats = "mov,matroska,webm,avi,flv,live_flv,mpegts,mpeg,mpegvideo,m4v,asf,rm,ogg,mxf,h264,hevc,av1";

async function probeMedia(file, tools, { signal, run, restrictInput = false }) {
  try {
    return JSON.parse(await run(tools.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", ...(restrictInput ? ["-format_whitelist", remoteInputFormats] : []), "-show_entries",
      "stream=index,codec_type,codec_name,duration:stream_disposition=default,attached_pic:format=duration", "-of", "json", file], { signal, timeoutMs: 60000 }));
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`无法读取媒体文件，文件可能损坏或格式不受支持。${error.message.slice(-800)}`);
  }
}

function streamDuration(stream, probe) { return Number(stream.duration) > 0 ? Number(stream.duration) : Number(probe.format?.duration) || 0; }

async function splitMedia(input, { outputDir = getDownloadDir(), signal, onLog = console.log, onProgress = () => {},
  ensureTools = ensureMediaTools, run = runProcess, publish = publishFile, timeoutMs = 7200000, restrictInput = false } = {}) {
  signal?.throwIfAborted();
  const source = localVideoPath(input);
  let original;
  try { original = await fsp.stat(source); }
  catch { throw new Error("找不到这个视频文件，请检查路径或重新选择。"); }
  if (!original.isFile() || !original.size) throw new Error("请选择非空的视频文件。");
  const tools = await ensureTools({ signal, onLog });
  onLog("正在识别视频与音轨……");
  const probe = await probeMedia(source, tools, { signal, run, restrictInput });
  const videoStreams = (probe.streams || []).filter(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const audioStreams = (probe.streams || []).filter(stream => stream.codec_type === "audio");
  const video = videoStreams.find(stream => stream.disposition?.default) || videoStreams[0];
  const audio = audioStreams.find(stream => stream.disposition?.default) || audioStreams[0];
  if (!video) throw new Error("文件中没有可分离的视频画面。");
  if (!audio) throw new Error("这个视频没有音轨，无法导出独立音频文件。");
  if (videoStreams.length > 1 || audioStreams.length > 1) onLog("文件包含多条轨道，本次提取默认画面和默认音轨（未设置默认时使用第一条）。");
  const extensions = outputExtensions(video.codec_name, audio.codec_name);
  onLog(`将导出画面 ${extensions.video} 和音频 ${extensions.audio}，保留原始编码。`);
  await fsp.mkdir(outputDir, { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(outputDir, ".download-any-"));
  const videoFile = path.join(scratch, `video${extensions.video}`);
  const audioFile = path.join(scratch, `audio${extensions.audio}`);
  const published = [];
  let committed = false;
  try {
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-n", "-nostats", "-stats_period", "0.5", "-progress", "pipe:1",
      "-protocol_whitelist", "file,pipe", ...(restrictInput ? ["-format_whitelist", remoteInputFormats] : []), "-i", source,
      "-map", `0:${video.index}`, "-c", "copy", "-an", "-sn", "-dn", "-map_chapters", "-1", videoFile,
      "-map", `0:${audio.index}`, "-c", "copy", "-vn", "-sn", "-dn", "-map_chapters", "-1"];
    if (extensions.audio === ".wav") args.push("-rf64", "auto");
    args.push(audioFile);
    const duration = Math.max(streamDuration(video, probe), streamDuration(audio, probe));
    onLog("正在分离画面和音频……");
    await run(tools.ffmpeg, args, { signal, timeoutMs, capture: false, onLine: line => {
      if (line.startsWith("out_time_us=")) {
        const seconds = Math.max(0, Number(line.slice(12)) / 1000000) || 0;
        onProgress({ received: duration ? Math.min(seconds, duration) : seconds, total: duration });
      }
    } });
    signal?.throwIfAborted();
    onProgress({ received: 0, total: 0 });
    onLog("分离完成，正在检查两个文件……");
    for (const [file, type, stream] of [[videoFile, "video", video], [audioFile, "audio", audio]]) {
      const result = await probeMedia(file, tools, { signal, run });
      const tracks = result.streams || [];
      if (tracks.length !== 1 || tracks[0].codec_type !== type || tracks[0].codec_name !== stream.codec_name) throw new Error("导出文件的音画轨道校验失败，未保存结果。");
      const expected = streamDuration(stream, probe);
      const actual = streamDuration(tracks[0], result);
      if (expected > 0 && (!(actual > 0) || actual < expected - Math.max(3, expected * 0.03))) throw new Error("导出文件时长不完整，未保存结果。");
    }
    const current = await fsp.stat(source);
    if (current.size !== original.size || current.mtimeMs !== original.mtimeMs) throw new Error("处理期间原视频发生变化，请重新选择后再试。");
    const title = path.basename(source, path.extname(source));
    published.push({ ...await publish(videoFile, { outputDir, title: `${title}_画面`, extension: extensions.video, signal }), kind: "video" });
    published.push({ ...await publish(audioFile, { outputDir, title: `${title}_音频`, extension: extensions.audio, signal }), kind: "audio" });
    committed = true;
    onProgress({ received: 1, total: 1 });
    onLog("画面和音频已分别保存，原视频已保留。");
    return { files: published };
  } finally {
    if (!committed) await Promise.all(published.map(file => fsp.rm(file.file, { force: true })));
    await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = { splitMedia, localVideoPath, outputExtensions };
