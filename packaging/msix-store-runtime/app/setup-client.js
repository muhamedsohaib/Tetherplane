const form = document.getElementById("setup");
const feedback = document.getElementById("feedback");
const code = document.getElementById("code");
const status = document.getElementById("status");
const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const headers = { "content-type": "application/json", "x-tetherplane-setup": token };
async function call(path, data, method = "POST") {
  const response = await fetch(path, { method, headers, body: method === "POST" ? JSON.stringify(data) : undefined, credentials: "omit", cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Operation failed");
  return body;
}
function showError(error) { feedback.textContent = error instanceof Error ? error.message : "Setup operation failed."; }
form.deviceId.value = "tp-" + crypto.randomUUID().slice(0, 8);
form.addEventListener("submit", async (event) => {
  event.preventDefault(); feedback.textContent = "";
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await call("/api/pair", values);
    document.getElementById("challenge").hidden = false;
    code.textContent = result.userCode;
    feedback.textContent = "Pairing code expires: " + new Date(result.expiresAt).toLocaleString();
  } catch(error) { showError(error); }
});
async function start() {
  feedback.textContent = "";
  try {
    const result = await call("/api/start", { confirmation: "I APPROVED THIS DEVICE" });
    status.textContent = result.state + " — relay authentication not yet independently verified.";
    feedback.textContent = "Use an owner-authenticated Tetherplane client to confirm device.status.";
  } catch(error) { showError(error); }
}
document.getElementById("start").addEventListener("click", start);
document.getElementById("resumeStart").addEventListener("click", start);
document.getElementById("stop").addEventListener("click", async () => {
  try { const r = await call("/api/stop", {}); status.textContent = r.state; }
  catch(error) { showError(error); }
});
async function refresh() {
  try {
    const r = await call("/api/status", null, "GET");
    status.textContent = r.state + " — connection not verified";
    if (r.lastError) feedback.textContent = r.lastError;
    if (r.hasSavedIdentity) { form.hidden = true; document.getElementById("resume").hidden = false; }
  } catch(error) { showError(error); }
}
void refresh();
setInterval(refresh, 5000);
