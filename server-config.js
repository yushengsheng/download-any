const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isIP } = require("node:net");
const { hashPassword, validateCredentials } = require("./server-auth");

function validateConfig(value, file) {
  validateCredentials(value.credentials);
  const url = new URL(value.publicUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("publicUrl 必须是完整的 HTTP(S) 访问地址，不包含路径或密码。");
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("服务器端口须在 1～65535 之间。");
  if (value.bind !== undefined && (typeof value.bind !== "string" || !isIP(value.bind))) throw new Error("bind 必须是有效的监听 IP 地址。");
  for (const [name, fallback, minimum, maximum] of [["retentionHours", 2, 0.1, 168], ["downloadedRetentionMinutes", 5, 0, 60], ["maxFileMiB", 2048, 1, 20480], ["maxCacheMiB", 10240, 64, 1024000]]) {
    value[name] ??= fallback;
    if (typeof value[name] !== "number" || !Number.isFinite(value[name]) || value[name] < minimum || value[name] > maximum) throw new Error(`${name} 配置不正确。`);
  }
  const dataDir = path.resolve(path.dirname(file), value.dataDir || ".");
  return { ...value, publicUrl: url.origin, bind: value.bind || "0.0.0.0", dataDir,
    cacheDir: path.join(dataDir, "cache"), retentionMs: value.retentionHours * 3600000, downloadedRetentionMs: value.downloadedRetentionMinutes * 60000,
    maxFileBytes: Math.floor(value.maxFileMiB * 1024 * 1024), maxCacheBytes: Math.floor(value.maxCacheMiB * 1024 * 1024) };
}

async function loadServerConfig(file) {
  const absolute = path.resolve(file);
  return validateConfig(JSON.parse(await fs.readFile(absolute, "utf8")), absolute);
}

async function configure(args = process.argv.slice(2)) {
  const fileIndex = args.indexOf("--config");
  const file = path.resolve(fileIndex >= 0 ? args[fileIndex + 1] : ".server-data/server.json");
  let value;
  try { value = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const reset = args.includes("--reset-password");
  const env = process.env;
  value ||= { port: Number(env.DOWNLOAD_ANY_PORT || 8686), publicUrl: env.DOWNLOAD_ANY_PUBLIC_URL || "http://127.0.0.1:8686", dataDir: "." };
  if (env.DOWNLOAD_ANY_PORT) value.port = Number(env.DOWNLOAD_ANY_PORT);
  if (env.DOWNLOAD_ANY_PUBLIC_URL) value.publicUrl = env.DOWNLOAD_ANY_PUBLIC_URL;
  if (env.DOWNLOAD_ANY_BIND) value.bind = env.DOWNLOAD_ANY_BIND;
  let password = env.DOWNLOAD_ANY_PASSWORD;
  const passwordProvided = args.includes("--password-stdin") || password !== undefined;
  if (args.includes("--password-stdin")) {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1024) throw new Error("密码过长。"); }
    password = input.replace(/[\r\n]+$/, "");
  }
  if (!value.credentials || reset || passwordProvided) {
    if (!passwordProvided) throw new Error("请自定义访问密码：部署时填写 IP、端口、密码，或使用 --password-stdin 输入密码。");
    value.credentials = await hashPassword(password);
  }
  validateConfig(value, file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally { await fs.rm(temporary, { force: true }); }
  console.log(`服务器配置已保存：${file}`);
  if (passwordProvided) console.log("自定义访问密码已保存（仅存储密码哈希）。");
}

if (require.main === module) configure().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { loadServerConfig, validateConfig, configure };
