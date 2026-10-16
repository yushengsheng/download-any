const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { downloadVideo } = require("./download");
const { parseInput } = require("./video-input");
const { projectDir, getDownloadDir, browserCandidates, openPath } = require("./runtime");
const { settingsFile: defaultSettingsFile, readDirectorySettings, ensureWritableDir, saveDownloadDir } = require("./settings");
const { chooseDirectory, chooseVideoFile } = require("./folder-picker");
const { splitMedia, localVideoPath } = require("./media-toolbox");
const { createAuth } = require("./server-auth");
const { ServerCache, receiveVideo } = require("./server-cache");

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!(request.headers["content-type"] || "").startsWith("application/json")) throw new Error("请求格式不正确。");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error("分享文案过长，请只粘贴视频链接。");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("请求内容无法识别。"); }
}

async function startServer({ outputDir, settingsFile = defaultSettingsFile, download = downloadVideo, split = splitMedia, openDirectory = openPath, chooseFolder = chooseDirectory, chooseFile = chooseVideoFile, port, serverMode } = {}) {
  const auth = serverMode ? createAuth(serverMode.credentials, { secure: new URL(serverMode.publicUrl).protocol === "https:" }) : null;
  const cache = serverMode ? new ServerCache(serverMode) : null;
  const saved = readDirectorySettings(settingsFile);
  let directoryWarning = outputDir ? null : saved.warning;
  const defaultDir = getDownloadDir("downloads", settingsFile);
  outputDir = serverMode ? cache.root : getDownloadDir(outputDir || process.env.DOWNLOAD_DIR || saved.downloadDir || "downloads", settingsFile);
  let directoryError = null;
  try { await ensureWritableDir(outputDir); }
  catch { directoryError = "保存目录不可用，请重新选择可写的文件夹。"; }
  const token = randomBytes(24).toString("hex");
  const jobs = [];
  const browsers = browserCandidates().map(item => item.name);
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/toolbox": ["index.html", "text/html; charset=utf-8"],
    "/login": ["login.html", "text/html; charset=utf-8"],
    "/login.js": ["login.js", "text/javascript; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"]
  };
  const assets = new Map(await Promise.all(Object.entries(files).map(async ([url, [file, type]]) =>
    [url, { type, content: await fsp.readFile(path.join(projectDir, "web", file)) }])));
  if (cache) await cache.init();
  let activeJob;
  let changingDirectory = false;
  let pickerPromise;
  const appController = new AbortController();
  let closing = false;
  let origin;
  let allowedOrigins;
  let sweeping;
  async function sweep() {
    if (!cache) return;
    if (sweeping) return sweeping;
    sweeping = cache.sweep().then(ids => {
      for (const job of jobs) if (ids.includes(job.id)) { job.status = "expired"; delete job.result; job.error = "服务器临时文件已到期清理，请重新处理。"; }
    }).finally(() => { sweeping = null; });
    return sweeping;
  }
  function startJob(fields, operation) {
    const job = { id: randomUUID(), ...fields, status: "running", logs: [], progress: null, createdAt: new Date().toISOString() };
    jobs.unshift(job);
    // Keep every retained result reachable, even when a full cache rejects new tasks.
    let history = 0;
    for (let index = 0; index < jobs.length; index++) {
      if (!cache?.entries.has(jobs[index].id) && ++history > 20) jobs.splice(index--, 1);
    }
    const controller = new AbortController();
    const jobOutputDir = outputDir;
    const promise = Promise.resolve().then(async () => {
      let config;
      if (cache) { await sweep(); config = await cache.create(job.id); }
      const result = await operation({
        outputDir: config ? path.join(config.directory, "results") : jobOutputDir,
        sourceDir: config ? path.join(config.directory, "input") : undefined,
        maxBytes: config?.maxBytes, signal: controller.signal,
        onLog: message => { job.logs.push(String(message).slice(0, 2000)); if (job.logs.length > 100) job.logs.shift(); },
        onProgress: progress => { job.progress = progress; }
      });
      if (cache) {
        await fsp.rm(path.join(config.directory, "input"), { recursive: true, force: true });
        job.expiresAt = await cache.finish(job.id, result.files ? result.files.reduce((sum, file) => sum + file.bytes, 0) : result.bytes);
      }
      return result;
    }).then(result => { job.result = result; job.status = "completed"; })
      .catch(async error => {
        job.error = error.message;
        if (cache) await cache.remove(job.id).catch(cleanup => { console.error(`临时文件清理失败：${cleanup.message}`); });
        job.status = controller.signal.aborted ? "cancelled" : "failed";
      })
      .finally(() => { activeJob = null; });
    activeJob = { job, controller, promise };
    return job;
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      request.setTimeout(30000, () => request.destroy());
      if (!allowedOrigins.some(value => new URL(value).host === request.headers.host)) return json(response, 403, { error: "请使用程序配置的访问地址。" });
      const url = new URL(request.url, origin);
      const originValid = !request.headers.origin || allowedOrigins.includes(request.headers.origin);
      if (request.method === "GET" && url.pathname === "/healthz") { response.writeHead(204); return response.end(); }
      if (auth && request.method === "POST" && url.pathname === "/api/login") {
        if (!originValid) return json(response, 403, { error: "登录来源不正确。" });
        const body = await readJson(request);
        const result = await auth.login(body?.password, request.socket.remoteAddress);
        if (result.cookie) response.setHeader("Set-Cookie", result.cookie);
        if (result.status === 429) response.setHeader("Retry-After", "900");
        return json(response, result.status, result.error ? { error: result.error } : { ok: true });
      }
      const session = auth?.getSession(request.headers.cookie);
      const publicAsset = ["/login", "/login.js", "/style.css"].includes(url.pathname);
      if (auth && !session && !publicAsset) {
        if (url.pathname.startsWith("/api/")) return json(response, 401, { error: "请先输入密码登录。" });
        response.writeHead(303, { Location: `/login?next=${url.pathname === "/toolbox" ? "/toolbox" : "/"}` });
        return response.end();
      }
      if (request.method === "GET" && assets.has(url.pathname)) {
        const { type, content } = assets.get(url.pathname);
        response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
        return response.end(content);
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        await sweep();
        return json(response, 200, { token: session?.token || token, serverMode: Boolean(serverMode),
          outputDir: serverMode ? undefined : outputDir, defaultDir: serverMode ? undefined : defaultDir,
          retentionMs: serverMode?.retentionMs, maxUploadBytes: serverMode?.maxFileBytes,
          directoryError, directoryWarning, browsers, jobs });
      }
      if (request.method === "GET" && url.pathname === "/api/file") {
        const job = jobs.find(item => item.id === url.searchParams.get("id") && item.status === "completed");
        const file = job?.result?.files ? job.result.files.find(file => file.kind === url.searchParams.get("part")) : job?.result;
        if (!file) return json(response, 404, { error: "未找到已完成的文件。" });
        const unpin = cache?.pin(job.id);
        if (cache && !unpin) return json(response, 410, { error: "临时文件已过期，请重新处理。" });
        try {
        const stat = await fsp.stat(file.file);
        const contentType = ({ ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".opus": "audio/ogg", ".ogg": "audio/ogg" })[path.extname(file.filename)] || "application/octet-stream";
        let start = 0;
        let end = stat.size - 1;
        if (request.headers.range) {
          const match = request.headers.range.match(/^bytes=(\d*)-(\d*)$/);
          if (!match || (!match[1] && !match[2])) { response.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); return response.end(); }
          start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { response.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); return response.end(); }
          response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        }
        response.writeHead(request.headers.range ? 206 : 200, {
          "Content-Type": contentType, "Content-Length": end - start + 1, "Accept-Ranges": "bytes",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`
        });
        await pipeline(fs.createReadStream(file.file, { start, end }), response);
        return;
        } finally { unpin?.(); }
      }
      if (request.method === "POST") {
        if (request.headers["x-app-token"] !== (session?.token || token) || !originValid) {
          return json(response, 403, { error: "页面已过期，请刷新后重试。" });
        }
        if (auth && url.pathname === "/api/logout") {
          response.setHeader("Set-Cookie", auth.logout(request.headers.cookie));
          return json(response, 200, { ok: true });
        }
        if (serverMode && ["/api/open-folder", "/api/choose-folder", "/api/choose-video", "/api/directory", "/api/toolbox/split"].includes(url.pathname)) return json(response, 403, { error: "服务器版请上传视频，结果由浏览器保存到你的电脑。" });
        if (cache && url.pathname === "/api/clear-job") {
          const body = await readJson(request);
          const job = jobs.find(job => job.id === body?.id && job.status === "completed");
          if (!job || !await cache.remove(job.id)) return json(response, 409, { error: "文件正在传输或任务已经结束，请稍后重试。" });
          job.status = "expired"; delete job.result;
          return json(response, 200, { ok: true });
        }
        if (cache && url.pathname === "/api/toolbox/upload") {
          if (closing || activeJob) return json(response, 409, { error: "已有任务正在处理，请稍候。" });
          if (!(request.headers["content-type"] || "").startsWith("application/octet-stream")) throw new Error("请选择视频文件上传。");
          const size = Number(request.headers["content-length"] || request.headers["x-file-size"]);
          if (!Number.isSafeInteger(size) || size <= 0 || size > serverMode.maxFileBytes) return json(response, 413, { error: `上传文件最大 ${Math.floor(serverMode.maxFileBytes / 1024 / 1024)} MB。` });
          let uploaded;
          let rejected;
          const ready = new Promise((resolve, reject) => { uploaded = resolve; rejected = reject; });
          const job = startJob({ type: "split", sourceName: "上传的视频" }, async options => {
            try {
              await fsp.mkdir(options.sourceDir, { recursive: true });
              options.onLog("正在上传视频……");
              const video = await receiveVideo(request, options.sourceDir, { ...options, maxBytes: options.maxBytes });
              job.sourceName = video.name;
              uploaded();
              return await split(video.source, { ...options, restrictInput: true });
            } catch (error) { rejected(error); throw error; }
          });
          const abortUpload = () => { if (activeJob?.job.id === job.id) activeJob.controller.abort(new Error("视频上传已取消。")); };
          request.once("aborted", abortUpload);
          activeJob.promise.then(() => { if (job.status !== "completed") rejected(new Error(job.error)); });
          try { await ready; } finally { request.removeListener("aborted", abortUpload); }
          return json(response, 202, { id: job.id });
        }
        if (url.pathname === "/api/open-folder") {
          if (directoryError) throw new Error(directoryError);
          await openDirectory(outputDir, { directory: true });
          return json(response, 200, { ok: true });
        }
        if (["/api/choose-folder", "/api/choose-video"].includes(url.pathname)) {
          if (closing || activeJob || changingDirectory || pickerPromise) return json(response, 409, { error: "当前有任务正在处理，请稍候再选择目录。" });
          const isFile = url.pathname === "/api/choose-video";
          request.setTimeout(310000);
          pickerPromise = Promise.resolve().then(() => (isFile ? chooseFile : chooseFolder)(outputDir, { signal: appController.signal }));
          try { return json(response, 200, { [isFile ? "file" : "directory"]: await pickerPromise }); }
          finally { pickerPromise = null; }
        }
        if (url.pathname === "/api/directory") {
          const body = await readJson(request);
          if (typeof body?.directory !== "string" || !body.directory.trim() || body.directory.length > 4096) throw new Error("请输入有效的文件夹路径。");
          if (closing || activeJob || changingDirectory || pickerPromise) return json(response, 409, { error: "请等待当前任务完成后再更改保存目录。" });
          changingDirectory = true;
          try {
            const directory = getDownloadDir(body.directory, settingsFile);
            try { await ensureWritableDir(directory); }
            catch { throw new Error("无法写入这个文件夹，请检查路径和权限。"); }
            try { await saveDownloadDir(directory, settingsFile); }
            catch { throw new Error("无法保存目录设置，请检查程序所在文件夹的写入权限。"); }
            outputDir = directory;
            directoryError = null;
            directoryWarning = null;
            return json(response, 200, { outputDir });
          } finally { changingDirectory = false; }
        }
        if (url.pathname === "/api/cancel") {
          const body = await readJson(request);
          if (!activeJob || body?.id !== activeJob.job.id) return json(response, 409, { error: "任务已结束或不存在。" });
          activeJob.controller.abort(new Error("任务已取消，未完成的文件已清理。"));
          return json(response, 200, { ok: true });
        }
        if (["/api/jobs", "/api/toolbox/split"].includes(url.pathname)) {
          const body = await readJson(request);
          if (closing || activeJob || changingDirectory || pickerPromise) return json(response, 409, { error: "已有任务正在处理或程序正在退出，请稍候。" });
          if (directoryError) throw new Error(directoryError);
          let job;
          if (url.pathname === "/api/toolbox/split") {
            const source = localVideoPath(body?.file);
            job = startJob({ type: "split", sourceName: path.basename(source) }, options => split(source, options));
          } else {
            if (typeof body?.input !== "string") throw new Error("请粘贴视频链接或分享文案。");
            const target = parseInput(body.input);
            job = startJob({ type: "download", url: target.url, platform: target.platform }, options => download(target.url, options));
          }
          return json(response, 202, { id: job.id });
        }
      }
      json(response, 404, { error: "页面不存在。" });
    } catch (error) {
      if (response.destroyed) return;
      if (!response.headersSent) json(response, error.code === "ENOENT" ? 404 : 400, { error: error.message });
      else response.destroy();
    }
  });
  server.requestTimeout = serverMode ? 7200000 : 30000;
  server.headersTimeout = 15000;
  server.maxConnections = 128;
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port ?? serverMode?.port ?? 0, serverMode?.bind || "127.0.0.1", resolve); }); }
  catch (error) { await cache?.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  allowedOrigins = [...new Set([origin, ...(serverMode ? [serverMode.publicUrl] : [])])];
  const sweepTimer = cache ? setInterval(() => sweep().catch(error => console.error(`临时文件清理失败：${error.message}`)), 60000) : null;
  sweepTimer?.unref();
  async function close() {
    closing = true;
    clearInterval(sweepTimer);
    const running = activeJob;
    const picker = pickerPromise;
    appController.abort(new Error("程序已退出，文件选择已取消。"));
    running?.controller.abort(new Error("程序已退出，任务已取消。"));
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.allSettled([running?.promise, picker].filter(Boolean));
    await closed;
    await sweeping;
    await cache?.close();
  }
  return { server, url: origin, get outputDir() { return outputDir; }, close, sweep };
}

module.exports = { startServer };
