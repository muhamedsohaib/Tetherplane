import { createHash } from "node:crypto";

const PORTAL_STYLE = `
    :root {
      --bg: #090d14;
      --surface: #111827;
      --surface-elevated: #172033;
      --surface-subtle: #0d1422;
      --border: #24324a;
      --border-strong: #334766;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --primary-bg: rgba(56, 189, 248, 0.14);
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
      -webkit-tap-highlight-color: transparent;
    }

    body[data-auth="signed-out"] .summary-strip,
    body[data-auth="signed-out"] .fleet-toolbar,
    body[data-auth="signed-out"] .live-alerts-note,
    body[data-auth="signed-out"] .global-panel,
    body[data-auth="signed-out"] .section-grid,
    body[data-auth="signed-out"] #refresh-btn,
    body[data-auth="signed-out"] #live-alerts-btn,
    body[data-auth="signed-out"] #live-stream-badge {
      display: none;
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
      gap: 12px 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 18px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .brand-badge {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, #38bdf8, #0284c7);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      color: #06121f;
      font-size: 18px;
      flex-shrink: 0;
      letter-spacing: -0.04em;
    }

    .brand h1 {
      margin: 0;
      font-size: 1.2rem;
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
      padding: 9px 12px;
      font-size: 0.875rem;
      min-width: 0;
    }

    input[type="password"]:focus,
    input[type="text"]:focus,
    select:focus,
    button:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 1px;
    }

    button {
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--surface-elevated);
      color: var(--text);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 0.84rem;
      font-weight: 600;
      transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
    }

    button:hover:not(:disabled) {
      border-color: var(--primary);
    }

    button:disabled {
      opacity: 0.55;
      cursor: wait;
    }

    button.primary {
      background: var(--primary);
      color: #06121f;
      border-color: transparent;
    }

    button.primary:hover:not(:disabled) {
      background: var(--primary-hover);
    }

    .oidc-signin-link {
      display: inline-flex;
      justify-content: center;
      align-items: center;
      padding: 10px 15px;
      min-height: 44px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: var(--primary);
      color: #06121f;
      font-size: 0.84rem;
      font-weight: 700;
      text-decoration: none;
    }
    .oidc-signin-link:hover { background: var(--primary-hover); }
    .oidc-signin-link:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }

    button.danger {
      background: var(--danger-bg);
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.45);
    }

    button.danger:hover:not(:disabled) {
      background: var(--danger);
      color: #fff;
    }

    button.active-profile {
      background: var(--primary-bg);
      border-color: rgba(56, 189, 248, 0.65);
      color: #bae6fd;
    }

    .signed-out-card {
      grid-column: 1 / -1;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
      max-width: 680px;
    }

    .signed-out-card h2 {
      margin: 0 0 8px;
      font-size: 1.08rem;
    }

    .signed-out-card p {
      margin: 0 0 12px;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    .signed-out-points {
      margin: 0;
      padding-left: 18px;
      color: var(--text-muted);
      font-size: 0.84rem;
      display: grid;
      gap: 6px;
    }

    .summary-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }

    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 13px 16px;
      min-width: 0;
    }

    .stat-label {
      font-size: 0.74rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .stat-value {
      font-size: 1.45rem;
      font-weight: 700;
      margin-top: 3px;
    }

    .stat-value-compact {
      font-size: 1.02rem;
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

    .fleet-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 14px;
    }

    .filter-group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }

    .filter-pill {
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
    }

    .filter-pill[aria-pressed="true"] {
      background: var(--primary-bg);
      border-color: rgba(56, 189, 248, 0.65);
      color: #e0f2fe;
    }

    .fleet-meta {
      font-size: 0.78rem;
      color: var(--text-muted);
    }

    .global-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      margin-bottom: 20px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }

    .global-subtitle {
      font-size: 0.82rem;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .global-scope-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
    }

    .global-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    .devices-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }

    .device-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
      max-width: 100%;
    }

    .device-card.is-pending {
      border-left: 3px solid var(--warning);
    }

    .device-card.is-failed,
    .device-card.is-lockdown {
      border-left: 3px solid var(--danger);
    }

    .device-card.is-selected {
      box-shadow: 0 0 0 1px var(--primary);
      border-color: var(--primary);
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
      flex-wrap: wrap;
    }

    .device-select-cb {
      width: 18px;
      height: 18px;
      accent-color: var(--primary);
      cursor: pointer;
      flex-shrink: 0;
    }

    .device-title h3 {
      margin: 0;
      font-size: 1.08rem;
      letter-spacing: -0.01em;
      overflow-wrap: anywhere;
    }

    .card-meta-row {
      font-size: 0.8rem;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 6px 12px;
    }

    .sync-detail {
      font-size: 0.78rem;
      padding: 7px 10px;
      border-radius: 8px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .sync-detail.applied {
      border-color: rgba(34, 197, 94, 0.28);
      color: #86efac;
    }

    .sync-detail.pending {
      background: rgba(245, 158, 11, 0.08);
      border-color: rgba(245, 158, 11, 0.35);
      color: #fde68a;
    }

    .sync-detail.failed,
    .sync-detail.lockdown {
      background: rgba(239, 68, 68, 0.1);
      border-color: rgba(239, 68, 68, 0.4);
      color: #fca5a5;
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
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
      max-width: 100%;
      overflow-wrap: anywhere;
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
      border-radius: 9px;
      padding: 10px 12px;
      gap: 8px;
      min-width: 0;
    }

    .family-toggle > div {
      min-width: 0;
    }

    .family-toggle.granted {
      border-color: rgba(34, 197, 94, 0.35);
    }

    .family-toggle.partial {
      border-color: rgba(56, 189, 248, 0.45);
    }

    .family-toggle.degraded {
      border-color: rgba(245, 158, 11, 0.45);
    }

    .family-name {
      font-weight: 600;
      font-size: 0.87rem;
      text-transform: capitalize;
    }

    .family-sub {
      font-size: 0.73rem;
      color: var(--text-muted);
      display: block;
      overflow-wrap: anywhere;
    }

    .family-toggle.degraded .family-sub {
      color: #fcd34d;
    }

    .switch-btn {
      min-width: 62px;
      min-height: 34px;
      padding: 6px 11px;
      font-size: 0.75rem;
      border-radius: 999px;
      flex-shrink: 0;
      letter-spacing: 0.02em;
    }

    .switch-btn.on {
      background: var(--success);
      color: #052010;
      border-color: transparent;
    }

    .switch-btn.partial {
      background: var(--primary-bg);
      color: #7dd3fc;
      border-color: rgba(56, 189, 248, 0.55);
    }

    .switch-btn.off {
      background: rgba(148, 163, 184, 0.16);
      color: var(--text-muted);
    }

    .toast-stack {
      position: fixed;
      right: calc(16px + env(safe-area-inset-right, 0px));
      bottom: calc(16px + env(safe-area-inset-bottom, 0px));
      z-index: 90;
      width: min(370px, calc(100vw - 32px));
      display: grid;
      gap: 8px;
      pointer-events: none;
    }
    .toast {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      color: var(--text);
      background: var(--surface-elevated);
      border: 1px solid var(--border-strong);
      border-left: 3px solid var(--primary);
      border-radius: 10px;
      padding: 12px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
      pointer-events: auto;
      overflow-wrap: anywhere;
      font-size: 0.85rem;
    }
    .toast[data-level="confirmed"] { border-left-color: var(--success); }
    .toast[data-level="pending"] { border-left-color: var(--warning); }
    .toast[data-level="error"] { border-left-color: var(--danger); }
    .toast-message { flex: 1; min-width: 0; }
    .toast-dismiss { padding: 0 4px; min-width: 34px; min-height: 34px; }
    .live-alerts-note { font-size: 0.74rem; color: var(--text-muted); margin: 0 0 10px; }

    .unavailable-banner {
      background: var(--warning-bg);
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 0.8rem;
      color: #fde68a;
      overflow-wrap: anywhere;
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
      padding: 2px 0;
    }

    .op-rules-wrap {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .op-rules-note {
      font-size: 0.78rem;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .denied-chips-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .denied-chip-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 0.76rem;
      font-family: var(--mono);
      background: var(--danger-bg);
      color: #fecaca;
      border: 1px solid rgba(239, 68, 68, 0.45);
    }

    .denied-chip-btn:hover:not(:disabled) {
      background: rgba(34, 197, 94, 0.18);
      border-color: rgba(34, 197, 94, 0.6);
      color: #bbf7d0;
    }

    .op-rule-input-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .op-rule-input {
      flex: 1 1 180px;
      min-width: 0;
    }

    .section-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-top: 18px;
    }

    .panel-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      min-width: 0;
      max-width: 100%;
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

    .identity-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
      flex-wrap: wrap;
    }

    .identity-main {
      min-width: 0;
      flex: 1 1 200px;
    }

    .identity-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .op-form-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
      min-width: 0;
    }

    .op-form-stack input,
    .op-form-stack select {
      width: 100%;
      max-width: 100%;
    }

    .audit-scroll {
      max-height: 300px;
      overflow-y: auto;
    }

    .audit-top-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }

    .snapshot-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
    }

    .snapshot-more-wrap {
      margin-top: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .snapshots-scroll {
      margin-top: 10px;
      max-height: 240px;
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
      flex-wrap: wrap;
    }

    .audit-meta {
      color: var(--text-muted);
      font-size: 0.77rem;
      margin-top: 3px;
      overflow-wrap: anywhere;
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(5, 8, 15, 0.78);
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
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      max-width: 440px;
      width: 100%;
      padding: 20px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55);
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

    @media (max-width: 860px) {
      .devices-grid,
      .section-grid {
        grid-template-columns: 1fr;
      }
      .summary-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    @media (max-width: 600px) {
      .portal-shell { padding: 12px 12px 56px; }
      .topbar {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
        padding-bottom: 12px;
        margin-bottom: 12px;
      }
      .brand-badge {
        width: 32px;
        height: 32px;
        font-size: 16px;
      }
      .brand h1 { font-size: 1.08rem; }
      .brand p { display: none; }
      .auth-bar {
        gap: 6px;
      }
      .auth-bar > input {
        width: 100%;
        min-height: 44px;
      }
      .auth-bar > button {
        min-height: 44px;
        padding: 8px 12px;
        font-size: 0.82rem;
      }
      .summary-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-bottom: 10px;
      }
      .stat-card { padding: 8px 10px; }
      .stat-value { font-size: 1.15rem; }
      .stat-value-compact { font-size: 0.85rem; }
      .fleet-toolbar {
        gap: 6px;
        margin-bottom: 10px;
      }
      .filter-group {
        flex-wrap: nowrap;
        overflow-x: auto;
        max-width: 100%;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .filter-pill {
        flex-shrink: 0;
        white-space: nowrap;
        min-height: 36px;
        padding: 6px 10px;
        font-size: 0.78rem;
      }
      .family-grid {
        grid-template-columns: 1fr;
      }
      .device-card {
        padding: 14px;
        gap: 10px;
      }
      .device-select-cb {
        width: 20px;
        height: 20px;
      }
      .switch-btn {
        min-height: 44px;
        min-width: 72px;
        padding: 8px 12px;
        font-size: 0.8rem;
      }
      .device-actions-row button,
      .global-actions button,
      .identity-actions button,
      .modal-actions button,
      .op-rule-input-row button {
        min-height: 44px;
      }
      .toast-stack {
        left: 12px;
        right: 12px;
        width: auto;
        top: auto;
        bottom: calc(12px + env(safe-area-inset-bottom, 0px));
        max-height: 42vh;
        overflow-y: auto;
      }
      .toast-dismiss {
        min-width: 40px;
        min-height: 40px;
      }
    }
`;

const PORTAL_SCRIPT = `
    (function () {
      const SNAPSHOT_PAGE_SIZE = 10;
      const tokenInput = document.getElementById("token-input");
      const connectBtn = document.getElementById("connect-btn");
      const oidcLink = document.getElementById("oidc-signin-link");
      const oidcMode = document.body.dataset.loginMode === "oidc";
      const refreshBtn = document.getElementById("refresh-btn");
      const logoutBtn = document.getElementById("logout-btn");
      const authStateBadge = document.getElementById("auth-state-badge");
      const liveStreamBadge = document.getElementById("live-stream-badge");
      const statusBanner = document.getElementById("status-banner");
      const toastStack = document.getElementById("toast-stack");
      const liveAlertsBtn = document.getElementById("live-alerts-btn");
      const fleetFilterBar = document.getElementById("fleet-filter-bar");
      const canonicalOpsList = document.getElementById("canonical-ops-list");
      const confirmModal = document.getElementById("confirm-modal");

      let csrfToken = null;
      let authenticatedOwner = null;
      let currentOverview = null;
      let pendingModalAction = null;
      let lastModalTrigger = null;
      let eventSource = null;
      let pendingFallbackTimer = null;
      let pendingFallbackAttempts = 0;
      let overviewInFlight = false;
      let overviewQueued = false;
      let snapshotFilterDevice = "";
      let snapshotLimit = SNAPSHOT_PAGE_SIZE;
      let activeFleetFilter = "all";
      let lastUpdatedMs = null;
      const openAdvancedDevices = new Set();
      const selectedDeviceIds = new Set();
      const trackedAccessUpdates = new Map();
      const lastDeviceState = new Map();
      let livePageAlerts = false;

      function createEl(tag, options, children) {
        const node = document.createElement(tag);
        if (options) {
          if (options.className) node.className = options.className;
          if (options.text !== undefined) node.textContent = String(options.text);
          if (options.type) node.type = options.type;
          if (typeof options.checked === "boolean") node.checked = options.checked;
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

      function formatTimeLabel(value) {
        if (!value) return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        const now = new Date();
        const sameDay =
          date.getFullYear() === now.getFullYear() &&
          date.getMonth() === now.getMonth() &&
          date.getDate() === now.getDate();
        if (sameDay) {
          return date.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        }
        return date.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      }

      function formatDeliveryStatus(status) {
        switch (status) {
          case "confirmed_by_device":
            return { label: "Confirmed by device", cls: "applied" };
          case "pending_device_ack":
            return { label: "Pending device ACK", cls: "pending" };
          case "device_offline":
            return { label: "Queued (offline)", cls: "pending" };
          case "delivery_failed":
            return { label: "Delivery failed", cls: "failed" };
          case "not_applicable":
            return { label: "Relay directory", cls: "offline" };
          default:
            return { label: String(status || "Unknown"), cls: "offline" };
        }
      }

      function formatAuditAction(action) {
        switch (action) {
          case "policy_updated":
            return "Policy updated";
          case "operator_updated":
            return "Operator updated";
          case "operator_removed":
            return "Operator removed";
          case "global_policy_applied":
            return "Global policy applied";
          case "emergency_lockdown":
            return "Emergency lockdown";
          case "emergency_lockdown_lifted":
            return "Lockdown lifted";
          case "policy_rollback":
            return "Policy rollback";
          case "device_paired":
            return "Device paired";
          default:
            return String(action || "Policy event").replace(/_/g, " ");
        }
      }

      function deviceNeedsAttention(dev) {
        return (
          Boolean(dev.emergencyLockdown) ||
          dev.syncStatus === "pending" ||
          dev.syncStatus === "failed" ||
          (Array.isArray(dev.unavailableCapabilities) &&
            dev.unavailableCapabilities.length > 0)
        );
      }

      function formatSyncDetail(dev) {
        const appliedText =
          dev.appliedRevision !== null && dev.appliedRevision !== undefined
            ? "v" + dev.appliedRevision
            : "none";
        const ackTime = formatTimeLabel(dev.lastAckAtMs);
        const ackSuffix = ackTime ? " • ACK " + ackTime : "";
        if (dev.emergencyLockdown) {
          if (dev.online && dev.confirmedByDevice) {
            return {
              cls: "lockdown",
              text:
                "Lockdown enforced — Device confirmed v" +
                dev.appliedRevision +
                ackSuffix,
            };
          }
          if (!dev.online) {
            return {
              cls: "lockdown",
              text:
                "Relay queued v" +
                dev.desiredRevision +
                " lockdown — device offline; enforces on reconnect (last confirmed: " +
                appliedText +
                ")",
            };
          }
          return {
            cls: "lockdown",
            text:
              "Relay accepted v" +
              dev.desiredRevision +
              " lockdown — waiting for device confirmation (enforcing " +
              appliedText +
              ")",
          };
        }
        if (dev.syncStatus === "failed") {
          return {
            cls: "failed",
            text:
              "Device rejected v" +
              dev.desiredRevision +
              " — still enforcing " +
              appliedText,
          };
        }
        if (dev.syncStatus === "applied") {
          if (dev.online) {
            return {
              cls: "applied",
              text: "Device confirmed v" + dev.appliedRevision + ackSuffix,
            };
          }
          return {
            cls: "pending",
            text:
              "Device confirmed v" +
              dev.appliedRevision +
              ackSuffix +
              " • Currently offline",
          };
        }
        if (!dev.online) {
          return {
            cls: "pending",
            text:
              "Relay queued v" +
              dev.desiredRevision +
              " — device offline; will sync on reconnect (last confirmed: " +
              appliedText +
              ")",
          };
        }
        return {
          cls: "pending",
          text:
            "Relay accepted v" +
            dev.desiredRevision +
            " — waiting for device confirmation (enforcing " +
            appliedText +
            ")",
        };
      }

      function setStreamBadge(state) {
        if (!liveStreamBadge) return;
        if (state === "live") {
          liveStreamBadge.textContent = "Live SSE";
          liveStreamBadge.className = "pill online";
        } else if (state === "reconnecting") {
          liveStreamBadge.textContent = "Reconnecting";
          liveStreamBadge.className = "pill pending";
        } else {
          liveStreamBadge.textContent = "Connecting";
          liveStreamBadge.className = "pill offline";
        }
      }

      function updateSelectionIndicators() {
        const devices = (currentOverview && currentOverview.devices) || [];
        const knownIds = new Set(devices.map(function (d) { return d.deviceId; }));
        if (currentOverview) {
          Array.from(selectedDeviceIds).forEach(function (id) {
            if (!knownIds.has(id)) selectedDeviceIds.delete(id);
          });
        }
        document.querySelectorAll('input[data-action="select-device"]').forEach(function (cb) {
          const isSelected = selectedDeviceIds.has(cb.dataset.device || "");
          cb.checked = isSelected;
          const card = cb.closest(".device-card");
          if (card) {
            card.classList.toggle("is-selected", isSelected);
          }
        });
        const selected = Array.from(selectedDeviceIds);
        const badge = document.getElementById("global-target-badge");
        if (badge) {
          if (selected.length === 0) {
            badge.textContent = "Target: All paired devices";
            badge.className = "pill offline";
          } else {
            badge.textContent =
              "Target: " + selected.length + " selected (" + selected.join(", ") + ")";
            badge.className = "pill applied";
          }
        }
        const opNote = document.getElementById("op-target-scope-note");
        if (opNote) {
          opNote.textContent =
            selected.length === 0
              ? "Applies to: All paired devices (select checkboxes above to scope)"
              : "Applies to selected devices only: " + selected.join(", ");
        }
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
        setStreamBadge("connecting");
      }

      function startLiveUpdates() {
        if (!authenticatedOwner || typeof EventSource !== "function") return;
        if (eventSource) return;
        setStreamBadge("connecting");
        const es = new EventSource("/portal/api/events", {
          withCredentials: true,
        });
        es.addEventListener("open", function () {
          setStreamBadge("live");
        });
        es.addEventListener("overview", function () {
          setStreamBadge("live");
          void loadOverview();
        });
        es.addEventListener("session_expired", function () {
          setSignedOutUi(oidcMode
            ? "Session expired. Sign in again with TetherAuth."
            : "Portal session expired. Submit your owner token to connect.");
        });
        es.addEventListener("error", function () {
          if (authenticatedOwner) {
            setStreamBadge("reconnecting");
          }
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

      function renderSignedOutWelcome() {
        const container = document.getElementById("devices-container");
        container.replaceChildren(
          createEl("div", { className: "signed-out-card" }, [
            createEl("h2", { text: "Owner Sign-In Required" }),
            createEl("p", {
              text: oidcMode
                ? "Sign in with your existing TetherAuth account to view your authorized devices. No token copying is required."
                : "Enter your owner bearer token above to start an authenticated control session for your paired Tetherplane devices.",
            }),
            createEl("ul", { className: "signed-out-points" }, [
              createEl("li", {
                text: "Session stays in an HttpOnly SameSite=Strict cookie — never written to browser web storage or URLs.",
              }),
              createEl("li", {
                text: "Relay acceptance and device-confirmed enforcement are tracked separately so you always know what each device enforces.",
              }),
              createEl("li", {
                text: "Live updates stream over SSE while this page is open; background mobile push is not configured.",
              }),
            ]),
          ]),
        );
      }

      function setSignedOutUi(notice) {
        stopLiveUpdates();
        trackedAccessUpdates.clear();
        lastDeviceState.clear();
        toastStack.replaceChildren();
        livePageAlerts = false;
        liveAlertsBtn.textContent = "Enable live page alerts";
        liveAlertsBtn.setAttribute("aria-pressed", "false");
        csrfToken = null;
        authenticatedOwner = null;
        currentOverview = null;
        activeFleetFilter = "all";
        lastUpdatedMs = null;
        openAdvancedDevices.clear();
        selectedDeviceIds.clear();
        snapshotFilterDevice = "";
        snapshotLimit = SNAPSHOT_PAGE_SIZE;
        updateSelectionIndicators();

        document.body.dataset.auth = "signed-out";
        authStateBadge.textContent = "Not Signed In";
        authStateBadge.className = "pill offline";
        logoutBtn.classList.add("hidden");
        document.getElementById("global-lift-lockdown-btn").classList.add("hidden");
        tokenInput.classList.toggle("hidden", oidcMode);
        connectBtn.classList.toggle("hidden", oidcMode);
        oidcLink.classList.toggle("hidden", !oidcMode);
        fleetFilterBar.replaceChildren();

        renderSignedOutWelcome();
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
        document.getElementById("snapshot-device-filter").replaceChildren(
          createEl("option", { attrs: { value: "" }, text: "All devices" }),
        );
        document.getElementById("snapshots-container").replaceChildren();
        document.getElementById("snapshots-pagination").replaceChildren();
        if (notice) showBanner(notice);
      }

      function setSignedInUi(ownerPrincipalId) {
        authenticatedOwner = ownerPrincipalId;
        document.body.dataset.auth = "signed-in";
        authStateBadge.textContent = "Owner: " + ownerPrincipalId;
        authStateBadge.className = "pill online";
        tokenInput.classList.add("hidden");
        connectBtn.classList.add("hidden");
        oidcLink.classList.add("hidden");
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
          setSignedOutUi(oidcMode
            ? "Session is missing or expired. Sign in again with TetherAuth."
            : "Portal session is missing or expired. Submit your owner token to connect.");
          throw new Error((data.error && data.error.message) || "HTTP 401");
        }
        if (!res.ok) {
          throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
        }
        return data;
      }

      // Never mistake relay acceptance for agent-enforced permissions.
      // All feedback is in-page; background mobile push is NOT provided here.
      function showToast(message, level, kind) {
        const toast = createEl("div", {
          className: "toast",
          attrs: {
            "data-level": level || "info",
            "data-kind": kind || "general",
            role: level === "error" ? "alert" : "status",
          },
        }, [createEl("span", { className: "toast-message", text: message })]);
        const dismiss = createEl("button", {
          type: "button",
          className: "toast-dismiss",
          text: "×",
          attrs: { "aria-label": "Dismiss notification" },
        });
        toast.appendChild(dismiss);
        dismiss.addEventListener("click", function () { toast.remove(); });
        while (toastStack.childElementCount >= 3) toastStack.firstElementChild.remove();
        toastStack.appendChild(toast);
        setTimeout(function () { toast.remove(); },
          level === "error" ? 10000 : level === "confirmed" ? 8000 : 6000);
        return toast;
      }

      function settleTrackedEntry(id, change) {
        trackedAccessUpdates.delete(id);
        if (change && change.batch) {
          change.batch.remainingIds.delete(id);
          if (change.batch.remainingIds.size === 0 && change.batch.toastEl) {
            change.batch.toastEl.remove();
          }
        }
      }

      // Revision numbers are supplied by the authenticated relay mutation
      // response, never guessed from a possibly stale SSE overview.
      function trackAccessChange(label, response) {
        const revisions = response && response.device
          ? [{ deviceId: response.device.deviceId,
               desiredRevision: response.device.desiredRevision }]
          : response && Array.isArray(response.revisions)
            ? response.revisions : [];
        if (revisions.length === 0) {
          if (response && typeof response.removed === "string" &&
              Array.isArray(response.revisions)) {
            // Directory-only removal needs no device ACK; never invent one.
            showToast("Operator " + response.removed +
              " removed from owner directory. No active device grants to revoke.",
              "info", "operator-directory-removed");
          } else {
            showToast(label + " accepted with no device policy revisions. Review current access state.",
              "info", "policy-no-change");
          }
          return;
        }
        const pendingToast = showToast(
          label + " submitted for " + revisions.length +
            " device(s). Waiting for device confirmation.",
          "pending",
          "policy-pending",
        );
        const batch = { toastEl: pendingToast, remainingIds: new Set() };
        revisions.forEach(function (item) {
          const revision = Number(item.desiredRevision);
          if (!item.deviceId || !Number.isInteger(revision) || revision <= 0) return;
          const prior = trackedAccessUpdates.get(item.deviceId);
          if (prior) settleTrackedEntry(item.deviceId, prior);
          batch.remainingIds.add(item.deviceId);
          trackedAccessUpdates.set(item.deviceId, {
            revision: revision,
            label: label,
            batch: batch,
          });
        });
        if (currentOverview) reconcileAccessChanges(currentOverview.devices || []);
      }

      function reconcileAccessChanges(devices) {
        trackedAccessUpdates.forEach(function (change, id) {
          const d = devices.find(function (item) { return item.deviceId === id; });
          if (!d) return;
          if (d.syncStatus === "failed" && Number(d.desiredRevision) >= change.revision) {
            settleTrackedEntry(id, change);
            showToast(id + ": access change rejected by device. Review sync error.",
              "error", "policy-rejected");
          } else if (Number(d.desiredRevision) > change.revision) {
            settleTrackedEntry(id, change);
            showToast(id + ": another update superseded this change; review current permissions.",
              "pending", "policy-superseded");
          } else if (d.online && d.confirmedByDevice === true &&
                     d.syncStatus === "applied" &&
                     Number(d.appliedRevision) === change.revision) {
            settleTrackedEntry(id, change);
            showToast(id + ": " + change.label +
              " confirmed by device (policy v" + change.revision +
              "). Other local provider restrictions may still apply.",
              "confirmed", "policy-confirmed");
          }
        });
      }

      // Optional passive alerts for changes made from another session.
      // Permission-change action feedback remains enabled regardless.
      function observeExternalChanges(devices) {
        const seen = new Set();
        devices.forEach(function (d) {
          seen.add(d.deviceId);
          const now = { desired: Number(d.desiredRevision), status: d.syncStatus };
          const prior = lastDeviceState.get(d.deviceId);
          lastDeviceState.set(d.deviceId, now);
          if (!livePageAlerts || !prior || trackedAccessUpdates.has(d.deviceId)) return;
          if (now.desired > prior.desired) {
            showToast(d.deviceId + ": permission policy changed; awaiting device sync.",
              "pending", "external-policy");
          } else if (now.status === "failed" && prior.status !== "failed") {
            showToast(d.deviceId + ": permission synchronization rejected.",
              "error", "external-policy");
          } else if (now.status === "applied" && prior.status !== "applied" &&
                     d.online && d.confirmedByDevice) {
            showToast(d.deviceId + ": permission update confirmed.",
              "confirmed", "external-policy");
          }
        });
        Array.from(lastDeviceState.keys()).forEach(function (id) {
          if (!seen.has(id)) lastDeviceState.delete(id);
        });
      }

      liveAlertsBtn.addEventListener("click", function () {
        if (!authenticatedOwner) {
          showToast("Sign in first to enable passive live page alerts.", "error", "alert-settings");
          return;
        }
        livePageAlerts = !livePageAlerts;
        liveAlertsBtn.textContent = livePageAlerts
          ? "Mute live page alerts" : "Enable live page alerts";
        liveAlertsBtn.setAttribute("aria-pressed", livePageAlerts ? "true" : "false");
        showToast(livePageAlerts
          ? "Live page alerts enabled. This does not enable iPhone background push."
          : "Passive live page alerts muted. Action confirmations remain on.",
          "info", "alert-settings");
      });

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
        connectBtn.disabled = true;
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
        } finally {
          connectBtn.disabled = false;
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
        refreshBtn.disabled = true;
        try {
          do {
            overviewQueued = false;
            showBanner("");
            const data = await apiCall("/portal/api/overview", "GET");
            if (!authenticatedOwner) return;
            lastUpdatedMs = Date.now();
            currentOverview = data;
            renderOverview(data);
            observeExternalChanges(data.devices || []);
            reconcileAccessChanges(data.devices || []);
            syncPendingFallback(data.devices || []);
          } while (overviewQueued && authenticatedOwner);
        } catch (err) {
          if (authenticatedOwner) {
            showBanner("Portal notice: " + err.message);
          }
        } finally {
          overviewInFlight = false;
          refreshBtn.disabled = false;
        }
      }

      function populateCanonicalOps(opsByFamily) {
        if (!canonicalOpsList || !opsByFamily || typeof opsByFamily !== "object") return;
        const ops = [];
        Object.keys(opsByFamily).forEach(function (fam) {
          const list = opsByFamily[fam];
          if (Array.isArray(list)) {
            list.forEach(function (op) {
              if (typeof op === "string") ops.push(op);
            });
          }
        });
        if (ops.length === 0) return;
        canonicalOpsList.replaceChildren.apply(
          canonicalOpsList,
          ops.map(function (op) {
            return createEl("option", { attrs: { value: op } });
          }),
        );
      }

      function renderFleetToolbar(devices) {
        if (!fleetFilterBar) return;
        if (devices.length === 0) {
          fleetFilterBar.replaceChildren();
          return;
        }
        const onlineCount = devices.filter(function (d) { return Boolean(d.online); }).length;
        const offlineCount = devices.length - onlineCount;
        const attentionCount = devices.filter(deviceNeedsAttention).length;

        const defs = [
          { id: "all", label: "All (" + devices.length + ")" },
          { id: "online", label: "Online (" + onlineCount + ")" },
          { id: "offline", label: "Offline (" + offlineCount + ")" },
          {
            id: "attention",
            label: "Attention (" + attentionCount + ")",
            title: "Offline, pending device ACK, failed sync, degraded provider, or lockdown",
          },
        ];
        const group = createEl(
          "div",
          { className: "filter-group", attrs: { role: "group", "aria-label": "Filter devices" } },
          defs.map(function (def) {
            const attrs = {
              "aria-pressed": activeFleetFilter === def.id ? "true" : "false",
            };
            if (def.title) attrs.title = def.title;
            return createEl("button", {
              type: "button",
              className: "filter-pill",
              text: def.label,
              attrs: attrs,
              dataset: {
                action: "fleet-filter",
                filter: def.id,
              },
            });
          }),
        );

        const updatedText = lastUpdatedMs
          ? "Updated " + formatTimeLabel(lastUpdatedMs)
          : "";
        fleetFilterBar.replaceChildren(
          group,
          createEl("span", { className: "fleet-meta", text: updatedText }),
        );
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
        let focusedOpDeviceId = null;
        let focusedSelStart = null;
        let focusedSelEnd = null;
        const activeEl = document.activeElement;

        document.querySelectorAll(".device-card[data-device-id]").forEach(function (cardEl) {
          const id = cardEl.dataset.deviceId;
          const detailsEl = cardEl.querySelector("details.advanced-box");
          if (id && detailsEl) {
            if (detailsEl.open) openAdvancedDevices.add(id);
            else openAdvancedDevices.delete(id);
          }
          const inputEl = cardEl.querySelector("[data-role='op-rule-input']");
          if (id && inputEl) {
            if (inputEl.value) draftOpRules[id] = inputEl.value;
            if (inputEl === activeEl) {
              focusedOpDeviceId = id;
              focusedSelStart = inputEl.selectionStart;
              focusedSelEnd = inputEl.selectionEnd;
            }
          }
        });

        populateCanonicalOps(data.canonicalOperationsByFamily);

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

        const globalLiftBtn = document.getElementById("global-lift-lockdown-btn");
        if (anyLockdown) {
          globalLiftBtn.classList.remove("hidden");
        } else {
          globalLiftBtn.classList.add("hidden");
        }

        renderFleetToolbar(devices);

        const container = document.getElementById("devices-container");
        if (devices.length === 0) {
          container.replaceChildren(
            createEl("div", {
              className: "panel-card",
              text: "No paired devices found for this owner account.",
            }),
          );
          updateSelectionIndicators();
          renderIdentities(data);
          renderAuditAndSnapshots(data);
          return;
        }

        const visibleDevices = devices.filter(function (dev) {
          if (activeFleetFilter === "online") return Boolean(dev.online);
          if (activeFleetFilter === "offline") return !dev.online;
          if (activeFleetFilter === "attention") return deviceNeedsAttention(dev);
          return true;
        });

        if (visibleDevices.length === 0) {
          container.replaceChildren(
            createEl("div", { className: "panel-card" }, [
              createEl("div", {
                className: "muted-note",
                text: "No devices match the current filter.",
              }),
              createEl("div", { className: "snapshot-more-wrap" }, [
                createEl("button", {
                  type: "button",
                  text: "Show All Devices",
                  dataset: { action: "fleet-filter", filter: "all" },
                }),
              ]),
            ]),
          );
          updateSelectionIndicators();
          renderIdentities(data);
          renderAuditAndSnapshots(data);
          return;
        }

        const cards = visibleDevices.map(function (dev) {
          const cardStateClasses = ["device-card"];
          if (dev.emergencyLockdown) cardStateClasses.push("is-lockdown");
          else if (dev.syncStatus === "failed") cardStateClasses.push("is-failed");
          else if (dev.syncStatus === "pending") cardStateClasses.push("is-pending");
          if (selectedDeviceIds.has(dev.deviceId)) cardStateClasses.push("is-selected");

          const card = createEl("article", {
            className: cardStateClasses.join(" "),
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
              createEl("input", {
                type: "checkbox",
                className: "device-select-cb",
                checked: selectedDeviceIds.has(dev.deviceId),
                attrs: { "aria-label": "Select device " + dev.deviceId },
                dataset: { action: "select-device", device: dev.deviceId },
              }),
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

          const syncDetail = formatSyncDetail(dev);
          const syncDetailEl = createEl("div", {
            className: "sync-detail " + syncDetail.cls,
            dataset: { syncDetail: dev.deviceId },
            text: syncDetail.text,
          });

          card.appendChild(header);
          card.appendChild(metaRow);
          card.appendChild(syncDetailEl);

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
            const isPartial = !isOn && policyCount > 0;
            const isDegraded = Boolean(dev.online) && !fam.providerAvailable;
            const subText =
              !dev.online
                ? "Offline (" + policyCount + " policy-granted)"
                : !fam.providerAvailable
                  ? "Unavailable (" + policyCount + " policy-granted)"
                  : fam.grantedOperations.length + "/" + fam.availableOperations.length + " ops active";
            const switchLabel = isOn ? "ON" : isPartial ? "PARTIAL" : "OFF";
            const switchClass = isOn ? "on" : isPartial ? "partial" : "off";
            const switchPressed = isOn ? "true" : isPartial ? "mixed" : "false";
            const tileClasses = ["family-toggle"];
            if (isOn) tileClasses.push("granted");
            else if (isPartial) tileClasses.push("partial");
            if (isDegraded) tileClasses.push("degraded");

            const row = createEl(
              "div",
              {
                className: tileClasses.join(" "),
                ...(fam.unavailableReason ? { attrs: { title: fam.unavailableReason } } : {}),
              },
              [
                createEl("div", null, [
                  createEl("span", { className: "family-name", text: fam.family }),
                  createEl("span", { className: "family-sub", text: subText }),
                ]),
                createEl("button", {
                  type: "button",
                  className: "switch-btn " + switchClass,
                  text: switchLabel,
                  attrs: {
                    "aria-pressed": switchPressed,
                    title: isPartial
                      ? "Partial access (" + policyCount + " ops granted). Click to grant full family."
                      : isOn
                        ? "Full family granted. Click to revoke family."
                        : "Family revoked. Click to grant full family.",
                  },
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

          const actionButtons = [];
          if (dev.emergencyLockdown) {
            actionButtons.push(
              createEl("button", {
                type: "button",
                className: "primary",
                text: "Lift Lockdown",
                attrs: {
                  title:
                    "Lifts emergency lockdown and restores baseline Universal Access. Use Recoverable Snapshots & Rollback below to restore prior custom restrictions.",
                },
                dataset: { action: "lift-lockdown", device: dev.deviceId },
              }),
            );
          }
          [
            { id: "universal", label: "Grant All (Universal)" },
            { id: "read_only", label: "Read-Only" },
            { id: "lockdown", label: "Revoke All" },
          ].forEach(function (preset) {
            const isCurrent = !dev.emergencyLockdown && profileId === preset.id;
            actionButtons.push(
              createEl("button", {
                type: "button",
                className: isCurrent ? "active-profile" : "",
                text: preset.label,
                attrs: { "aria-pressed": isCurrent ? "true" : "false" },
                dataset: {
                  action: "device-profile",
                  device: dev.deviceId,
                  profile: preset.id,
                },
              }),
            );
          });
          card.appendChild(createEl("div", { className: "device-actions-row" }, actionButtons));

          const deniedCaps =
            (dev.policy && dev.policy.owner_policy && dev.policy.owner_policy.denied_capabilities) ||
            [];
          const ruleInput = createEl("input", {
            type: "text",
            className: "op-rule-input",
            attrs: {
              placeholder: "e.g. filesystem.write",
              list: "canonical-ops-list",
              autocomplete: "off",
            },
            dataset: { role: "op-rule-input" },
          });
          if (draftOpRules[dev.deviceId]) {
            ruleInput.value = draftOpRules[dev.deviceId];
          }
          const opRulesChildren = [
            createEl("div", {
              className: "op-rules-note",
              text:
                "Explicitly denied operations override inherited universal grants: " +
                (deniedCaps.length ? deniedCaps.join(", ") : "None"),
            }),
          ];
          if (deniedCaps.length > 0) {
            opRulesChildren.push(
              createEl(
                "div",
                { className: "denied-chips-row" },
                deniedCaps.map(function (cap) {
                  return createEl("button", {
                    type: "button",
                    className: "denied-chip-btn",
                    text: cap + " × Allow",
                    attrs: {
                      title: "Remove explicit deny for " + cap,
                      "aria-label": "Allow " + cap + " on " + dev.deviceId,
                    },
                    dataset: {
                      action: "allow-denied-op",
                      device: dev.deviceId,
                      capability: cap,
                    },
                  });
                }),
              ),
            );
          }
          opRulesChildren.push(
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
          );
          const detailsBox = createEl("details", { className: "advanced-box" }, [
            createEl("summary", {
              text: "Advanced Operation Rules & Explicit Denies (" + deniedCaps.length + ")",
            }),
            createEl("div", { className: "op-rules-wrap" }, opRulesChildren),
          ]);
          if (openAdvancedDevices.has(dev.deviceId)) {
            detailsBox.open = true;
          }
          card.appendChild(detailsBox);
          return card;
        });

        container.replaceChildren.apply(container, cards);
        if (focusedOpDeviceId) {
          const restoredInput = container.querySelector(
            '.device-card[data-device-id="' +
              CSS.escape(focusedOpDeviceId) +
              '"] [data-role="op-rule-input"]',
          );
          if (restoredInput) {
            restoredInput.focus();
            if (typeof focusedSelStart === "number" && typeof focusedSelEnd === "number") {
              try {
                restoredInput.setSelectionRange(focusedSelStart, focusedSelEnd);
              } catch {
                // ignore selection errors
              }
            }
          }
        }
        updateSelectionIndicators();
        renderIdentities(data);
        renderAuditAndSnapshots(data);
      }

      function renderIdentities(data) {
        const container = document.getElementById("identities-container");
        const usage = data.identityUsage || [];
        const operators = data.operators || [];
        const devices = data.devices || [];
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
          const grants = devices.reduce(function (acc, dev) {
            const opPol =
              dev.policy &&
              dev.policy.operator_policies &&
              dev.policy.operator_policies[op.principalId];
            if (opPol) {
              acc.push(dev.deviceId + " (" + String(opPol.profile_id || "custom") + ")");
            }
            return acc;
          }, []);
          nodes.push(
            createEl("div", { className: "list-item identity-row" }, [
              createEl("div", { className: "identity-main" }, [
                createEl("strong", { text: "Operator: " }),
                String(op.principalId || "") + " (" + String(op.displayName || "") + ")",
                createEl("div", {
                  className: "audit-meta",
                  text:
                    "Device grants: " + (grants.length ? grants.join(", ") : "None active"),
                }),
              ]),
              createEl("div", { className: "identity-actions" }, [
                createEl("button", {
                  type: "button",
                  text: "Edit",
                  dataset: { action: "edit-operator", principal: op.principalId },
                }),
                createEl("button", {
                  type: "button",
                  className: "danger",
                  text: "Revoke",
                  dataset: { action: "remove-operator", principal: op.principalId },
                }),
              ]),
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
            const delivery = formatDeliveryStatus(ev.deliveryStatus);
            const ts = formatTimeLabel(ev.timestampMs || ev.timestampIso);
            const topRow = createEl("div", { className: "audit-top-row" }, [
              createEl("strong", { text: formatAuditAction(ev.action) }),
              ev.deviceId ? " on " : null,
              ev.deviceId ? createEl("code", { text: ev.deviceId }) : null,
              createEl("span", {
                className: "pill " + delivery.cls,
                text: delivery.label,
              }),
            ]);
            const metaParts = [];
            if (ts) metaParts.push(ts);
            if (ev.reason) metaParts.push(String(ev.reason));
            if (ev.actorPrincipalId) metaParts.push("by " + String(ev.actorPrincipalId));
            const metaRow = createEl("div", {
              className: "audit-meta",
              text: metaParts.join(" • "),
            });
            return createEl("div", { className: "list-item" }, [topRow, metaRow]);
          });
          auditEl.replaceChildren.apply(auditEl, eventNodes);
        }

        const snaps = data.snapshots || [];
        const filterSelect = document.getElementById("snapshot-device-filter");
        const deviceOptions = [];
        const seenFilterIds = new Set();
        (data.devices || []).forEach(function (d) {
          if (d.deviceId && !seenFilterIds.has(d.deviceId)) {
            seenFilterIds.add(d.deviceId);
            deviceOptions.push(d.deviceId);
          }
        });
        snaps.forEach(function (s) {
          if (s.deviceId && !seenFilterIds.has(s.deviceId)) {
            seenFilterIds.add(s.deviceId);
            deviceOptions.push(s.deviceId);
          }
        });
        if (snapshotFilterDevice && !seenFilterIds.has(snapshotFilterDevice) && deviceOptions.length > 0) {
          snapshotFilterDevice = "";
          snapshotLimit = SNAPSHOT_PAGE_SIZE;
        }
        const optNodes = [
          createEl("option", { attrs: { value: "" }, text: "All devices" }),
        ].concat(
          deviceOptions.map(function (id) {
            return createEl("option", { attrs: { value: id }, text: id });
          }),
        );
        filterSelect.replaceChildren.apply(filterSelect, optNodes);
        filterSelect.value = snapshotFilterDevice;

        const filteredSnaps = snapshotFilterDevice
          ? snaps.filter(function (s) { return s.deviceId === snapshotFilterDevice; })
          : snaps;
        const visibleSnaps = filteredSnaps.slice(0, snapshotLimit);

        const snapEl = document.getElementById("snapshots-container");
        if (visibleSnaps.length === 0) {
          snapEl.replaceChildren(
            createEl("div", { className: "muted-note", text: "No recoverable snapshots found." }),
          );
        } else {
          const snapNodes = visibleSnaps.map(function (s) {
            const snapTime = formatTimeLabel(s.createdAtMs);
            return createEl("div", { className: "list-item snapshot-row" }, [
              createEl("span", null, [
                createEl("code", { text: s.deviceId }),
                " rev " +
                  String(s.revision) +
                  (snapTime ? " (" + snapTime + ")" : "") +
                  ": " +
                  String(s.reason || ""),
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

        const pagEl = document.getElementById("snapshots-pagination");
        if (filteredSnaps.length > visibleSnaps.length) {
          pagEl.replaceChildren(
            createEl("button", {
              type: "button",
              attrs: { id: "snapshots-more-btn" },
              dataset: { action: "snapshots-more" },
              text:
                "Show more snapshots (" +
                visibleSnaps.length +
                "/" +
                filteredSnaps.length +
                ")",
            }),
          );
        } else {
          pagEl.replaceChildren();
        }
      }

      document.addEventListener("change", function (e) {
        const cb = e.target.closest('input[data-action="select-device"]');
        if (!cb) return;
        const deviceId = cb.dataset.device;
        if (!deviceId) return;
        if (cb.checked) selectedDeviceIds.add(deviceId);
        else selectedDeviceIds.delete(deviceId);
        updateSelectionIndicators();
      });

      document.getElementById("snapshot-device-filter").addEventListener("change", function (e) {
        snapshotFilterDevice = e.target.value;
        snapshotLimit = SNAPSHOT_PAGE_SIZE;
        if (currentOverview) {
          renderAuditAndSnapshots(currentOverview);
        }
      });

      document.getElementById("select-all-devices-btn").addEventListener("click", function () {
        const devices = (currentOverview && currentOverview.devices) || [];
        devices.forEach(function (d) {
          selectedDeviceIds.add(d.deviceId);
        });
        updateSelectionIndicators();
      });

      document.getElementById("clear-selected-devices-btn").addEventListener("click", function () {
        selectedDeviceIds.clear();
        updateSelectionIndicators();
      });

      document.addEventListener("click", async function (e) {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const deviceId = btn.dataset.device;
        try {
          if (action === "fleet-filter") {
            activeFleetFilter = btn.dataset.filter || "all";
            if (currentOverview) {
              renderOverview(currentOverview);
            }
          } else if (action === "toggle-family") {
            const family = btn.dataset.family;
            const currentlyOn = btn.dataset.currentlyOn === "1";
            btn.disabled = true;
            const result = await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              grantFamilies: currentlyOn ? [] : [family],
              revokeFamilies: currentlyOn ? [family] : [],
              reason: (currentlyOn ? "Revoke " : "Grant ") + family + " family via Portal toggle",
            });
            trackAccessChange((currentlyOn ? "Revoke " : "Grant ") + family + " access", result);
            await loadOverview();
          } else if (action === "device-profile") {
            const profileId = btn.dataset.profile;
            btn.disabled = true;
            const result = await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              profileId: profileId,
              emergencyLockdown: false,
              reason: "Apply " + profileId + " profile via Portal",
            });
            trackAccessChange("Set " + profileId + " access profile", result);
            await loadOverview();
          } else if (action === "lift-lockdown") {
            btn.disabled = true;
            const result = await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              emergencyLockdown: false,
              profileId: "universal",
              reason: "Lift emergency lockdown on " + deviceId + " via Portal",
            });
            trackAccessChange("Lift device lockdown", result);
            await loadOverview();
          } else if (action === "deny-op" || action === "allow-op") {
            const card = btn.closest(".device-card");
            const input = card ? card.querySelector("[data-role='op-rule-input']") : null;
            const cap = input ? input.value.trim() : "";
            if (!cap) return;
            btn.disabled = true;
            const result = await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              grantCapabilities: action === "allow-op" ? [cap] : [],
              revokeCapabilities: action === "deny-op" ? [cap] : [],
              reason: (action === "deny-op" ? "Explicitly deny " : "Grant ") + cap,
            });
            if (input) input.value = "";
            trackAccessChange((action === "deny-op" ? "Deny " : "Grant ") + cap, result);
            await loadOverview();
          } else if (action === "allow-denied-op") {
            const cap = btn.dataset.capability || "";
            if (!cap) return;
            btn.disabled = true;
            const result = await apiCall("/portal/api/devices/" + encodeURIComponent(deviceId) + "/policy", "POST", {
              grantCapabilities: [cap],
              revokeCapabilities: [],
              reason: "Grant " + cap,
            });
            trackAccessChange("Grant " + cap, result);
            await loadOverview();
          } else if (action === "rollback") {
            const rev = Number(btn.dataset.rev);
            btn.disabled = true;
            const result = await apiCall("/portal/api/rollback", "POST", {
              deviceId: deviceId,
              targetRevision: rev,
              reason: "Rollback to revision " + rev + " from Portal",
            });
            trackAccessChange("Rollback to revision " + rev, result);
            await loadOverview();
          } else if (action === "snapshots-more") {
            snapshotLimit += SNAPSHOT_PAGE_SIZE;
            if (currentOverview) {
              renderAuditAndSnapshots(currentOverview);
            }
          } else if (action === "edit-operator") {
            const principalId = btn.dataset.principal || "";
            if (!principalId || !currentOverview) return;
            const opMeta = (currentOverview.operators || []).find(function (o) {
              return o.principalId === principalId;
            });
            const detailsBox = document.getElementById("operator-advanced-box");
            if (detailsBox) detailsBox.open = true;
            document.getElementById("op-principal-id").value = principalId;
            const displayInput = document.getElementById("op-display-name");
            displayInput.value = (opMeta && opMeta.displayName) || principalId;

            const matchingDeviceIds = [];
            let matchedProfile = null;
            (currentOverview.devices || []).forEach(function (dev) {
              const opPol =
                dev.policy &&
                dev.policy.operator_policies &&
                dev.policy.operator_policies[principalId];
              if (opPol) {
                matchingDeviceIds.push(dev.deviceId);
                if (!matchedProfile && opPol.profile_id) {
                  matchedProfile = opPol.profile_id;
                }
              }
            });
            const profileSelect = document.getElementById("op-profile-id");
            if (
              matchedProfile &&
              Array.from(profileSelect.options).some(function (o) {
                return o.value === matchedProfile;
              })
            ) {
              profileSelect.value = matchedProfile;
            }
            if (matchingDeviceIds.length > 0) {
              selectedDeviceIds.clear();
              matchingDeviceIds.forEach(function (id) {
                selectedDeviceIds.add(id);
              });
              updateSelectionIndicators();
            }
            if (detailsBox && typeof detailsBox.scrollIntoView === "function") {
              detailsBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
            displayInput.focus();
          } else if (action === "remove-operator") {
            const principalId = btn.dataset.principal || "";
            if (!principalId) return;
            btn.disabled = true;
            const result = await apiCall("/portal/api/operators/" + encodeURIComponent(principalId), "DELETE");
            trackAccessChange("Revoke operator access", result);
            await loadOverview();
          }
        } catch (err) {
          showBanner("Action failed: " + err.message);
          showToast("Access change rejected: " + err.message, "error", "policy-error");
        } finally {
          btn.disabled = false;
        }
      });

      function closeConfirmModal() {
        pendingModalAction = null;
        confirmModal.classList.remove("active");
        if (lastModalTrigger && typeof lastModalTrigger.focus === "function") {
          lastModalTrigger.focus();
        }
        lastModalTrigger = null;
      }

      function openConfirmModal(title, desc, onConfirm) {
        lastModalTrigger = document.activeElement;
        document.getElementById("modal-title").textContent = title;
        document.getElementById("modal-desc").textContent = desc;
        const reasonInput = document.getElementById("modal-reason");
        reasonInput.value = "";
        pendingModalAction = onConfirm;
        confirmModal.classList.add("active");
        reasonInput.focus();
      }

      function scopeDescriptionText() {
        const selected = Array.from(selectedDeviceIds);
        return selected.length > 0
          ? "the " + selected.length + " selected device(s) (" + selected.join(", ") + ")"
          : "every paired device";
      }

      document.getElementById("modal-cancel-btn").addEventListener("click", closeConfirmModal);

      confirmModal.addEventListener("click", function (e) {
        if (e.target === confirmModal) {
          closeConfirmModal();
        }
      });

      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && confirmModal.classList.contains("active")) {
          e.preventDefault();
          closeConfirmModal();
        }
      });

      document.getElementById("modal-reason").addEventListener("keydown", function (e) {
        if (e.key === "Enter" && confirmModal.classList.contains("active")) {
          e.preventDefault();
          document.getElementById("modal-confirm-btn").click();
        }
      });

      document.getElementById("modal-confirm-btn").addEventListener("click", async function () {
        if (!pendingModalAction) return;
        const reason = document.getElementById("modal-reason").value.trim();
        const title = document.getElementById("modal-title").textContent || "Global permissions";
        const fn = pendingModalAction;
        closeConfirmModal();
        try {
          const result = await fn(reason);
          trackAccessChange(title, result);
          await loadOverview();
        } catch (err) {
          showBanner("Global action failed: " + err.message);
          showToast("Security change rejected: " + err.message, "error", "policy-error");
        }
      });

      document.getElementById("global-universal-btn").addEventListener("click", function () {
        const scopeIds = Array.from(selectedDeviceIds);
        openConfirmModal(
          "Grant Universal Access",
          "This will enable all six MCP tool families (auto-allowing destructive file replacements and AI-owned process termination, while human-origin process termination and unshared human tabs/windows remain blocked) on " + scopeDescriptionText() + ".",
          function (reason) {
            return apiCall("/portal/api/global/apply", "POST", {
              confirm: true,
              profileId: "universal",
              emergencyLockdown: false,
              ...(scopeIds.length > 0 ? { deviceIds: scopeIds } : {}),
              reason: reason || "Global grant universal access",
            });
          },
        );
      });

      document.getElementById("global-readonly-btn").addEventListener("click", function () {
        const scopeIds = Array.from(selectedDeviceIds);
        openConfirmModal(
          "Apply Read-Only Profile",
          "This will restrict " + scopeDescriptionText() + " to non-destructive inspection operations.",
          function (reason) {
            return apiCall("/portal/api/global/apply", "POST", {
              confirm: true,
              profileId: "read_only",
              ...(scopeIds.length > 0 ? { deviceIds: scopeIds } : {}),
              reason: reason || "Global read-only profile",
            });
          },
        );
      });

      document.getElementById("global-revoke-btn").addEventListener("click", function () {
        const scopeIds = Array.from(selectedDeviceIds);
        openConfirmModal(
          "Revoke All Tool Families",
          "This will disable all six MCP tool families on " + scopeDescriptionText() + " until re-enabled.",
          function (reason) {
            return apiCall("/portal/api/global/apply", "POST", {
              confirm: true,
              profileId: "lockdown",
              ...(scopeIds.length > 0 ? { deviceIds: scopeIds } : {}),
              reason: reason || "Global revoke all tool families",
            });
          },
        );
      });

      document.getElementById("global-lift-lockdown-btn").addEventListener("click", function () {
        const scopeIds = Array.from(selectedDeviceIds);
        openConfirmModal(
          "Lift Emergency Access Lockdown",
          "This will lift emergency lockdown and restore baseline Universal Access (all six MCP tool families, auto-allowing destructive operations subject to human-coexistence protections) on " + scopeDescriptionText() + ". To restore prior custom restrictions instead, use Recoverable Snapshots & Rollback below.",
          function (reason) {
            return apiCall("/portal/api/global/emergency-revoke", "POST", {
              confirm: true,
              restore: true,
              ...(scopeIds.length > 0 ? { deviceIds: scopeIds } : {}),
              reason: reason || "Lift emergency access lockdown from Portal",
            });
          },
        );
      });

      document.getElementById("emergency-revoke-btn").addEventListener("click", function () {
        const scopeIds = Array.from(selectedDeviceIds);
        openConfirmModal(
          "Emergency Access Revocation",
          "Immediate lockdown on " + scopeDescriptionText() + ". All owner and operator capabilities will be blocked until lifted.",
          function (reason) {
            return apiCall("/portal/api/global/emergency-revoke", "POST", {
              confirm: true,
              ...(scopeIds.length > 0 ? { deviceIds: scopeIds } : {}),
              reason: reason || "Emergency access revocation triggered from Portal",
            });
          },
        );
      });

      document.getElementById("save-operator-btn").addEventListener("click", async function () {
        const principalInput = document.getElementById("op-principal-id");
        const displayInput = document.getElementById("op-display-name");
        const principalId = principalInput.value.trim();
        const displayName = displayInput.value.trim();
        const profileId = document.getElementById("op-profile-id").value;
        if (!principalId) return;
        const scopeIds = Array.from(selectedDeviceIds);
        try {
          const result = await apiCall("/portal/api/operators", "POST", {
            principalId: principalId,
            displayName: displayName || principalId,
            profileId: profileId,
            ...(scopeIds.length > 0 ? { deviceIds: scopeIds } : {}),
            reason: "Configured operator " + principalId + " (" + profileId + ")",
          });
          principalInput.value = "";
          displayInput.value = "";
          trackAccessChange("Operator access policy", result);
          await loadOverview();
        } catch (err) {
          showBanner("Operator update failed: " + err.message);
          showToast("Operator update rejected: " + err.message, "error", "policy-error");
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

      renderSignedOutWelcome();
      if (oidcMode && new URLSearchParams(location.search).has("login_error")) {
        history.replaceState(null, "", "/portal");
        showBanner("TetherAuth sign-in was not completed. Please try again.");
      }
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
  "manifest-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");


// Installable, minimally privileged Home Screen entry point.
// This is not Web Push: it registers no service worker or subscription.
export function renderControlPortalManifest(): string {
  return JSON.stringify({
    id: "/portal",
    name: "Tetherplane Control Portal",
    short_name: "Tetherplane",
    description: "Owner-authorized permissions for connected devices",
    start_url: "/portal",
    scope: "/portal",
    display: "standalone",
    background_color: "#090d14",
    theme_color: "#090d14",
  });
}

export function renderControlPortalPage(
  options: { loginMode?: "token" | "oidc" } = {},
): {
  html: string;
  contentSecurityPolicy: string;
} {
  return {
    html: renderControlPortalHtml(options.loginMode),
    contentSecurityPolicy: PORTAL_CONTENT_SECURITY_POLICY,
  };
}

export function renderControlPortalHtml(loginMode: "token" | "oidc" = "token"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tetherplane Control Portal</title>
  <meta name="theme-color" content="#090d14" />
  <link rel="manifest" href="/portal/manifest.webmanifest" />
  <style>${PORTAL_STYLE}</style>
</head>
<body data-auth="signed-out" data-login-mode="${loginMode}">
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
        <span id="live-stream-badge" class="pill offline">Connecting</span>
        <input id="token-input" class="${loginMode === "oidc" ? "hidden" : ""}" type="password" placeholder="Owner Bearer Token" aria-label="Owner Bearer Token" autocomplete="off" />
        <button id="connect-btn" class="primary ${loginMode === "oidc" ? "hidden" : ""}" type="button">Connect</button>
        <a id="oidc-signin-link" class="oidc-signin-link ${loginMode === "oidc" ? "" : "hidden"}" href="/portal/auth/start">Sign in with TetherAuth</a>
        <button id="refresh-btn" type="button">Refresh</button>
        <button id="live-alerts-btn" type="button" aria-pressed="false">Enable live page alerts</button>
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

    <main>
      <div id="status-banner" class="unavailable-banner status-banner-outer hidden"></div>
      <div id="fleet-filter-bar" class="fleet-toolbar" aria-label="Fleet filters"></div>
      <section class="devices-grid" id="devices-container" aria-label="Connected Devices">
        <div class="signed-out-card">${loginMode === "oidc" ? "Sign in with TetherAuth to view your authorized devices." : "Enter your owner token above to load paired Tetherplane devices."}</div>
      </section>

      <p class="live-alerts-note">Notifications appear only while this portal page is open. iPhone background push is not yet configured.</p>
      <section class="global-panel" aria-label="Global Permission Controls">
        <div>
          <strong>Global Controls</strong>
          <div class="global-subtitle">
            Apply a permission profile across selected devices (or all paired devices when none selected), or trigger emergency access revocation. Universal Access auto-approves allowed destructive operations while blocking human-origin process termination and protecting unshared human tabs/windows; Lift Emergency Lockdown restores baseline Universal Access (use Recoverable Snapshots &amp; Rollback below for prior custom restrictions).
          </div>
          <div class="global-scope-row">
            <span id="global-target-badge" class="pill offline">Target: All paired devices</span>
            <button id="select-all-devices-btn" type="button">Select All</button>
            <button id="clear-selected-devices-btn" type="button">Clear</button>
          </div>
        </div>
        <div class="global-actions">
          <button id="global-universal-btn" type="button">Grant Universal</button>
          <button id="global-readonly-btn" type="button">Set Read-Only</button>
          <button id="global-revoke-btn" type="button">Revoke All Families</button>
          <button id="global-lift-lockdown-btn" class="primary hidden" type="button">Lift Emergency Lockdown</button>
          <button id="emergency-revoke-btn" class="danger" type="button">Emergency Access Revocation</button>
        </div>
      </section>

      <div class="section-grid">
        <section class="panel-card" aria-label="Owner and Operator Identities">
          <h2>Owner &amp; Operator Identities</h2>
          <div id="identities-container" class="identities-list">
            No active identity telemetry yet.
          </div>
          <details id="operator-advanced-box" class="advanced-box">
            <summary>Authorize / Update Scoped Operator Identity</summary>
            <div class="op-form-stack">
              <div id="op-target-scope-note" class="muted-note">Applies to: All paired devices (select checkboxes above to scope)</div>
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
          <details id="snapshots-advanced-box" class="advanced-box advanced-box-spaced">
            <summary>Recoverable Snapshots &amp; Rollback</summary>
            <div class="snapshot-controls">
              <label class="muted-note" for="snapshot-device-filter">Filter device:</label>
              <select id="snapshot-device-filter">
                <option value="">All devices</option>
              </select>
            </div>
            <div id="snapshots-container" class="snapshots-scroll"></div>
            <div id="snapshots-pagination" class="snapshot-more-wrap"></div>
          </details>
        </section>
      </div>
    </main>
  </div>

  <datalist id="canonical-ops-list"></datalist>
  <div id="toast-stack" class="toast-stack" role="region" aria-label="Access and security notifications" aria-live="polite" aria-relevant="additions"></div>
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
