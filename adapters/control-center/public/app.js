const $ = (id) => document.getElementById(id);
let csrf = null;
let generation = 0;
let pending = null;
let expiryTimer = null;
let selectedDevice = null;
let busy = false;

function message(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
function clearDirectory() {
  $("devices").replaceChildren();
  $("empty").hidden = true;
  $("device-count").textContent = "—";
  $("observed-at").textContent = "Not yet refreshed";
}
function signedOut() {
  clearTimeout(expiryTimer);
  csrf = null;
  selectedDevice = null;
  $("credential").value = "";
  $("revoke-dialog").close();
  clearDirectory();
  $("dashboard").hidden = true;
  $("welcome").hidden = false;
}
function setBusy(value, text = "Loading…") {
  busy = value;
  $("loading").hidden = !value;
  $("loading-text").textContent = text;
  $("signin-button").disabled = value;
  $("refresh").disabled = value;
  $("cancel-revoke").disabled = value;
  $("confirm-revoke").disabled =
    value || !selectedDevice || $("confirmation").value !== selectedDevice;
  $("dashboard").setAttribute("aria-busy", String(value));
}
async function api(path, signal, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      signal,
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: {
        ...(options.method === "POST"
          ? { "content-type": "application/json" }
          : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      "The local service could not be reached. Check that Control Center is running, then refresh.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "The service returned an unsupported response. Refresh before trying again.",
    );
  }
  if (!response.ok) {
    const error = new Error(
      data.error?.message ??
        "The request could not be completed. Refresh before trying again.",
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
async function run(task, text, success, quiet401 = false) {
  const current = ++generation;
  pending?.abort();
  pending = new AbortController();
  const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(8000)]);
  message("");
  setBusy(true, text);
  try {
    const data = await task(signal);
    if (current === generation) success(data);
  } catch (error) {
    if (current !== generation) return;
    $("revoke-dialog").close();
    selectedDevice = null;
    clearDirectory();
    if (error.status === 401) signedOut();
    if (!(quiet401 && error.status === 401))
      message(
        error.name === "TimeoutError" || signal.aborted
          ? "The request timed out. Its result is uncertain; refresh before trying any action again."
          : error.message,
      );
  } finally {
    if (current === generation) {
      pending = null;
      setBusy(false);
    }
  }
}
function formattedDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function deviceCard(device) {
  const card = element("article", "device-card panel");
  const heading = element("div", "device-heading");
  heading.append(
    element("h2", "", device.deviceId),
    element(
      "span",
      device.revokedAt ? "badge revoked" : "badge",
      device.revokedAt ? "Revoked" : "Paired",
    ),
  );
  const details = element("dl");
  for (const [label, value] of [
    ["Connectivity", "Connectivity not reported"],
    ["Agent version", "Not reported"],
    ["Paired", formattedDate(device.pairedAt)],
    ...(device.revokedAt ? [["Revoked", formattedDate(device.revokedAt)]] : []),
  ])
    details.append(element("dt", "", label), element("dd", "", value));
  card.append(heading, details);
  if (!device.revokedAt) {
    const button = element("button", "text-button", "Revoke access");
    button.type = "button";
    button.addEventListener("click", () => {
      if (busy) return;
      selectedDevice = device.deviceId;
      $("revoke-device").textContent = selectedDevice;
      $("confirmation").value = "";
      $("confirm-revoke").disabled = true;
      $("revoke-dialog").showModal();
      $("confirmation").focus();
    });
    card.append(button);
  }
  return card;
}
function showDirectory(data) {
  csrf = data.csrfToken;
  $("credential").value = "";
  $("welcome").hidden = true;
  $("dashboard").hidden = false;
  $("devices").replaceChildren(
    ...[...data.devices]
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
      .map(deviceCard),
  );
  $("empty").hidden = data.devices.length !== 0;
  $("device-count").textContent = String(data.devices.length);
  $("observed-at").textContent = formattedDate(data.observedAt);
  $("expires-at").textContent = formattedDate(data.expiresAt);
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(
    () => {
      ++generation;
      pending?.abort();
      pending = null;
      signedOut();
      setBusy(false);
      message(
        "Your local session expired. Sign in again to refresh your device directory.",
      );
    },
    Math.max(0, Date.parse(data.expiresAt) - Date.now()),
  );
}
function refresh() {
  return run(
    (signal) => api("/api/devices", signal),
    "Refreshing the account directory…",
    showDirectory,
  );
}

$("signin-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const token = $("credential").value;
  $("credential").value = "";
  void run(
    (signal) =>
      api("/api/session", signal, { method: "POST", body: { token } }),
    "Checking relay authorization…",
    showDirectory,
  );
});
$("refresh").addEventListener("click", () => {
  void refresh();
});
$("signout").addEventListener("click", () => {
  // Start the protected request before dropping the CSRF token locally.
  void run(
    (signal) => api("/api/logout", signal, { method: "POST" }),
    "Signing out…",
    () => {},
  );
  signedOut();
});
$("confirmation").addEventListener("input", () => {
  $("confirm-revoke").disabled =
    busy || $("confirmation").value !== selectedDevice;
});
$("cancel-revoke").addEventListener("click", () => {
  $("revoke-dialog").close();
  selectedDevice = null;
});
$("revoke-dialog").addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
$("revoke-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const deviceId = selectedDevice;
  if (!deviceId || busy || $("confirmation").value !== deviceId) return;
  void run(
    (signal) =>
      api(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, signal, {
        method: "POST",
        body: { confirmDeviceId: deviceId },
      }),
    "Revoking relay access…",
    () => {
      $("revoke-dialog").close();
      selectedDevice = null;
      // GET refreshes evidence. A failed revoke is never automatically retried.
      queueMicrotask(() => {
        void refresh();
      });
    },
  );
});
$("pause-motion").addEventListener("click", () => {
  const paused = $("loading").classList.toggle("motion-paused");
  $("pause-motion").setAttribute("aria-pressed", String(paused));
  $("pause-motion").textContent = paused
    ? "Resume animation"
    : "Pause animation";
});
document.addEventListener("visibilitychange", () => {
  for (const animation of $("loading").getAnimations({ subtree: true }))
    document.hidden ? animation.pause() : animation.play();
});
void run(
  (signal) => api("/api/session", signal),
  "Checking your local session…",
  showDirectory,
  true,
);
