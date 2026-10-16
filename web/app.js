const form = document.querySelector("#download-form");
const input = document.querySelector("#video-input");
const submit = document.querySelector("#download-button");
const folder = document.querySelector("#open-folder");
const message = document.querySelector("#message");
const connection = document.querySelector("#connection");
const changeDirectory = document.querySelector("#change-directory");
const directoryDialog = document.querySelector("#directory-dialog");
const directoryInput = document.querySelector("#directory-input");
const directoryMessage = document.querySelector("#directory-message");
const isToolbox = location.pathname === "/toolbox";
const sourceFile = document.querySelector("#source-file");
const splitButton = document.querySelector("#split-button");
const chooseVideo = document.querySelector("#choose-video");
for (const section of document.querySelectorAll("[data-page]")) section.hidden = section.dataset.page !== (isToolbox ? "toolbox" : "download");
document.querySelector(`[data-nav="${isToolbox ? "toolbox" : "download"}"]`).setAttribute("aria-current", "page");
document.querySelector("#jobs-title").textContent = isToolbox ? "本次处理" : "本次下载";
if (isToolbox) {
  document.title = "Download Any · 视频工具箱";
  document.querySelector("#empty-state").textContent = "还没有处理记录，选择一段视频开始吧。";
}
let outputDir;
let defaultDir;
let directoryUnavailable = false;
let directoryWorking = false;
let token;
let submitting = false;
let busy = false;
let activeType;
let fileChoosing = false;
let lastJobs = "";
let refreshPromise;
let pollTimer;
let serverMode = false;
let maxUploadBytes;
let uploadRequest;
let pendingDownloads;
try { pendingDownloads = new Set(JSON.parse(sessionStorage.getItem("pending-downloads") || "[]")); }
catch { pendingDownloads = new Set(); }
function rememberDownloads() { try { sessionStorage.setItem("pending-downloads", JSON.stringify([...pendingDownloads].slice(-20))); } catch {} }

function showError(text) { message.textContent = text || ""; message.hidden = !text; }
async function api(url, body, timeoutMs = 10000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", "X-App-Token": token }, body: JSON.stringify(body)
  }) });
  const data = await response.json();
  if (response.status === 401) location.replace(`/login?next=${isToolbox ? "/toolbox" : "/"}`);
  if (!response.ok) throw new Error(data.error || "请求失败，请重试。");
  return data;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function updateButton() {
  const locked = !token || submitting || busy || directoryUnavailable || directoryWorking || fileChoosing;
  submit.disabled = locked;
  submit.textContent = busy ? activeType === "split" ? "其他任务进行中…" : "正在下载…" : submitting ? "正在提交…" : "开始下载 ↗";
  splitButton.disabled = locked;
  splitButton.textContent = busy ? activeType === "split" ? "正在分离…" : "其他任务进行中…" : submitting ? "正在提交…" : serverMode ? "上传并分离 ↗" : "开始分离 ↗";
  chooseVideo.disabled = !token || busy || submitting || fileChoosing || directoryWorking;
  chooseVideo.textContent = fileChoosing ? "正在选择…" : "选择视频";
  sourceFile.disabled = busy || submitting || fileChoosing;
  document.querySelector("#upload-file").disabled = busy || submitting;
  changeDirectory.disabled = !token || busy || directoryWorking || fileChoosing;
}
function renderJobs(jobs) {
  jobs = jobs.filter(job => (job.type === "split") === isToolbox);
  const serialized = JSON.stringify(jobs);
  if (serialized === lastJobs) return;
  lastJobs = serialized;
  const container = document.querySelector("#jobs");
  const expanded = new Set([...container.querySelectorAll("details[open]")].map(item => item.dataset.id));
  container.replaceChildren();
  document.querySelector("#empty-state").hidden = jobs.length > 0;
  document.querySelector("#job-count").textContent = `${jobs.length} 个任务`;
  for (const job of jobs) {
    const card = element("article", undefined, "job");
    const heading = element("div", undefined, "job-heading");
    const platform = { douyin: "抖音", bilibili: "B 站" }[job.platform];
    heading.append(element("span", `${platform ? `${platform} · ` : ""}${job.sourceName || job.result?.filename || job.url}`, "job-title"));
    heading.append(element("span", { running: isToolbox ? "处理中" : "下载中", completed: "已完成", failed: "未完成", cancelled: "已取消", expired: "已清理" }[job.status], `badge ${job.status}`));
    card.append(heading);
    if (job.error) card.append(element("p", job.error, "error"));
    if (job.status === "running") {
      const progress = element("progress");
      progress.setAttribute("aria-label", isToolbox ? "音画分离进度" : "视频下载进度");
      progress.max = job.progress?.total || 1;
      if (job.progress?.total) progress.value = job.progress.received;
      card.append(progress, element("p", job.logs.at(-1) || "正在启动解析…"));
      const cancel = element("button", "取消任务", "secondary");
      cancel.type = "button";
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        try { await api("/api/cancel", { id: job.id }); await refresh(); }
        catch (error) { showError(error.message); }
        finally { cancel.disabled = false; }
      });
      card.append(cancel);
    }
    if (job.result?.files) {
      for (const file of job.result.files) {
        const output = element("div", undefined, "output-file");
        const link = element("a", `${file.kind === "video" ? "画面文件" : "音频文件"} · ${file.filename.split(".").at(-1).toUpperCase()} · ${(file.bytes / 1024 / 1024).toFixed(1)} MB`);
        link.href = `/api/file?id=${encodeURIComponent(job.id)}&part=${file.kind}`;
        output.append(link, element("p", serverMode ? file.filename : file.file));
        card.append(output);
      }
    } else if (job.result) {
      const link = element("a", `${serverMode ? "保存到我的设备" : "另存视频"} · ${(job.result.bytes / 1024 / 1024).toFixed(1)} MB`);
      link.href = `/api/file?id=${encodeURIComponent(job.id)}`;
      if (!serverMode) card.append(element("p", `已保存到：${job.result.file}`));
      card.append(link);
    }
    if (serverMode && job.result) {
      card.append(element("p", `${job.transferredAt !== undefined ? "全部文件已传输，仍可重试下载" : "请将全部结果保存到你的设备"}；临时文件将在 ${new Date(job.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 清理。`));
      const clear = element("button", "清除服务器临时文件", "secondary");
      clear.type = "button";
      clear.addEventListener("click", async () => {
        clear.disabled = true;
        try { await api("/api/clear-job", { id: job.id }); await refresh(); }
        catch (error) { showError(error.message); clear.disabled = false; }
      });
      card.append(clear);
    }
    if (job.logs.length) {
      const details = element("details");
      details.dataset.id = job.id;
      details.open = expanded.has(job.id);
      details.append(element("summary", "查看运行记录"), element("pre", job.logs.join("\n")));
      card.append(details);
    }
    container.append(card);
  }
}
async function refreshState() {
  try {
    const state = await api("/api/state");
    token = state.token;
    serverMode = state.serverMode;
    maxUploadBytes = state.maxUploadBytes;
    for (const node of document.querySelectorAll("[data-local]")) node.hidden = serverMode;
    for (const node of document.querySelectorAll("[data-server]")) node.hidden = !serverMode;
    sourceFile.required = !serverMode;
    document.querySelector("#upload-file").required = serverMode;
    document.querySelector("#logout").hidden = !serverMode;
    document.querySelector(".local").textContent = serverMode ? "服务器版" : "本地版";
    if (serverMode) {
      document.querySelector("#download-note").textContent = "准备完成后，由浏览器保存到你的设备";
      document.querySelector("#split-note").textContent = "临时上传处理，完成后分别保存两个文件";
      document.querySelector("#upload-limit").textContent = `单个视频最大 ${Math.floor(maxUploadBytes / 1024 / 1024)} MB，原视频保留在你的设备上。`;
      document.querySelector("#footer-note").textContent = "临时处理 · 结果保存到你的设备";
    }
    busy = state.jobs.some(job => job.status === "running");
    activeType = state.jobs.find(job => job.status === "running")?.type;
    connection.textContent = serverMode ? "已登录" : "本地服务已连接";
    connection.classList.remove("offline");
    outputDir = state.outputDir;
    defaultDir = state.defaultDir;
    directoryUnavailable = Boolean(state.directoryError);
    document.querySelector("#output-dir").textContent = serverMode ? "你的设备 · 浏览器下载目录" : outputDir;
    const directoryStatus = document.querySelector("#directory-status");
    directoryStatus.textContent = state.directoryError || state.directoryWarning || (serverMode ? `结果最长保留 ${state.retentionMs / 3600000} 小时，全部传输后 ${state.downloadedRetentionMs / 60000} 分钟清理。可在浏览器设置中开启“下载前询问保存位置”。` : "自动记住保存位置，下次打开继续使用。");
    directoryStatus.classList.toggle("error", directoryUnavailable);
    document.querySelector("#browser-info").textContent = isToolbox ? "音画分离 · 保留原始质量" : state.browsers[0] || "解析浏览器将在下载抖音时按需安装";
    folder.disabled = directoryUnavailable;
    renderJobs(state.jobs);
    for (const job of state.jobs) {
      if (!pendingDownloads.has(job.id) || job.status === "running") continue;
      pendingDownloads.delete(job.id); rememberDownloads();
      if (serverMode && job.status === "completed" && job.type === "download") {
        const link = element("a"); link.href = `/api/file?id=${encodeURIComponent(job.id)}`;
        link.download = job.result.filename; document.body.append(link); link.click(); link.remove();
      }
    }
  } catch {
    token = null;
    connection.textContent = serverMode ? "连接已断开，请刷新重试" : "连接已断开，请重新运行启动器";
    connection.classList.add("offline");
    folder.disabled = true;
  }
  updateButton();
}
function refresh() {
  if (document.hidden) return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  clearTimeout(pollTimer);
  refreshPromise = refreshState().finally(() => {
    refreshPromise = null;
    if (!document.hidden) pollTimer = setTimeout(refresh, busy ? 1000 : 10000);
  });
  return refreshPromise;
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  submitting = true;
  updateButton();
  showError();
  try {
    const job = await api("/api/jobs", { input: input.value.trim() });
    if (serverMode) { pendingDownloads.add(job.id); rememberDownloads(); }
    await refresh();
  }
  catch (error) { showError(error.message); }
  finally { submitting = false; updateButton(); }
});
document.querySelector("#split-form").addEventListener("submit", async event => {
  event.preventDefault();
  submitting = true;
  updateButton();
  showError();
  try {
    if (serverMode) {
      const file = document.querySelector("#upload-file").files[0];
      if (!file || !file.size || file.size > maxUploadBytes) throw new Error("请选择大小在限制范围内的视频文件。");
      await uploadVideo(file);
    } else await api("/api/toolbox/split", { file: sourceFile.value.trim() });
    await refresh();
  }
  catch (error) { showError(error.message); }
  finally { submitting = false; updateButton(); }
});
async function uploadVideo(file) {
  document.querySelector("#upload-status").hidden = false;
  document.querySelector("#upload-text").textContent = "正在上传视频…";
  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); uploadRequest = xhr;
      xhr.open("POST", "/api/toolbox/upload"); xhr.timeout = 7200000;
      xhr.setRequestHeader("Content-Type", "application/octet-stream"); xhr.setRequestHeader("X-App-Token", token);
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name)); xhr.setRequestHeader("X-File-Size", String(file.size));
      xhr.upload.onprogress = event => { if (event.lengthComputable) document.querySelector("#upload-text").textContent = `正在上传视频：${Math.round(event.loaded / event.total * 100)}%`; };
      xhr.onload = () => {
        let data;
        try { data = JSON.parse(xhr.responseText); } catch { reject(new Error("服务器响应无法识别，请重试。")); return; }
        if (xhr.status === 401) location.replace("/login?next=/toolbox");
        if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || "上传失败，请重试。"));
      };
      xhr.onerror = () => reject(new Error("上传连接中断，请检查网络后重试。"));
      xhr.ontimeout = () => reject(new Error("上传超时，请重试。"));
      xhr.onabort = () => reject(new Error("上传已取消。"));
      xhr.send(file);
    });
  } finally { uploadRequest = null; document.querySelector("#upload-status").hidden = true; }
}
document.querySelector("#cancel-upload").addEventListener("click", () => uploadRequest?.abort());
document.querySelector("#logout").addEventListener("click", async () => {
  try { await api("/api/logout", {}); location.replace("/login"); } catch (error) { showError(error.message); }
});
chooseVideo.addEventListener("click", async () => {
  fileChoosing = true;
  updateButton();
  showError();
  try {
    const result = await api("/api/choose-video", {}, 310000);
    if (result.file) sourceFile.value = result.file;
  } catch (error) { showError(error.message); }
  finally { fileChoosing = false; updateButton(); }
});
folder.addEventListener("click", async () => {
  try { await api("/api/open-folder", {}); showError(); }
  catch (error) { showError(error.message); }
});
changeDirectory.addEventListener("click", () => {
  directoryInput.value = outputDir;
  directoryMessage.hidden = true;
  directoryDialog.showModal();
});
async function directoryAction(action) {
  directoryWorking = true;
  directoryMessage.hidden = true;
  for (const id of ["browse-directory", "save-directory", "cancel-directory", "reset-directory"]) document.querySelector(`#${id}`).disabled = true;
  directoryInput.disabled = true;
  updateButton();
  try { await action(); }
  catch (error) { directoryMessage.textContent = error.message; directoryMessage.hidden = false; }
  finally {
    directoryWorking = false;
    for (const id of ["browse-directory", "save-directory", "cancel-directory", "reset-directory"]) document.querySelector(`#${id}`).disabled = false;
    directoryInput.disabled = false;
    updateButton();
  }
}
document.querySelector("#browse-directory").addEventListener("click", () => directoryAction(async () => {
  const result = await api("/api/choose-folder", {}, 310000);
  if (result.directory) directoryInput.value = result.directory;
}));
document.querySelector("#directory-form").addEventListener("submit", event => {
  event.preventDefault();
  const directory = directoryInput.value;
  directoryAction(async () => {
    await api("/api/directory", { directory });
    directoryDialog.close();
    showError();
    if (refreshPromise) await refreshPromise;
    await refresh();
  });
});
document.querySelector("#reset-directory").addEventListener("click", () => { directoryInput.value = defaultDir; });
document.querySelector("#cancel-directory").addEventListener("click", () => directoryDialog.close());
directoryDialog.addEventListener("cancel", event => { if (directoryWorking) event.preventDefault(); });
document.addEventListener("visibilitychange", () => {
  clearTimeout(pollTimer);
  if (!document.hidden) refresh();
});
refresh();
