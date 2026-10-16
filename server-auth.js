const { randomBytes, scrypt, timingSafeEqual, createHash } = require("node:crypto");
const { promisify } = require("node:util");
const derive = promisify(scrypt);
const cookieName = "download_any_session";

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 512) throw new Error("访问密码须为 12～512 字节，至少 12 个字符。");
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { algorithm: "scrypt", salt, hash: hash.toString("hex") };
}

function validateCredentials(value) {
  if (value?.algorithm !== "scrypt" || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error("服务器密码配置无效，请重新设置访问密码。");
}

function createAuth(credentials, { secure = false, now = Date.now, lifetimeMs = 12 * 3600000, maxAttempts = 6 } = {}) {
  validateCredentials(credentials);
  const sessions = new Map();
  const attempts = new Map();
  let checking = 0;
  let globalAttempts = [];
  const digest = value => createHash("sha256").update(value).digest("hex");
  function prune() {
    const time = now();
    for (const [key, session] of sessions) if (session.expiresAt <= time) sessions.delete(key);
    for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
    globalAttempts = globalAttempts.filter(time => time > now() - 60000);
  }
  function cookie(value, maxAge = lifetimeMs / 1000) {
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge)}${secure ? "; Secure" : ""}`;
  }
  function getSession(header = "") {
    prune();
    const value = header.split(";").map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? sessions.get(digest(value)) : undefined;
  }
  async function login(password, address) {
    prune();
    const key = String(address).slice(0, 128);
    const previous = attempts.get(key) || { count: 0, until: now() + 15 * 60000 };
    if (checking >= 2 || previous.count >= maxAttempts || globalAttempts.length >= 30) return { status: 429, error: "尝试次数过多，请稍后再试。" };
    if (attempts.size >= 512 && !attempts.has(key)) attempts.delete(attempts.keys().next().value);
    previous.count++;
    attempts.set(key, previous);
    globalAttempts.push(now());
    checking++;
    try {
      if (typeof password !== "string" || Buffer.byteLength(password) > 512) return { status: 401, error: "密码不正确。" };
      const actual = await derive(password, credentials.salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      if (!timingSafeEqual(actual, Buffer.from(credentials.hash, "hex"))) return { status: 401, error: "密码不正确。" };
      attempts.delete(key);
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
      const secret = randomBytes(32).toString("base64url");
      const session = { token: randomBytes(24).toString("hex"), expiresAt: now() + lifetimeMs };
      sessions.set(digest(secret), session);
      return { status: 200, cookie: cookie(secret) };
    } finally { checking--; }
  }
  function logout(header) {
    const session = getSession(header);
    for (const [key, value] of sessions) if (value === session) sessions.delete(key);
    return cookie("", 0);
  }
  return { login, getSession, logout };
}

module.exports = { hashPassword, validateCredentials, createAuth };
