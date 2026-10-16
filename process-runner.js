const { spawn, execFile } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

function killTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise(resolve => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: 4000 }, () => { child.kill(); resolve(); }));
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  return Promise.resolve();
}

function runProcess(command, args, { signal, timeoutMs = 30000, cwd, env, onLine, capture = true, maxOutput = 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let tail = "";
    let stopped;
    let termination;
    const stop = reason => {
      if (stopped) return;
      stopped = reason;
      termination = killTree(child);
    };
    const cancel = () => stop(signal.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => stop(new Error("下载工具运行超时，请重试。")), timeoutMs);
    timer.unref();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    for (const [stream, isOutput] of [[child.stdout, true], [child.stderr, false]]) {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      const consume = text => {
        if (stopped) return;
        if (capture && isOutput) {
          stdout += text;
          if (Buffer.byteLength(stdout) > maxOutput) stop(new Error("下载工具返回内容过多。"));
        }
        tail = (tail + text).slice(-8000);
        pending += text;
        const lines = pending.split(/\r\n|[\r\n]/);
        pending = lines.pop();
        if (pending.length > 65536) stop(new Error("下载工具返回内容过长。"));
        for (const line of lines) {
          try { if (line) onLine?.(line); } catch (error) { stop(error); }
        }
      };
      stream.on("data", chunk => consume(decoder.write(chunk)));
      stream.on("end", () => { consume(decoder.end()); try { if (pending) onLine?.(pending); } catch (error) { stop(error); } });
    }
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", async code => {
      cleanup();
      await termination;
      if (stopped) reject(stopped);
      else if (code !== 0) reject(new Error(`下载工具执行失败（${code}）：${tail.trim().slice(-1800)}`));
      else resolve(stdout);
    });
  });
}

module.exports = { runProcess };
