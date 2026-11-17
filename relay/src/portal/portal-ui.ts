export function renderControlPortalHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tetherplane Control Portal</title>
  <style>
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
    }

    .device-title h3 {
      margin: 0;
      font-size: 1.1rem;
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

    details.advanced-box {
      border-top: 1px solid var(--border);
      padding-top: 10px;
    }

    details.advanced-box summary {
      cursor: pointer;
      font-size: 0.83rem;
      color: var(--primary);
      font-weight: 600;
      user-select: none;
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

    .list-item {
      border-bottom: 1px solid var(--border);
      padding: 10px 0;
      font-size: 0.83rem;
    }

    .list-item:last-child {
      border-bottom: none;
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

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 16px;
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
  </style>
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
        <input id="token-input" type="password" placeholder="Owner Bearer Token" aria-label="Owner Bearer Token" />
        <button id="connect-btn" class="primary" type="button">Connect</button>
        <button id="refresh-btn" type="button">Refresh</button>
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
        <div class="stat-value" style="font-size:1.05rem;color:var(--primary)">Universal (6 Families)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Security Status</div>
        <div class="stat-value" id="stat-security" style="font-size:1.05rem;color:var(--success)">Active</div>
      </div>
    </section>

    <section class="global-panel" aria-label="Global Permission Controls">
      <div>
        <strong>Global Controls</strong>
        <div style="font-size:0.82rem;color:var(--text-muted)">
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
      <div id="status-banner" style="display:none;margin-bottom:14px;" class="unavailable-banner"></div>
      <section class="devices-grid" id="devices-container" aria-label="Connected Devices">
        <div class="panel-card">Enter your owner token above to load paired Tetherplane devices.</div>
      </section>

      <div class="section-grid">
        <section class="panel-card" aria-label="Owner and Operator Identities">
          <h2>Owner &amp; Operator Identities</h2>
          <div id="identities-container" style="margin-bottom:12px;font-size:0.84rem;color:var(--text-muted)">
            No active identity telemetry yet.
          </div>
          <details class="advanced-box">
            <summary>Authorize / Update Scoped Operator Identity</summary>
            <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">
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
          <div id="audit-container" style="max-height:280px;overflow-y:auto;">
            <div style="font-size:0.84rem;color:var(--text-muted)">No audit events loaded.</div>
          </div>
          <details class="advanced-box" style="margin-top:12px;">
            <summary>Recoverable Snapshots &amp; Rollback</summary>
            <div id="snapshots-container" style="margin-top:10px;max-height:200px;overflow-y:auto;"></div>
          </details>
        </section>
      </div>
    </main>
  </div>

  <div class="modal-backdrop" id="confirm-modal" role="dialog" aria-modal="true">
    <div class="modal">
      <h3 id="modal-title">Confirm Global Security Change</h3>
      <p id="modal-desc" style="font-size:0.88rem;color:var(--text-muted)"></p>
      <input id="modal-reason" type="text" placeholder="Reason for audit history" style="width:100%" />
      <div class="modal-actions">
        <button id="modal-cancel-btn" type="button">Cancel</button>
        <button id="modal-confirm-btn" class="danger" type="button">Confirm Change</button>
      </div>
    </div>
  </div>

  <script>
    (function () {
      const params = new URLSearchParams(window.location.search);
      const tokenInput = document.getElementById("token-input");
      const savedToken = params.get("token") || sessionStorage.getItem("tetherplane_portal_token") || "";
      tokenInput.value = savedToken;

      let currentOverview = null;
      let pendingModalAction = null;

      function getToken() {
        return tokenInput.value.trim();
      }

      async function apiCall(path, method, body) {
        const token = getToken();
        if (token) {
          sessionStorage.setItem("tetherplane_portal_token", token);
        }
        const headers = { Accept: "application/json" };
        if (token) headers.Authorization = "Bearer " + token;
        if (body) headers["Content-Type"] = "application/json";
        const res = await fetch(path, {
          method: method || "GET",
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) {
          throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
        }
        return data;
      }

      function showBanner(msg) {
        const banner = document.getElementById("status-banner");
        if (!msg) {
          banner.style.display = "none";
          return;
        }
        banner.textContent = msg;
        banner.style.display = "block";
      }

      async function loadOverview() {
        if (!getToken()) return;
        try {
          showBanner("");
          const data = await apiCall("/portal/api/overview", "GET");
          currentOverview = data;
          renderOverview(data);
        } catch (err) {
          showBanner("Portal notice: " + err.message);
        }
      }

      function renderOverview(data) {
        const devices = data.devices || [];
        document.getElementById("stat-devices").textContent = String(devices.length);
        const confirmedCount = devices.filter(function (d) {
          return d.online && d.confirmedByDevice;
        }).length;
        document.getElementById("stat-confirmed").textContent = String(confirmedCount);

        const anyLockdown = devices.some(function (d) { return d.emergencyLockdown; });
        const secEl = document.getElementById("stat-security");
        secEl.textContent = anyLockdown ? "LOCKDOWN" : "Active";
        secEl.style.color = anyLockdown ? "var(--danger)" : "var(--success)";

        const container = document.getElementById("devices-container");
        container.innerHTML = "";
        if (devices.length === 0) {
          container.innerHTML = '<div class="panel-card">No paired devices found for this owner account.</div>';
        }

        devices.forEach(function (dev) {
          const card = document.createElement("article");
          card.className = "device-card";
          card.setAttribute("data-device-id", dev.deviceId);

          const syncLabel = dev.emergencyLockdown
            ? "Emergency Lockdown"
            : dev.syncStatus === "applied"
              ? "Confirmed Active (v" + dev.appliedRevision + ")"
              : "Pending Device Ack (v" + dev.desiredRevision + ")";
          const syncClass = dev.emergencyLockdown
            ? "lockdown"
            : dev.syncStatus === "applied"
              ? "applied"
              : "pending";

          const platformInfo = dev.status && dev.status.platform
            ? dev.status.platform + " • v" + (dev.status.version || "0.1.0")
            : "Awaiting telemetry";

          let unavailableHtml = "";
          if (Array.isArray(dev.unavailableCapabilities) && dev.unavailableCapabilities.length > 0) {
            unavailableHtml = '<div class="unavailable-banner">' +
              dev.unavailableCapabilities.map(function (u) {
                return "<strong>" + u.name + " unavailable:</strong> " + u.reason;
              }).join("<br/>") +
              "</div>";
          }

          const familiesHtml = (dev.familySummaries || []).map(function (fam) {
            const isOn = Boolean(fam.granted);
            const subText = fam.grantedOperations.length + "/" + fam.availableOperations.length + " ops active";
            return (
              '<div class="family-toggle ' + (isOn ? "granted" : "") + '">' +
                '<div>' +
                  '<span class="family-name">' + fam.family + '</span>' +
                  '<span class="family-sub">' + subText + '</span>' +
                '</div>' +
                '<button type="button" class="switch-btn ' + (isOn ? "on" : "off") + '" ' +
                  'data-action="toggle-family" data-device="' + dev.deviceId + '" ' +
                  'data-family="' + fam.family + '" data-currently-on="' + (isOn ? "1" : "0") + '">' +
                  (isOn ? "ON" : "OFF") +
                '</button>' +
              '</div>'
            );
          }).join("");

          const deniedCaps = (dev.policy && dev.policy.owner_policy && dev.policy.owner_policy.denied_capabilities) || [];

          card.innerHTML =
            '<div class="device-header">' +
              '<div class="device-title">' +
                '<h3>' + dev.deviceId + '</h3>' +
                '<span class="pill ' + (dev.online ? "online" : "offline") + '">' +
                  (dev.online ? "Online" : "Offline") +
                '</span>' +
              '</div>' +
              '<span class="pill ' + syncClass + '" data-sync-badge="' + dev.deviceId + '">' + syncLabel + '</span>' +
            '</div>' +
            '<div style="font-size:0.8rem;color:var(--text-muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">' +
              '<span>Health: <strong>' + dev.agentHealth + '</strong> (' + platformInfo + ')</span>' +
              '<span>Profile: <strong>' + ((dev.policy && dev.policy.owner_policy && dev.policy.owner_policy.profile_id) || "universal") + '</strong></span>' +
            '</div>' +
            unavailableHtml +
            '<div class="family-grid">' + familiesHtml + '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
              '<button type="button" data-action="device-profile" data-device="' + dev.deviceId + '" data-profile="universal">Grant All (Universal)</button>' +
              '<button type="button" data-action="device-profile" data-device="' + dev.deviceId + '" data-profile="read_only">Read-Only</button>' +
              '<button type="button" data-action="device-profile" data-device="' + dev.deviceId + '" data-profile="lockdown">Revoke All</button>' +
            '</div>' +
            '<details class="advanced-box">' +
              '<summary>Advanced Operation Rules &amp; Explicit Denies (' + deniedCaps.length + ')</summary>' +
              '<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">' +
                '<div style="font-size:0.78rem;color:var(--text-muted);">Explicitly denied operations override inherited universal grants: ' +
                  (deniedCaps.length ? deniedCaps.join(", ") : "None") +
                '</div>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                  '<input type="text" placeholder="e.g. filesystem.delete" id="deny-input-' + dev.deviceId + '" style="flex:1;" />' +
                  '<button type="button" data-action="deny-op" data-device="' + dev.deviceId + '">Deny Op</button>' +
                  '<button type="button" data-action="allow-op" data-device="' + dev.deviceId + '">Allow Op</button>' +
                '</div>' +
              '</div>' +
            '</details>';

          container.appendChild(card);
        });

        renderIdentities(data);
        renderAuditAndSnapshots(data);
      }

      function renderIdentities(data) {
        const container = document.getElementById("identities-container");
        const usage = data.identityUsage || [];
        const operators = data.operators || [];
        let html = '<div class="list-item"><strong>Owner:</strong> ' + data.ownerPrincipalId + ' <span class="pill applied">Universal Default</span></div>';
        operators.forEach(function (op) {
          html += '<div class="list-item"><strong>Operator:</strong> ' + op.principalId + ' (' + op.displayName + ')</div>';
        });
        usage.forEach(function (u) {
          html += '<div class="list-item">' +
            '<strong>' + u.principalId + '</strong> (' + u.role + ') on <code>' + u.deviceId + '</code>: ' +
            u.authorizedCount + ' allowed, ' + u.deniedCount + ' denied • ops: ' + u.capabilitiesUsed.join(", ") +
          '</div>';
        });
        container.innerHTML = html;
      }

      function renderAuditAndSnapshots(data) {
        const auditEl = document.getElementById("audit-container");
        const events = data.auditHistory || [];
        if (events.length === 0) {
          auditEl.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted)">No audit events recorded yet.</div>';
        } else {
          auditEl.innerHTML = events.slice(0, 15).map(function (ev) {
            return (
              '<div class="list-item">' +
                '<div><strong>' + ev.action + '</strong> ' + (ev.deviceId ? 'on <code>' + ev.deviceId + '</code>' : '') +
                ' <span class="pill ' + (ev.deliveryStatus === "confirmed_by_device" ? "applied" : "pending") + '">' + ev.deliveryStatus + '</span></div>' +
                '<div style="color:var(--text-muted);font-size:0.78rem;">' + ev.reason + ' • by ' + ev.actorPrincipalId + '</div>' +
              '</div>'
            );
          }).join("");
        }

        const snapEl = document.getElementById("snapshots-container");
        const snaps = data.snapshots || [];
        snapEl.innerHTML = snaps.slice(0, 10).map(function (s) {
          return (
            '<div class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
              '<span><code>' + s.deviceId + '</code> rev ' + s.revision + ': ' + s.reason + '</span>' +
              '<button type="button" data-action="rollback" data-device="' + s.deviceId + '" data-rev="' + s.revision + '">Rollback</button>' +
            '</div>'
          );
        }).join("");
      }

      document.addEventListener("click", async function (e) {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.getAttribute("data-action");
        const deviceId = btn.getAttribute("data-device");
        try {
          if (action === "toggle-family") {
            const family = btn.getAttribute("data-family");
            const currentlyOn = btn.getAttribute("data-currently-on") === "1";
            await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              grantFamilies: currentlyOn ? [] : [family],
              revokeFamilies: currentlyOn ? [family] : [],
              reason: (currentlyOn ? "Revoke " : "Grant ") + family + " family via Portal toggle",
            });
            await loadOverview();
          } else if (action === "device-profile") {
            const profileId = btn.getAttribute("data-profile");
            await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              profileId: profileId,
              emergencyLockdown: false,
              reason: "Apply " + profileId + " profile via Portal",
            });
            await loadOverview();
          } else if (action === "deny-op" || action === "allow-op") {
            const input = document.getElementById("deny-input-" + deviceId);
            const cap = input ? input.value.trim() : "";
            if (!cap) return;
            await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              grantCapabilities: action === "allow-op" ? [cap] : [],
              revokeCapabilities: action === "deny-op" ? [cap] : [],
              reason: (action === "deny-op" ? "Explicitly deny " : "Grant ") + cap,
            });
            await loadOverview();
          } else if (action === "rollback") {
            const rev = Number(btn.getAttribute("data-rev"));
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
          }
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
          }
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
          }
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
          }
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

      document.getElementById("connect-btn").addEventListener("click", loadOverview);
      document.getElementById("refresh-btn").addEventListener("click", loadOverview);

      if (savedToken) {
        loadOverview();
      }
    })();
  </script>
</body>
</html>`;
}
