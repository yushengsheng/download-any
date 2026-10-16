const form = document.querySelector("#login-form");
const button = form.querySelector("button");
const errorBox = document.querySelector("#login-error");
form.addEventListener("submit", async event => {
  event.preventDefault(); button.disabled = true; errorBox.hidden = true;
  try {
    const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.querySelector("#password").value }), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "登录失败，请重试。");
    const next = new URLSearchParams(location.search).get("next");
    location.replace(next === "/toolbox" ? next : "/");
  } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
  finally { button.disabled = false; }
});
