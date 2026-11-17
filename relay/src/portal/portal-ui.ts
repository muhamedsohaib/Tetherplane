import { createHash } from "node:crypto";

const PORTAL_STYLE = `
    :root {
      --bg: #0b0f17;
      --surface: #131b2e;
      --surface-elevated: #1a2540;
      --border: #273556;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --success: #22c55e;
      --success-bg: rgba(34, 197, 94, 0.14);
      --warning: #f59e0b;
      --warning-bg: rgba(245, 158, 11, 0.15);
      --danger: #ef4444;
      --danger-bg: rgba(239, 68, 68, 0.16);
      --radius: 12px;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      --mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      max-width: 100vw;
      overflow-x: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
    }

    .portal-shell {
      max-width: 1240px;
      margin: 0 auto;
      padding: 20px 16px 64px;
    }

    .topbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-badge {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, #38bdf8, #6366f1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      color: #0b0f17;
      font-size: 18px;
      flex-shrink: 0;
    }

    .brand h1 {
      margin: 0;
      font-size: 1.25rem;
      letter-spacing: -0.02em;
    }

    .brand p {
      margin: 2px 0 0;
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    .auth-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }

    .hidden {
      display: none !important;
    }

    input[type="password"],
    input[type="text"],
    select {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 0.875rem;
      min-width: 0;
    }

    button {
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--surface-elevated);
      color: var(--text);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      transition: background 0.15s ease, border-color 0.15s ease;
    }

    button:hover {
      border-color: var(--primary);
    }

    button.primary {
      background: var(--primary);
      color: #090d16;
      border-color: transparent;
    }

    button.primary:hover {
      background: var(--primary-hover);
    }

    button.danger {
      background: var(--danger-bg);
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.45);
    }

    button.danger:hover {
      background: var(--danger);
      color: #fff;
    }

    .summary-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }

    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
    }

    .stat-label {
      font-size: 0.78rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .stat-value {
      font-size: 1.45rem;
      font-weight: 700;
      margin-top: 4px;
    }

    .stat-value-compact {
      font-size: 1.05rem;
    }

    .stat-value-primary {
      color: var(--primary);
    }

    .security-active {
      color: var(--success);
    }

    .security-lockdown {
      color: var(--danger);
    }

    .global-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      margin-bottom: 22px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .global-subtitle {
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    .global-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .devices-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .device-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .device-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .device-title {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .device-title h3 {
      margin: 0;
      font-size: 1.1rem;
      overflow-wrap: anywhere;
    }

    .card-meta-row {
      font-size: 0.8rem;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }

    .device-actions-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .pill.online {
      background: var(--success-bg);
      color: #4ade80;
    }

    .pill.offline {
      background: rgba(148, 163, 184, 0.15);
      color: var(--text-muted);
    }

    .pill.applied {
      background: var(--success-bg);
      color: #4ade80;
    }

    .pill.pending {
      background: var(--warning-bg);
      color: #fbbf24;
    }

    .pill.failed,
    .pill.lockdown {
      background: var(--danger-bg);
      color: #f87171;
    }

    .family-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .family-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 11px;
      gap: 8px;
    }

    .family-toggle.granted {
      border-color: rgba(56, 189, 248, 0.45);
    }

    .family-name {
      font-weight: 600;
      font-size: 0.86rem;
      text-transform: capitalize;
    }

    .family-sub {
      font-size: 0.72rem;
      color: var(--text-muted);
      display: block;
    }

    .switch-btn {
      min-width: 54px;
      padding: 5px 10px;
      font-size: 0.76rem;
      border-radius: 999px;
    }

    .switch-btn.on {
      background: var(--success);
      color: #06210f;
      border-color: transparent;
    }

    .switch-btn.off {
      background: rgba(148, 163, 184, 0.18);
      color: var(--text-muted);
    }

    .unavailable-banner {
      background: var(--warning-bg);
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 0.8rem;
      color: #fde68a;
    }

    .unavailable-item + .unavailable-item {
      margin-top: 4px;
    }

    .status-banner-outer {
      margin-bottom: 14px;
    }

    details.advanced-box {
      border-top: 1px solid var(--border);
      padding-top: 10px;
    }

    details.advanced-box-spaced {
      margin-top: 12px;
    }

    details.advanced-box summary {
      cursor: pointer;
      font-size: 0.83rem;
      color: var(--primary);
      font-weight: 600;
      user-select: none;
    }

    .op-rules-wrap {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .op-rules-note {
      font-size: 0.78rem;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .op-rule-input-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .op-rule-input {
      flex: 1;
    }

    .section-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
      gap: 16px;
      margin-top: 18px;
    }

    .panel-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
    }

    .panel-card h2 {
      margin: 0 0 12px;
      font-size: 1rem;
    }

    .identities-list {
      margin-bottom: 12px;
      font-size: 0.84rem;
      color: var(--text-muted);
    }

    .op-form-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
    }

    .audit-scroll {
      max-height: 280px;
      overflow-y: auto;
    }

    .snapshots-scroll {
      margin-top: 10px;
      max-height: 220px;
      overflow-y: auto;
    }

    .muted-note {
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    .list-item {
      border-bottom: 1px solid var(--border);
      padding: 10px 0;
      font-size: 0.83rem;
      overflow-wrap: anywhere;
    }

    .list-item:last-child {
      border-bottom: none;
    }

    .snapshot-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .audit-meta {
      color: var(--text-muted);
      font-size: 0.78rem;
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(5, 8, 15, 0.76);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
      z-index: 100;
    }

    .modal-backdrop.active {
      display: flex;
    }

    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      max-width: 440px;
      width: 100%;
      padding: 20px;
    }

    .modal h3 {
      margin: 0 0 8px;
    }

    .modal-desc {
      font-size: 0.88rem;
      color: var(--text-muted);
    }

    .modal-reason-input {
      width: 100%;
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 16px;
    }

    code {
      font-family: var(--mono);
    }

    @media (max-width: 600px) {
      .family-grid {
        grid-template-columns: 1fr;
      }
      .devices-grid,
      .section-grid {
        grid-template-columns: 1fr;
      }
      .topbar {
        flex-direction: column;
        align-items: stretch;
      }
    }
`;

const PORTAL_SCRIPT = `
    (function () {
      const tokenInput = document.getElementById("token-input");
      const connectBtn = document.getElementById("connect-btn");
      const refreshBtn = document.getElementById("refresh-btn");
      const logoutBtn = document.getElementById("logout-btn");
      const authStateBadge = document.getElementById("auth-state-badge");
      const statusBanner = document.getElementById("status-banner");

      let csrfToken = null;
      let authenticatedOwner = null;
      let currentOverview = null;
      let pendingModalAction = null;
      let eventSource = null;
      let pendingFallbackTimer = null;
      let pendingFallbackAttempts = 0;
      let overviewInFlight = false;
      let overviewQueued = false;
      const openAdvancedDevices = new Set();

      function createEl(tag, options, children) {
        const node = document.createElement(tag);
        if (options) {
          if (options.className) node.className = options.className;
          if (options.text !== undefined) node.textContent = String(options.text);
          if (options.type) node.type = options.type;
          if (options.attrs) {
            Object.keys(options.attrs).forEach(function (k) {
              node.setAttribute(k, String(options.attrs[k]));
            });
          }
          if (options.dataset) {
            Object.keys(options.dataset).forEach(function (k) {
              node.dataset[k] = String(options.dataset[k]);
            });
          }
        }
        if (Array.isArray(children)) {
          children.forEach(function (child) {
            if (child === null || child === undefined) return;
            if (typeof child === "string") {
              node.appendChild(document.createTextNode(child));
            } else {
              node.appendChild(child);
            }
          });
        }
        return node;
      }

      function stopLiveUpdates() {
        if (eventSource) {
          try {
            eventSource.close();
          } catch {
            // ignore close error
          }
          eventSource = null;
        }
        if (pendingFallbackTimer) {
          clearInterval(pendingFallbackTimer);
          pendingFallbackTimer = null;
        }
        pendingFallbackAttempts = 0;
      }

      function startLiveUpdates() {
        if (!authenticatedOwner || typeof EventSource !== "function") return;
        if (eventSource) return;
        const es = new EventSource("/portal/api/events", {
          withCredentials: true,
        });
        es.addEventListener("overview", function () {
          void loadOverview();
        });
        es.addEventListener("session_expired", function () {
          setSignedOutUi("Portal session expired. Submit your owner token to connect.");
        });
        eventSource = es;
      }

      function syncPendingFallback(devices) {
        const hasPendingOnline =
          Boolean(authenticatedOwner) &&
          devices.some(function (d) {
            return Boolean(d.online) && d.syncStatus === "pending";
          });
        if (!hasPendingOnline) {
          if (pendingFallbackTimer) {
            clearInterval(pendingFallbackTimer);
            pendingFallbackTimer = null;
          }
          pendingFallbackAttempts = 0;
          return;
        }
        if (pendingFallbackTimer) return;
        pendingFallbackAttempts = 0;
        pendingFallbackTimer = setInterval(function () {
          pendingFallbackAttempts += 1;
          if (!authenticatedOwner || pendingFallbackAttempts > 15) {
            clearInterval(pendingFallbackTimer);
            pendingFallbackTimer = null;
            return;
          }
          void loadOverview();
        }, 1000);
      }

      function setSignedOutUi(notice) {
        stopLiveUpdates();
        csrfToken = null;
        authenticatedOwner = null;
        currentOverview = null;
        openAdvancedDevices.clear();
        authStateBadge.textContent = "Not Signed In";
        authStateBadge.className = "pill offline";
        logoutBtn.classList.add("hidden");
        tokenInput.classList.remove("hidden");
        connectBtn.classList.remove("hidden");

        const container = document.getElementById("devices-container");
        container.replaceChildren(
          createEl("div", {
            className: "panel-card",
            text: "Enter your owner token above to start an authenticated portal session.",
          }),
        );
        document.getElementById("stat-devices").textContent = "0";
        document.getElementById("stat-confirmed").textContent = "0";
        const secEl = document.getElementById("stat-security");
        secEl.textContent = "Active";
        secEl.className = "stat-value stat-value-compact security-active";
        document.getElementById("identities-container").replaceChildren(
          createEl("div", { className: "muted-note", text: "No active identity telemetry yet." }),
        );
        document.getElementById("audit-container").replaceChildren(
          createEl("div", { className: "muted-note", text: "No audit events loaded." }),
        );
        document.getElementById("snapshots-container").replaceChildren();
        if (notice) showBanner(notice);
      }

      function setSignedInUi(ownerPrincipalId) {
        authenticatedOwner = ownerPrincipalId;
        authStateBadge.textContent = "Owner: " + ownerPrincipalId;
        authStateBadge.className = "pill online";
        logoutBtn.classList.remove("hidden");
        startLiveUpdates();
      }

      async function apiCall(path, method, body) {
        const effectiveMethod = method || "GET";
        const headers = { Accept: "application/json" };
        if (body !== undefined) {
          headers["Content-Type"] = "application/json";
        }
        if (effectiveMethod !== "GET" && effectiveMethod !== "HEAD" && csrfToken) {
          headers["X-Tetherplane-Csrf"] = csrfToken;
        }
        const res = await fetch(path, {
          method: effectiveMethod,
          credentials: "same-origin",
          headers: headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (res.status === 401) {
          setSignedOutUi("Portal session is missing or expired. Submit your owner token to connect.");
          throw new Error((data.error && data.error.message) || "HTTP 401");
        }
        if (!res.ok) {
          throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
        }
        return data;
      }

      function showBanner(msg) {
        if (!msg) {
          statusBanner.textContent = "";
          statusBanner.classList.add("hidden");
          return;
        }
        statusBanner.textContent = msg;
        statusBanner.classList.remove("hidden");
      }

      async function connectSession() {
        const raw = tokenInput.value.trim();
        if (!raw) {
          showBanner("Enter an owner bearer token to connect.");
          return;
        }
        tokenInput.value = "";
        try {
          showBanner("");
          const res = await fetch("/portal/api/session", {
            method: "POST",
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              Authorization: "Bearer " + raw,
            },
          });
          const text = await res.text();
          const data = text ? JSON.parse(text) : {};
          if (!res.ok || !data.authenticated) {
            throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
          }
          csrfToken = data.csrfToken || null;
          setSignedInUi(data.ownerPrincipalId || "owner");
          await loadOverview();
        } catch (err) {
          showBanner("Authentication failed: " + err.message);
        }
      }

      async function restoreSession() {
        try {
          const res = await fetch("/portal/api/session", {
            method: "GET",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          });
          if (!res.ok) return;
          const data = await res.json();
          if (data && data.authenticated) {
            csrfToken = data.csrfToken || null;
            setSignedInUi(data.ownerPrincipalId || "owner");
            await loadOverview();
          }
        } catch (err) {
          showBanner("Portal notice: " + err.message);
        }
      }

      async function signOut() {
        try {
          await apiCall("/portal/api/session/logout", "POST", {});
        } catch {
          // Always transition UI cleanly to signed-out even if session already expired
        }
        setSignedOutUi("");
      }

      async function loadOverview() {
        if (!authenticatedOwner) return;
        if (overviewInFlight) {
          overviewQueued = true;
          return;
        }
        overviewInFlight = true;
        try {
          do {
            overviewQueued = false;
            showBanner("");
            const data = await apiCall("/portal/api/overview", "GET");
            if (!authenticatedOwner) return;
            currentOverview = data;
            renderOverview(data);
            syncPendingFallback(data.devices || []);
          } while (overviewQueued && authenticatedOwner);
        } catch (err) {
          if (authenticatedOwner) {
            showBanner("Portal notice: " + err.message);
          }
        } finally {
          overviewInFlight = false;
        }
      }

      function formatTelemetryInfo(status) {
        if (!status) return "Awaiting telemetry";
        const platform = status.os
          ? status.arch
            ? status.os + "/" + status.arch
            : status.os
          : status.platform || "unknown";
        const version = status.agent_version || status.version || "0.1.0";
        const mode = status.policy_mode ? " • " + status.policy_mode : "";
        return platform + " • v" + version + mode;
      }

      function renderOverview(data) {
        const draftOpRules = {};
        document.querySelectorAll(".device-card[data-device-id]").forEach(function (cardEl) {
          const id = cardEl.dataset.deviceId;
          const detailsEl = cardEl.querySelector("details.advanced-box");
          if (id && detailsEl) {
            if (detailsEl.open) openAdvancedDevices.add(id);
            else openAdvancedDevices.delete(id);
          }
          const inputEl = cardEl.querySelector("[data-role='op-rule-input']");
          if (id && inputEl && inputEl.value) {
            draftOpRules[id] = inputEl.value;
          }
        });

        const devices = data.devices || [];
        document.getElementById("stat-devices").textContent = String(devices.length);
        const confirmedCount = devices.filter(function (d) {
          return d.online && d.confirmedByDevice;
        }).length;
        document.getElementById("stat-confirmed").textContent = String(confirmedCount);

        const anyLockdown = devices.some(function (d) { return Boolean(d.emergencyLockdown); });
        const secEl = document.getElementById("stat-security");
        secEl.textContent = anyLockdown ? "LOCKDOWN" : "Active";
        secEl.className =
          "stat-value stat-value-compact " +
          (anyLockdown ? "security-lockdown" : "security-active");

        const container = document.getElementById("devices-container");
        if (devices.length === 0) {
          container.replaceChildren(
            createEl("div", {
              className: "panel-card",
              text: "No paired devices found for this owner account.",
            }),
          );
          renderIdentities(data);
          renderAuditAndSnapshots(data);
          return;
        }

        const cards = devices.map(function (dev) {
          const card = createEl("article", {
            className: "device-card",
            dataset: { deviceId: dev.deviceId },
          });

          const syncLabel = dev.emergencyLockdown
            ? "Emergency Lockdown"
            : dev.syncStatus === "failed"
              ? "Sync Rejected"
              : dev.syncStatus === "applied"
                ? "Confirmed Active (v" + dev.appliedRevision + ")"
                : "Pending Device Ack (v" + dev.desiredRevision + ")";
          const syncClass = dev.emergencyLockdown
            ? "lockdown"
            : dev.syncStatus === "failed"
              ? "failed"
              : dev.syncStatus === "applied"
                ? "applied"
                : "pending";

          const header = createEl("div", { className: "device-header" }, [
            createEl("div", { className: "device-title" }, [
              createEl("h3", { text: dev.deviceId }),
              createEl("span", {
                className: "pill " + (dev.online ? "online" : "offline"),
                text: dev.online ? "Online" : "Offline",
              }),
            ]),
            createEl("span", {
              className: "pill " + syncClass,
              dataset: { syncBadge: dev.deviceId },
              text: syncLabel,
            }),
          ]);

          const profileId =
            (dev.policy && dev.policy.owner_policy && dev.policy.owner_policy.profile_id) ||
            "universal";
          const metaRow = createEl("div", { className: "card-meta-row" }, [
            createEl("span", null, [
              "Health: ",
              createEl("strong", { text: dev.agentHealth }),
              " (" + formatTelemetryInfo(dev.status) + ")",
            ]),
            createEl("span", null, [
              "Profile: ",
              createEl("strong", { text: profileId }),
            ]),
          ]);

          card.appendChild(header);
          card.appendChild(metaRow);

          if (dev.lastAckError) {
            card.appendChild(
              createEl("div", { className: "unavailable-banner" }, [
                createEl("strong", { text: "Sync error: " }),
                String(dev.lastAckError),
              ]),
            );
          }

          if (Array.isArray(dev.unavailableCapabilities) && dev.unavailableCapabilities.length > 0) {
            const unavailBanner = createEl("div", { className: "unavailable-banner" });
            dev.unavailableCapabilities.forEach(function (u) {
              unavailBanner.appendChild(
                createEl("div", { className: "unavailable-item" }, [
                  createEl("strong", { text: u.name + " unavailable: " }),
                  String(u.reason || "Provider unavailable"),
                ]),
              );
            });
            card.appendChild(unavailBanner);
          }

          const familyGrid = createEl("div", { className: "family-grid" });
          (dev.familySummaries || []).forEach(function (fam) {
            const isOn = Boolean(fam.granted);
            const policyCount = Array.isArray(fam.policyGrantedOperations)
              ? fam.policyGrantedOperations.length
              : fam.grantedOperations.length;
            const subText =
              !dev.online
                ? "Offline (" + policyCount + " policy-granted)"
                : !fam.providerAvailable
                  ? "Unavailable (" + policyCount + " policy-granted)"
                  : fam.grantedOperations.length + "/" + fam.availableOperations.length + " ops active";
            const row = createEl(
              "div",
              {
                className: "family-toggle" + (isOn ? " granted" : ""),
                ...(fam.unavailableReason ? { attrs: { title: fam.unavailableReason } } : {}),
              },
              [
                createEl("div", null, [
                  createEl("span", { className: "family-name", text: fam.family }),
                  createEl("span", { className: "family-sub", text: subText }),
                ]),
                createEl("button", {
                  type: "button",
                  className: "switch-btn " + (isOn ? "on" : "off"),
                  text: isOn ? "ON" : "OFF",
                  dataset: {
                    action: "toggle-family",
                    device: dev.deviceId,
                    family: fam.family,
                    currentlyOn: isOn ? "1" : "0",
                  },
                }),
              ],
            );
            familyGrid.appendChild(row);
          });
          card.appendChild(familyGrid);

          const actionsRow = createEl("div", { className: "device-actions-row" }, [
            createEl("button", {
              type: "button",
              text: "Grant All (Universal)",
              dataset: { action: "device-profile", device: dev.deviceId, profile: "universal" },
            }),
            createEl("button", {
              type: "button",
              text: "Read-Only",
              dataset: { action: "device-profile", device: dev.deviceId, profile: "read_only" },
            }),
            createEl("button", {
              type: "button",
              text: "Revoke All",
              dataset: { action: "device-profile", device: dev.deviceId, profile: "lockdown" },
            }),
          ]);
          card.appendChild(actionsRow);

          const deniedCaps =
            (dev.policy && dev.policy.owner_policy && dev.policy.owner_policy.denied_capabilities) ||
            [];
          const ruleInput = createEl("input", {
            type: "text",
            className: "op-rule-input",
            attrs: { placeholder: "e.g. filesystem.write" },
            dataset: { role: "op-rule-input" },
          });
          if (draftOpRules[dev.deviceId]) {
            ruleInput.value = draftOpRules[dev.deviceId];
          }
          const detailsBox = createEl("details", { className: "advanced-box" }, [
            createEl("summary", {
              text: "Advanced Operation Rules & Explicit Denies (" + deniedCaps.length + ")",
            }),
            createEl("div", { className: "op-rules-wrap" }, [
              createEl("div", {
                className: "op-rules-note",
                text:
                  "Explicitly denied operations override inherited universal grants: " +
                  (deniedCaps.length ? deniedCaps.join(", ") : "None"),
              }),
              createEl("div", { className: "op-rule-input-row" }, [
                ruleInput,
                createEl("button", {
                  type: "button",
                  text: "Deny Op",
                  dataset: { action: "deny-op", device: dev.deviceId },
                }),
                createEl("button", {
                  type: "button",
                  text: "Allow Op",
                  dataset: { action: "allow-op", device: dev.deviceId },
                }),
              ]),
            ]),
          ]);
          if (openAdvancedDevices.has(dev.deviceId)) {
            detailsBox.open = true;
          }
          card.appendChild(detailsBox);
          return card;
        });

        container.replaceChildren.apply(container, cards);
        renderIdentities(data);
        renderAuditAndSnapshots(data);
      }

      function renderIdentities(data) {
        const container = document.getElementById("identities-container");
        const usage = data.identityUsage || [];
        const operators = data.operators || [];
        const nodes = [];

        nodes.push(
          createEl("div", { className: "list-item" }, [
            createEl("strong", { text: "Owner: " }),
            String(data.ownerPrincipalId || ""),
            " ",
            createEl("span", { className: "pill applied", text: "Universal Default" }),
          ]),
        );

        operators.forEach(function (op) {
          nodes.push(
            createEl("div", { className: "list-item" }, [
              createEl("strong", { text: "Operator: " }),
              String(op.principalId || "") + " (" + String(op.displayName || "") + ")",
            ]),
          );
        });

        usage.forEach(function (u) {
          nodes.push(
            createEl("div", { className: "list-item" }, [
              createEl("strong", { text: u.principalId }),
              " (" + String(u.role) + ") on ",
              createEl("code", { text: u.deviceId }),
              ": " +
                String(u.authorizedCount) +
                " allowed, " +
                String(u.deniedCount) +
                " denied • ops: " +
                (Array.isArray(u.capabilitiesUsed) ? u.capabilitiesUsed.join(", ") : ""),
            ]),
          );
        });

        container.replaceChildren.apply(container, nodes);
      }

      function renderAuditAndSnapshots(data) {
        const auditEl = document.getElementById("audit-container");
        const events = data.auditHistory || [];
        if (events.length === 0) {
          auditEl.replaceChildren(
            createEl("div", { className: "muted-note", text: "No audit events recorded yet." }),
          );
        } else {
          const eventNodes = events.slice(0, 15).map(function (ev) {
            const topRow = createEl("div", null, [
              createEl("strong", { text: ev.action }),
              ev.deviceId ? " on " : "",
              ev.deviceId ? createEl("code", { text: ev.deviceId }) : null,
              " ",
              createEl("span", {
                className:
                  "pill " +
                  (ev.deliveryStatus === "confirmed_by_device" ? "applied" : "pending"),
                text: ev.deliveryStatus,
              }),
            ]);
            const metaRow = createEl("div", {
              className: "audit-meta",
              text: String(ev.reason || "") + " • by " + String(ev.actorPrincipalId || ""),
            });
            return createEl("div", { className: "list-item" }, [topRow, metaRow]);
          });
          auditEl.replaceChildren.apply(auditEl, eventNodes);
        }

        const snapEl = document.getElementById("snapshots-container");
        const snaps = data.snapshots || [];
        const snapNodes = snaps.slice(0, 10).map(function (s) {
          return createEl("div", { className: "list-item snapshot-row" }, [
            createEl("span", null, [
              createEl("code", { text: s.deviceId }),
              " rev " + String(s.revision) + ": " + String(s.reason || ""),
            ]),
            createEl("button", {
              type: "button",
              text: "Rollback",
              dataset: { action: "rollback", device: s.deviceId, rev: String(s.revision) },
            }),
          ]);
        });
        snapEl.replaceChildren.apply(snapEl, snapNodes);
      }

      document.addEventListener("click", async function (e) {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const deviceId = btn.dataset.device;
        try {
          if (action === "toggle-family") {
            const family = btn.dataset.family;
            const currentlyOn = btn.dataset.currentlyOn === "1";
            await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              grantFamilies: currentlyOn ? [] : [family],
              revokeFamilies: currentlyOn ? [family] : [],
              reason: (currentlyOn ? "Revoke " : "Grant ") + family + " family via Portal toggle",
            });
            await loadOverview();
          } else if (action === "device-profile") {
            const profileId = btn.dataset.profile;
            await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              profileId: profileId,
              emergencyLockdown: false,
              reason: "Apply " + profileId + " profile via Portal",
            });
            await loadOverview();
          } else if (action === "deny-op" || action === "allow-op") {
            const card = btn.closest(".device-card");
            const input = card ? card.querySelector("[data-role='op-rule-input']") : null;
            const cap = input ? input.value.trim() : "";
            if (!cap) return;
            await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              grantCapabilities: action === "allow-op" ? [cap] : [],
              revokeCapabilities: action === "deny-op" ? [cap] : [],
              reason: (action === "deny-op" ? "Explicitly deny " : "Grant ") + cap,
            });
            await loadOverview();
          } else if (action === "rollback") {
            const rev = Number(btn.dataset.rev);
            await apiCall("/portal/api/rollback", "POST", {
              deviceId: deviceId,
              targetRevision: rev,
              reason: "Rollback to revision " + rev + " from Portal",
            });
            await loadOverview();
          }
        } catch (err) {
          showBanner("Action failed: " + err.message);
        }
      });

      function openConfirmModal(title, desc, onConfirm) {
        document.getElementById("modal-title").textContent = title;
        document.getElementById("modal-desc").textContent = desc;
        document.getElementById("modal-reason").value = "";
        pendingModalAction = onConfirm;
        document.getElementById("confirm-modal").classList.add("active");
      }

      document.getElementById("modal-cancel-btn").addEventListener("click", function () {
        pendingModalAction = null;
        document.getElementById("confirm-modal").classList.remove("active");
      });

      document.getElementById("modal-confirm-btn").addEventListener("click", async function () {
        if (!pendingModalAction) return;
        const reason = document.getElementById("modal-reason").value.trim();
        const fn = pendingModalAction;
        pendingModalAction = null;
        document.getElementById("confirm-modal").classList.remove("active");
        try {
          await fn(reason);
          await loadOverview();
        } catch (err) {
          showBanner("Global action failed: " + err.message);
        }
      });

      document.getElementById("global-universal-btn").addEventListener("click", function () {
        openConfirmModal(
          "Grant Universal Access Across All Devices",
          "This will enable all six MCP tool families on every paired device.",
          function (reason) {
            return apiCall("/portal/api/global/apply", "POST", {
              confirm: true,
              profileId: "universal",
              emergencyLockdown: false,
              reason: reason || "Global grant universal access",
            });
          },
        );
      });

      document.getElementById("global-readonly-btn").addEventListener("click", function () {
        openConfirmModal(
          "Apply Read-Only Profile Across All Devices",
          "This will restrict all paired devices to non-destructive inspection operations.",
          function (reason) {
            return apiCall("/portal/api/global/apply", "POST", {
              confirm: true,
              profileId: "read_only",
              reason: reason || "Global read-only profile",
            });
          },
        );
      });

      document.getElementById("global-revoke-btn").addEventListener("click", function () {
        openConfirmModal(
          "Revoke All Tool Families Across All Devices",
          "This will disable all six MCP tool families across your paired devices until re-enabled.",
          function (reason) {
            return apiCall("/portal/api/global/apply", "POST", {
              confirm: true,
              profileId: "lockdown",
              reason: reason || "Global revoke all tool families",
            });
          },
        );
      });

      document.getElementById("emergency-revoke-btn").addEventListener("click", function () {
        openConfirmModal(
          "Emergency Access Revocation",
          "Immediate lockdown across all paired devices. All owner and operator capabilities will be blocked until lifted.",
          function (reason) {
            return apiCall("/portal/api/global/emergency-revoke", "POST", {
              confirm: true,
              reason: reason || "Emergency access revocation triggered from Portal",
            });
          },
        );
      });

      document.getElementById("save-operator-btn").addEventListener("click", async function () {
        const principalId = document.getElementById("op-principal-id").value.trim();
        const displayName = document.getElementById("op-display-name").value.trim();
        const profileId = document.getElementById("op-profile-id").value;
        if (!principalId) return;
        try {
          await apiCall("/portal/api/operators", "POST", {
            principalId: principalId,
            displayName: displayName || principalId,
            profileId: profileId,
            reason: "Configured operator " + principalId + " (" + profileId + ")",
          });
          await loadOverview();
        } catch (err) {
          showBanner("Operator update failed: " + err.message);
        }
      });

      connectBtn.addEventListener("click", connectSession);
      refreshBtn.addEventListener("click", loadOverview);
      logoutBtn.addEventListener("click", signOut);
      tokenInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          void connectSession();
        }
      });

      void restoreSession();
    })();
`;

const STYLE_SHA256 = createHash("sha256")
  .update(PORTAL_STYLE, "utf8")
  .digest("base64");
const SCRIPT_SHA256 = createHash("sha256")
  .update(PORTAL_SCRIPT, "utf8")
  .digest("base64");

export const PORTAL_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'sha256-${SCRIPT_SHA256}'`,
  `style-src 'sha256-${STYLE_SHA256}'`,
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export function renderControlPortalPage(): {
  html: string;
  contentSecurityPolicy: string;
} {
  return {
    html: renderControlPortalHtml(),
    contentSecurityPolicy: PORTAL_CONTENT_SECURITY_POLICY,
  };
}

export function renderControlPortalHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tetherplane Control Portal</title>
  <style>${PORTAL_STYLE}</style>
</head>
<body>
  <div class="portal-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-badge">T</div>
        <div>
          <h1>Tetherplane Control Portal</h1>
          <p>Universal Permissions &amp; Centralized Device Authorization</p>
        </div>
      </div>
      <div class="auth-bar">
        <span id="auth-state-badge" class="pill offline">Not Signed In</span>
        <input id="token-input" type="password" placeholder="Owner Bearer Token" aria-label="Owner Bearer Token" autocomplete="off" />
        <button id="connect-btn" class="primary" type="button">Connect</button>
        <button id="refresh-btn" type="button">Refresh</button>
        <button id="logout-btn" class="hidden" type="button">Sign Out</button>
      </div>
    </header>

    <section class="summary-strip" aria-label="System Summary">
      <div class="stat-card">
        <div class="stat-label">Paired Devices</div>
        <div class="stat-value" id="stat-devices">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Online &amp; Confirmed</div>
        <div class="stat-value" id="stat-confirmed">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Default Policy</div>
        <div class="stat-value stat-value-compact stat-value-primary">Universal (6 Families)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Security Status</div>
        <div class="stat-value stat-value-compact security-active" id="stat-security">Active</div>
      </div>
    </section>

    <section class="global-panel" aria-label="Global Permission Controls">
      <div>
        <strong>Global Controls</strong>
        <div class="global-subtitle">
          Apply a permission profile across selected devices or trigger emergency access revocation.
        </div>
      </div>
      <div class="global-actions">
        <button id="global-universal-btn" type="button">Grant Universal (All)</button>
        <button id="global-readonly-btn" type="button">Set Read-Only (All)</button>
        <button id="global-revoke-btn" type="button">Revoke All Families</button>
        <button id="emergency-revoke-btn" class="danger" type="button">Emergency Access Revocation</button>
      </div>
    </section>

    <main>
      <div id="status-banner" class="unavailable-banner status-banner-outer hidden"></div>
      <section class="devices-grid" id="devices-container" aria-label="Connected Devices">
        <div class="panel-card">Enter your owner token above to load paired Tetherplane devices.</div>
      </section>

      <div class="section-grid">
        <section class="panel-card" aria-label="Owner and Operator Identities">
          <h2>Owner &amp; Operator Identities</h2>
          <div id="identities-container" class="identities-list">
            No active identity telemetry yet.
          </div>
          <details class="advanced-box">
            <summary>Authorize / Update Scoped Operator Identity</summary>
            <div class="op-form-stack">
              <input id="op-principal-id" type="text" placeholder="operator:assistant-id" />
              <input id="op-display-name" type="text" placeholder="Display Name (e.g. Build Agent)" />
              <select id="op-profile-id">
                <option value="read_only">Read &amp; Inspect Only</option>
                <option value="files_and_process">Files &amp; Process Only</option>
                <option value="standard">Standard Automation</option>
                <option value="universal">Universal Access</option>
                <option value="lockdown">Zero Access (Revoked)</option>
              </select>
              <button id="save-operator-btn" class="primary" type="button">Save Operator Policy</button>
            </div>
          </details>
        </section>

        <section class="panel-card" aria-label="Security Audit and Rollback">
          <h2>Security Audit &amp; Safe Rollback</h2>
          <div id="audit-container" class="audit-scroll">
            <div class="muted-note">No audit events loaded.</div>
          </div>
          <details class="advanced-box advanced-box-spaced">
            <summary>Recoverable Snapshots &amp; Rollback</summary>
            <div id="snapshots-container" class="snapshots-scroll"></div>
          </details>
        </section>
      </div>
    </main>
  </div>

  <div class="modal-backdrop" id="confirm-modal" role="dialog" aria-modal="true">
    <div class="modal">
      <h3 id="modal-title">Confirm Global Security Change</h3>
      <p id="modal-desc" class="modal-desc"></p>
      <input id="modal-reason" class="modal-reason-input" type="text" placeholder="Reason for audit history" />
      <div class="modal-actions">
        <button id="modal-cancel-btn" type="button">Cancel</button>
        <button id="modal-confirm-btn" class="danger" type="button">Confirm Change</button>
      </div>
    </div>
  </div>

  <script>${PORTAL_SCRIPT}</script>
</body>
</html>`;
}
