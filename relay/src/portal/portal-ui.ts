import { createHash } from "node:crypto";

const PORTAL_STYLE = `
    :root {
      --bg: #111110;
      --surface: #191918;
      --surface-elevated: #232321;
      --surface-subtle: #151514;
      --border: #353532;
      --border-strong: #585850;
      --text: #f4f2eb;
      --text-muted: #b3b1a8;
      --primary: #e9e5d9;
      --primary-hover: #ffffff;
      --primary-bg: #30302d;
      --success: #99d6a9;
      --success-bg: #21352a;
      --warning: #efc676;
      --warning-bg: #372d20;
      --danger: #f18c8c;
      --danger-bg: #3a2424;
      --radius: 10px;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      --mono: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
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
    body[data-auth="signed-out"] .owner-nav,
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
      background: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      color: #111110;
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
      transition: none;
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
      color: #111110;
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
      color: #111110;
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
      border-color: var(--border-strong);
      color: var(--text);
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

    .owner-nav {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--surface-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 8px;
      margin: 0 0 16px;
    }

    .owner-nav a {
      display: inline-flex;
      flex: 1 1 0;
      justify-content: center;
      align-items: center;
      min-height: 44px;
      min-width: 0;
      border-radius: 8px;
      padding: 8px 12px;
      color: var(--text-muted);
      text-align: center;
      text-decoration: none;
      font-size: 0.86rem;
      font-weight: 600;
    }

    .owner-nav a:hover {
      background: var(--surface-elevated);
      color: var(--text);
    }

    .owner-nav a:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
      color: var(--text);
    }

    #devices-container, #global-controls, #owner-identities, #security-audit {
      scroll-margin-top: 16px;
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
      border-color: var(--border-strong);
      color: var(--text);
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
      outline: 1px solid var(--primary);
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
      border-color: var(--border-strong);
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
      color: var(--text);
      border-color: var(--border-strong);
    }

    .switch-btn.off {
      background: rgba(148, 163, 184, 0.16);
      color: var(--text-muted);
    }

    /* Configured policy is not the same as live, device-confirmed enforcement. */
    .switch-btn.configured {
      background: rgba(245, 158, 11, 0.14);
      color: #fcd34d;
      border-color: rgba(245, 158, 11, 0.55);
    }

    .family-toggle.configured {
      border-color: rgba(245, 158, 11, 0.45);
    }
    .family-toggle.configured .family-sub {
      color: #fcd34d;
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
      box-shadow: none;
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
      box-shadow: none;
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
      .portal-shell { padding: 12px 12px calc(96px + env(safe-area-inset-bottom, 0px)); }
      .topbar {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
        padding-bottom: 12px;
        margin-bottom: 12px;
      }
      .owner-nav {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 40;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 4px;
        margin: 0;
        padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px));
        border-width: 1px 0 0;
        border-radius: 0;
        background: var(--surface-subtle);
      }
      .owner-nav a {
        padding: 7px 4px;
        min-height: 44px;
        font-size: 0.8rem;
      }
      body[data-auth="signed-in"] .toast-stack {
        bottom: calc(72px + env(safe-area-inset-bottom, 0px));
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
    /* Instrument UI: native layout, system fonts, no raster/SVG assets, animation,
       canvas, filters, or compositor-heavy decorative effects. */
    .portal-shell { max-width: 1200px; padding-top: 24px; }
    .topbar { margin-bottom: 16px; }
    .brand-badge { border-radius: 6px; font-family: var(--mono); }
    .brand h1 { font-weight: 650; letter-spacing: -0.035em; }
    .brand p, .stat-label, .fleet-meta, .card-meta-row, .sync-detail,
    .pill, .audit-meta, .owner-nav a {
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
    }
    .brand p { font-size: 0.72rem; letter-spacing: 0.015em; }
    .summary-strip {
      gap: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      background: var(--surface);
    }
    .stat-card {
      min-height: 96px;
      border: 0;
      border-radius: 0;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 12px 16px;
    }
    .stat-card:last-child { border-right: 0; }
    .stat-label { font-size: 0.66rem; letter-spacing: 0.065em; }
    .stat-value {
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
      font-weight: 600;
      font-size: clamp(1.45rem, 3.2vw, 2.05rem);
      letter-spacing: -0.05em;
      line-height: 1.25;
    }
    .stat-value-compact { font-size: 0.95rem; letter-spacing: 0; }
    .stat-card.confirmed-readout {
      flex-direction: row;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .confirmed-readout .stat-value {
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      min-width: 56px;
      min-height: 56px;
      padding: 4px;
      margin: 0;
      border: 1px solid var(--border-strong);
      outline: 1px solid var(--border);
      outline-offset: 3px;
      border-radius: 50%;
      font-size: 1.25rem;
      letter-spacing: -0.055em;
    }
    .owner-nav {
      gap: 2px;
      padding: 4px;
      background: var(--surface-subtle);
      border-radius: var(--radius);
      margin-bottom: 18px;
    }
    .owner-nav a {
      border-radius: 5px;
      font-size: 0.75rem;
      letter-spacing: 0.035em;
      text-transform: uppercase;
    }
    .owner-nav a:hover, .owner-nav a:focus-visible {
      background: var(--surface-elevated);
    }
    .fleet-heading {
      display: flex;
      align-items: baseline;
      gap: 12px;
      justify-content: space-between;
      margin: 4px 0 10px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
    }
    .fleet-heading h2 { font-size: 1.15rem; margin: 0; font-weight: 600; letter-spacing: -0.025em; }
    .fleet-heading span {
      font-family: var(--mono);
      font-size: 0.68rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.07em;
    }
    body[data-auth="signed-out"] .fleet-heading { display: none; }
    .filter-pill {
      border-radius: 5px;
      min-height: 36px;
      font-size: 0.75rem;
    }
    .device-card { padding: 16px; gap: 10px; }
    .device-header { padding-bottom: 10px; border-bottom: 1px solid var(--border); }
    .device-title h3 { font-weight: 650; font-size: 1.08rem; }
    .card-meta-row, .sync-detail { font-size: 0.73rem; }
    .sync-detail { border-radius: 5px; padding: 8px; }
    .pill {
      border-radius: 4px;
      font-size: 0.68rem;
      padding: 4px 7px;
      font-weight: 600;
    }
    .pill.online::before, .pill.offline::before, .pill.applied::before,
    .pill.pending::before, .pill.failed::before, .pill.lockdown::before {
      content: "";
      width: 6px;
      height: 6px;
      flex: 0 0 6px;
      background: currentColor;
    }
    .pill.online, .pill.applied { color: var(--success); }
    .pill.pending { color: var(--warning); }
    .pill.failed, .pill.lockdown { color: var(--danger); }
    .family-grid {
      gap: 0;
      border: 1px solid var(--border);
      border-radius: 7px;
      overflow: hidden;
      background: var(--surface-subtle);
    }
    .family-toggle {
      background: transparent;
      border: 0;
      border-radius: 0;
      border-bottom: 1px solid var(--border);
      padding: 10px;
    }
    .family-toggle:nth-child(odd) { border-right: 1px solid var(--border); }
    .family-toggle.granted, .family-toggle.partial, .family-toggle.degraded,
    .family-toggle.configured { border-color: var(--border); }
    .family-name { font-size: 0.82rem; font-weight: 650; }
    .family-sub { font-size: 0.71rem; }
    .switch-btn {
      border-radius: 5px;
      font-family: var(--mono);
      font-size: 0.68rem;
      min-width: 60px;
      letter-spacing: 0.01em;
    }
    .switch-btn.on {
      background: var(--success-bg);
      color: var(--success);
      border-color: #496e53;
    }
    .switch-btn.partial { background: var(--primary-bg); }
    .switch-btn.configured { background: var(--warning-bg); color: var(--warning); }
    .device-actions-row { gap: 6px; }
    .device-actions-row button { font-size: 0.75rem; }
    .global-panel { align-items: flex-start; }
    .global-panel > div:first-child { flex: 1 1 100%; min-width: 0; }
    .global-actions { width: 100%; }
    .policy-explainer { margin-top: 8px; }
    .policy-explainer summary { cursor: pointer; color: var(--text-muted); font-size: 0.78rem; padding: 5px 0; }
    .policy-explainer .global-subtitle { max-width: 72ch; }
    .panel-card h2 { font-weight: 650; letter-spacing: -0.015em; }
    .modal { max-height: calc(100dvh - 32px); overflow-y: auto; }
    button.danger:hover:not(:disabled) { color: #111110; }
    @media (max-width: 860px) {
      .stat-card:nth-child(2) { border-right: 0; }
      .stat-card:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
    }
    @media (max-width: 600px) {
      .portal-shell { padding-top: 12px; }
      .topbar { margin-bottom: 10px; }
      .brand h1 { font-size: 1rem; }
      .stat-card { min-height: 76px; padding: 9px 10px; }
      .stat-label { font-size: 0.62rem; letter-spacing: 0.025em; }
      .stat-value { font-size: 1.55rem; }
      .stat-value-compact { font-size: 0.81rem; letter-spacing: 0; }
      .confirmed-readout .stat-value { min-width: 44px; min-height: 44px; font-size: 1rem; outline-offset: 2px; }
      .owner-nav { gap: 2px; padding: 6px 8px calc(6px + env(safe-area-inset-bottom, 0px)); border-radius: 0; margin: 0; }
      .owner-nav a { font-size: 0.67rem; }
      .fleet-heading { margin-top: 2px; }
      .fleet-heading h2 { font-size: 1rem; }
      .fleet-heading span { font-size: 0.62rem; }
      .device-card { padding: 12px; }
      .family-toggle:nth-child(odd) { border-right: 0; }
      .family-toggle:last-child { border-bottom: 0; }
      .filter-pill { min-height: 44px; }
      .global-actions button { flex: 1 1 130px; }
      .global-actions .danger { flex: 1 1 100%; }
      .policy-explainer summary, details.advanced-box summary { min-height: 44px; display: list-item; padding: 12px 0; }
    }

    /* Compact instrument controls. The dial is a read-only indicator, not a grant button.
       Six static CSS shapes, no timers, canvas, external assets, or animated effects. */
    .session-menu { position: relative; margin-left: auto; }
    .session-menu > summary {
      display: flex; align-items: center; justify-content: center; gap: 7px;
      min-height: 34px; padding: 7px 12px; cursor: pointer;
      border: 1px solid var(--border); border-radius: 6px;
      background: var(--surface-elevated); font-size: 0.8rem; font-weight: 600;
      list-style: none;
    }
    .session-menu > summary::-webkit-details-marker,
    .device-controls > summary::-webkit-details-marker { display: none; }
    .session-menu > summary::after { content: "+"; font-family: var(--mono); color: var(--text-muted); }
    .session-menu[open] > summary::after { content: "−"; }
    .session-menu[open] > summary { border-color: var(--border-strong); }
    .session-actions {
      position: absolute; right: 0; top: calc(100% + 6px); z-index: 50;
      width: min(220px, calc(100vw - 32px)); padding: 6px;
      display: grid; gap: 6px; background: var(--surface);
      border: 1px solid var(--border-strong); border-radius: 7px;
    }
    .session-actions button { width: 100%; text-align: left; min-height: 40px; }
    body[data-auth="signed-out"] .session-menu { display: none; }
    .session-menu > summary:focus-visible, .device-controls > summary:focus-visible,
    details.advanced-box > summary:focus-visible, .policy-explainer > summary:focus-visible {
      outline: 2px solid var(--primary); outline-offset: 2px;
    }
    .auth-bar { min-width: 0; }
    #auth-state-badge { overflow-wrap: anywhere; max-width: 100%; }
    .devices-grid { align-items: start; }
    .device-controls { border: 1px solid var(--border); border-radius: 8px; min-width: 0; background: var(--surface-subtle); }
    .device-controls > summary {
      display: grid; grid-template-columns: 72px minmax(0, 1fr) 30px;
      align-items: center; gap: 12px; min-height: 88px; padding: 9px 10px;
      cursor: pointer; list-style: none; border-radius: 7px;
    }
    .device-controls > summary:hover { background: var(--surface-elevated); }
    .device-controls[open] > summary { border-bottom: 1px solid var(--border); border-radius: 7px 7px 0 0; }
    .capability-dial {
      position: relative; display: block; width: 72px; height: 72px;
      flex: 0 0 72px; border-radius: 50%;
    }
    .capability-segment { position: absolute; inset: 0; background: #55554f; }
    .capability-segment:nth-child(1) { clip-path: polygon(52.14% 1.05%, 57.98% 1.65%, 63.71% 2.96%, 69.24% 4.94%, 74.50% 7.56%, 79.40% 10.80%, 83.88% 14.60%, 87.88% 18.91%, 91.33% 23.67%, 72.77% 35.49%, 70.87% 32.87%, 68.67% 30.50%, 66.20% 28.40%, 63.50% 26.62%, 60.60% 25.17%, 57.56% 24.08%, 54.40% 23.36%, 51.18% 23.03%); }
    .capability-segment:nth-child(2) { clip-path: polygon(93.46% 27.37%, 95.86% 32.74%, 97.60% 38.35%, 98.65% 44.13%, 99.00% 50.00%, 98.65% 55.87%, 97.60% 61.65%, 95.86% 67.26%, 93.46% 72.63%, 73.95% 62.47%, 75.27% 59.51%, 76.23% 56.42%, 76.81% 53.23%, 77.00% 50.00%, 76.81% 46.77%, 76.23% 43.58%, 75.27% 40.49%, 73.95% 37.53%); }
    .capability-segment:nth-child(3) { clip-path: polygon(91.33% 76.33%, 87.88% 81.09%, 83.88% 85.40%, 79.40% 89.20%, 74.50% 92.44%, 69.24% 95.06%, 63.71% 97.04%, 57.98% 98.35%, 52.14% 98.95%, 51.18% 76.97%, 54.40% 76.64%, 57.56% 75.92%, 60.60% 74.83%, 63.50% 73.38%, 66.20% 71.60%, 68.67% 69.50%, 70.87% 67.13%, 72.77% 64.51%); }
    .capability-segment:nth-child(4) { clip-path: polygon(47.86% 98.95%, 42.02% 98.35%, 36.29% 97.04%, 30.76% 95.06%, 25.50% 92.44%, 20.60% 89.20%, 16.12% 85.40%, 12.12% 81.09%, 8.67% 76.33%, 27.23% 64.51%, 29.13% 67.13%, 31.33% 69.50%, 33.80% 71.60%, 36.50% 73.38%, 39.40% 74.83%, 42.44% 75.92%, 45.60% 76.64%, 48.82% 76.97%); }
    .capability-segment:nth-child(5) { clip-path: polygon(6.54% 72.63%, 4.14% 67.26%, 2.40% 61.65%, 1.35% 55.87%, 1.00% 50.00%, 1.35% 44.13%, 2.40% 38.35%, 4.14% 32.74%, 6.54% 27.37%, 26.05% 37.53%, 24.73% 40.49%, 23.77% 43.58%, 23.19% 46.77%, 23.00% 50.00%, 23.19% 53.23%, 23.77% 56.42%, 24.73% 59.51%, 26.05% 62.47%); }
    .capability-segment:nth-child(6) { clip-path: polygon(8.67% 23.67%, 12.12% 18.91%, 16.12% 14.60%, 20.60% 10.80%, 25.50% 7.56%, 30.76% 4.94%, 36.29% 2.96%, 42.02% 1.65%, 47.86% 1.05%, 48.82% 23.03%, 45.60% 23.36%, 42.44% 24.08%, 39.40% 25.17%, 36.50% 26.62%, 33.80% 28.40%, 31.33% 30.50%, 29.13% 32.87%, 27.23% 35.49%); }
    .capability-segment[data-capability-state="full"] { background: var(--success); }
    .capability-segment[data-capability-state="partial"] { background: var(--text); }
    .capability-segment[data-capability-state="configured"],
    .capability-segment[data-capability-state="unavailable"],
    .capability-segment[data-capability-state="lockdown-pending"] { background: var(--warning); }
    .capability-segment[data-capability-state="off"] { background: #55554f; }
    .capability-segment[data-capability-state="unknown"] { background: #77776f; }
    .capability-segment[data-capability-state="blocked"] { background: var(--danger); }
    .capability-core {
      position: absolute; inset: 28%; border-radius: 50%;
      display: grid; place-items: center; border: 1px solid var(--border-strong);
      color: var(--text); font-family: var(--mono); font-size: 0.73rem;
      font-weight: 700; font-variant-numeric: tabular-nums;
    }
    .capability-copy { min-width: 0; display: grid; gap: 2px; }
    .capability-kicker {
      font-family: var(--mono); font-size: 0.65rem; text-transform: uppercase;
      letter-spacing: 0.075em; color: var(--text-muted);
    }
    .capability-readout { font-size: 0.92rem; font-weight: 650; color: var(--text); }
    .capability-breakdown {
      font-family: var(--mono); font-size: 0.67rem; color: var(--text-muted); overflow-wrap: anywhere;
    }
    .capability-arrow {
      display: grid; place-items: center; width: 30px; height: 30px;
      color: var(--text); border: 1px solid var(--border-strong);
      border-radius: 50%; font-size: 1.2rem; line-height: 1;
    }
    .capability-arrow::after { content: "+"; }
    .device-controls[open] .capability-arrow::after { content: "−"; }
    .device-control-content { display: grid; gap: 10px; padding: 10px; min-width: 0; }
    .device-control-content .family-grid { background: var(--surface); }
    .device-control-content .family-toggle { min-height: 60px; }
    .device-control-content .family-toggle:nth-last-child(-n+2) { border-bottom: 0; }
    .device-card .device-select-cb { margin: 0; }
    .device-card .device-title { min-height: 28px; }
    .device-card .sync-detail { margin: 0; }
    @media (max-width: 600px) {
      .session-menu > summary, .session-actions button { min-height: 44px; }
      .auth-bar { gap: 6px; }
      body[data-auth="signed-in"] .auth-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; }
      body[data-auth="signed-in"] #auth-state-badge { grid-column: 1 / -1; justify-self: start; }
      body[data-auth="signed-in"] #live-stream-badge { justify-self: start; min-width: 0; }
      .device-controls > summary { grid-template-columns: 64px minmax(0, 1fr) 28px; gap: 9px; min-height: 80px; }
      .capability-dial { width: 64px; height: 64px; }
      .capability-arrow { width: 28px; height: 28px; }
      .capability-readout { font-size: 0.86rem; }
      .capability-breakdown { font-size: 0.65rem; }
      .device-control-content { padding: 8px; }
      .device-control-content .family-toggle:nth-last-child(2) { border-bottom: 1px solid var(--border); }
      .device-control-content .family-toggle:last-child { border-bottom: 0; }
      .device-card { gap: 8px; }
    }

    /* Non-actionable controls must not be presented as available. */
    body[data-portal-read-only="true"] #global-controls,
    body[data-portal-read-only="true"] .owner-nav a[href="#global-controls"],
    body[data-portal-read-only="true"] #operator-advanced-box,
    body[data-has-devices="false"] #global-controls,
    body[data-has-devices="false"] .owner-nav a[href="#global-controls"],
    body[data-has-devices="false"] #operator-advanced-box { display: none; }
    .family-readout { font-family: var(--mono); font-size: 0.72rem; font-weight: 600; text-align: right; overflow-wrap: anywhere; }
    .family-readout.on { color: var(--success); }
    .family-readout.configured { color: var(--warning); }
    .family-readout.off { color: var(--text-muted); }
    .family-readout.partial { color: var(--text); }
    .read-only-notice { display: none; }
    body[data-auth="signed-in"][data-portal-read-only="true"] .read-only-notice {
      display: block; font-size: 0.76rem; color: var(--text-muted);
      padding: 9px 12px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 12px;
    }
    .snapshot-controls.hidden { display: none; }
    @media (max-width: 600px) {
      body[data-portal-read-only="true"] .owner-nav,
      body[data-has-devices="false"] .owner-nav { grid-template-columns: repeat(3, minmax(0,1fr)); }
    }
`;

const PORTAL_SCRIPT = `
    (function () {
      const SNAPSHOT_PAGE_SIZE = 10;
      const tokenInput = document.getElementById("token-input");
      const connectBtn = document.getElementById("connect-btn");
      const oidcLink = document.getElementById("oidc-signin-link");
      const oidcMode = document.body.dataset.loginMode === "oidc";
      const portalReadOnly = document.body.dataset.portalReadOnly === "true";
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
      const openControlDevices = new Set();
      const selectedDeviceIds = new Set();
      const trackedAccessUpdates = new Map();
      const lastDeviceState = new Map();
      let livePageAlerts = false;
      let signingOut = false;
      let savingOperator = false;

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
          !dev.online ||
          Boolean(dev.emergencyLockdown) ||
          dev.syncStatus === "pending" ||
          dev.syncStatus === "failed" ||
          dev.agentHealth === "unknown" || dev.agentHealth === "degraded" ||
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
          if (dev.online && dev.confirmedByDevice) {
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
              (dev.online ? " • Awaiting device confirmation" : " • Currently offline"),
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

      function targetDevices() {
        const devices = (currentOverview && currentOverview.devices) || [];
        return selectedDeviceIds.size === 0 ? devices : devices.filter(function (d) { return selectedDeviceIds.has(d.deviceId); });
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
        document.body.dataset.hasDevices = devices.length > 0 ? "true" : "false";
        document.getElementById("select-all-devices-btn").classList.toggle("hidden", selected.length === devices.length);
        document.getElementById("clear-selected-devices-btn").classList.toggle("hidden", selected.length === 0);
        document.getElementById("global-lift-lockdown-btn").classList.toggle("hidden", !targetDevices().some(function(d) { return d.emergencyLockdown; }));
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
        closeConfirmModal();
        document.getElementById("operator-advanced-box").open = false;
        document.getElementById("op-principal-id").value = "";
        document.getElementById("op-display-name").value = "";
        document.getElementById("op-profile-id").value = "";
        document.getElementById("snapshots-advanced-box").open = false;
        activeFleetFilter = "all";
        lastUpdatedMs = null;
        openAdvancedDevices.clear();
        openControlDevices.clear();
        document.querySelector(".session-menu").open = false;
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
        if (portalReadOnly && effectiveMethod !== "GET" && effectiveMethod !== "HEAD" && path !== "/portal/api/session/logout") {
          throw new Error("This portal is read-only; permission changes are unavailable.");
        }
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
        if (signingOut) return;
        signingOut = true;
        logoutBtn.disabled = true;
        try {
          await apiCall("/portal/api/session/logout", "POST", {});
          setSignedOutUi("");
        } catch (err) {
          if (authenticatedOwner) showToast("Sign out could not be confirmed: " + err.message + ". Retry sign out.", "error", "logout-error");
        } finally {
          signingOut = false;
          logoutBtn.disabled = false;
        }
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
        const version = status.agent_version || status.version;
        const mode = status.policy_mode ? " • " + status.policy_mode : "";
        return platform + (version ? " • v" + version : " • version not reported") + mode;
      }

      function renderOverview(data) {
        const draftOpRules = {};
        let focusedOpDeviceId = null;
        let focusedControlDeviceId = null;
        let focusedSelStart = null;
        let focusedSelEnd = null;
        const activeEl = document.activeElement;

        document.querySelectorAll(".device-card[data-device-id]").forEach(function (cardEl) {
          const id = cardEl.dataset.deviceId;
          const controlsEl = cardEl.querySelector("details.device-controls");
          if (id && controlsEl) {
            if (controlsEl.open) openControlDevices.add(id);
            else openControlDevices.delete(id);
            if (controlsEl.querySelector("summary") === activeEl) focusedControlDeviceId = id;
          }
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

        // The lift action is shown only when the current target scope includes a locked device.

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
                ? (dev.online && dev.confirmedByDevice ? "Confirmed Active (v" : "Last Confirmed (v") + dev.appliedRevision + ")"
                : "Pending Device Ack (v" + dev.desiredRevision + ")";
          const syncClass = dev.emergencyLockdown
            ? "lockdown"
            : dev.syncStatus === "failed"
              ? "failed"
              : dev.syncStatus === "applied"
                ? (dev.online && dev.confirmedByDevice ? "applied" : "offline")
                : "pending";

          const header = createEl("div", { className: "device-header" }, [
            createEl("div", { className: "device-title" }, [
              portalReadOnly ? null : createEl("input", {
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
          const capabilityStates = new Map();
          (dev.familySummaries || []).forEach(function (fam) {
            const isOn = Boolean(fam.granted);
            const policyCount = Array.isArray(fam.policyGrantedOperations)
              ? fam.policyGrantedOperations.length
              : fam.grantedOperations.length;
            const canonicalCount = Number(fam.canonicalOperationCount) || 0;
            const policyFull = canonicalCount > 0 && policyCount === canonicalCount;
            const isPartial = policyCount > 0 && !policyFull;
            const providerState = fam.providerState || "unknown";
            const isDegraded = Boolean(dev.online) && providerState === "unavailable";
            const livePolicyConfirmed =
              Boolean(dev.online) && Boolean(dev.confirmedByDevice) &&
              dev.syncStatus === "applied" && providerState === "available";
            const activeCount = livePolicyConfirmed && Array.isArray(fam.activeOperations)
              ? fam.activeOperations.length : 0;
            const fullyLive = livePolicyConfirmed && fam.fullyLive === true && canonicalCount > 0 && activeCount === canonicalCount;
            const configuredWithoutLiveConfirmation = policyCount > 0 && !livePolicyConfirmed;
            // Family policy and observed operation coverage are separate dimensions.
            const dialState = dev.emergencyLockdown
              ? (dev.online && dev.confirmedByDevice && dev.syncStatus === "applied" ? "blocked" : "lockdown-pending")
              : policyCount === 0 ? "off"
              : !dev.online ? "configured"
              : providerState === "unknown" ? "unknown"
              : providerState === "unavailable" ? "unavailable"
              : !livePolicyConfirmed ? "configured"
              : fullyLive ? "full"
              : activeCount > 0 ? "partial" : "unavailable";
            capabilityStates.set(fam.family, dialState);
            const subText =
              !dev.online
                ? "Offline (" + policyCount + " policy-granted; not currently active)"
                : providerState === "unknown"
                  ? "Telemetry unknown (" + policyCount + " configured; no live access verified)"
                  : providerState === "unavailable"
                    ? "Unavailable (" + policyCount + " policy-granted; not currently active)"
                    : !livePolicyConfirmed && policyCount > 0
                      ? "Awaiting device confirmation (" + policyCount + " configured)"
                      : activeCount + "/" + canonicalCount + " ops reported active";
            const switchLabel = configuredWithoutLiveConfirmation
              ? (policyFull ? "CONFIGURED" : "PARTIAL SET")
              : policyCount === 0 ? "OFF" : fullyLive ? "ON" : activeCount > 0 ? "PARTIAL" : "UNAVAILABLE";
            const switchClass = configuredWithoutLiveConfirmation
              ? "configured"
              : policyCount === 0 ? "off" : fullyLive ? "on" : activeCount > 0 ? "partial" : "configured";
            // The action still changes the desired family grant; never silently
            // remove explicit operation denies when toggling a family.
            const switchPressed = policyFull ? "true" : policyCount > 0 ? "mixed" : "false";
            const tileClasses = ["family-toggle"];
            if (configuredWithoutLiveConfirmation) tileClasses.push("configured");
            else if (isOn) tileClasses.push("granted");
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
                portalReadOnly || dev.emergencyLockdown ? createEl("span", { className: "family-readout " + switchClass, text: dev.emergencyLockdown ? "LOCKDOWN" : switchLabel }) : createEl("button", {
                  type: "button",
                  className: "switch-btn " + switchClass,
                  text: switchLabel,
                  attrs: {
                    "aria-pressed": switchPressed,
                    title: subText + ". " +
                      (isOn ? "Click to revoke the enabled family." : "Click to enable this family.") +
                      " Explicit operation denies are preserved.",
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
          const families = ["device", "files", "process", "browser", "desktop", "batch"];
          const stateLabels = {
            full: "live", partial: "partial", configured: "configured",
            unavailable: "unavailable", off: "off", unknown: "unknown",
            blocked: "lockdown confirmed", "lockdown-pending": "lockdown pending",
          };
          const dialStates = families.map(function (family) {
            return { family: family, state: capabilityStates.get(family) || "unknown" };
          });
          const fullCount = dialStates.filter(function (item) { return item.state === "full"; }).length;
          const countState = function (state) {
            return dialStates.filter(function (item) { return item.state === state; }).length;
          };
          const breakdown = ["partial", "configured", "unavailable", "off", "unknown", "blocked", "lockdown-pending"]
            .map(function (state) {
              const count = countState(state);
              return count ? count + " " + stateLabels[state] : "";
            }).filter(Boolean).join(" / ");
          const dial = createEl("span", {
            className: "capability-dial",
            attrs: {
              role: "img",
              "aria-label": "Capability status: " + dialStates.map(function (item) {
                return item.family + " " + stateLabels[item.state];
              }).join("; "),
            },
          }, dialStates.map(function (item) {
            return createEl("span", {
              className: "capability-segment",
              attrs: { "aria-hidden": "true" },
              dataset: { capabilityFamily: item.family, capabilityState: item.state },
            });
          }).concat([createEl("span", {
            className: "capability-core", attrs: { "aria-hidden": "true" },
            text: fullCount + "/" + families.length,
          })]));
          const controlsBox = createEl("details", { className: "device-controls" });
          const controlsSummary = createEl("summary", {
            attrs: { title: "View permissions and controls for " + dev.deviceId },
          }, [
            dial,
            createEl("span", { className: "capability-copy" }, [
              createEl("span", { className: "capability-kicker", text: "Permissions & controls" }),
              createEl("span", { className: "capability-readout", text: fullCount + "/" + families.length + " full families" }),
              createEl("span", { className: "capability-breakdown", text: breakdown || "All canonical operations reported available and policy-confirmed" }),
            ]),
            createEl("span", { className: "capability-arrow", attrs: { "aria-hidden": "true" } }),
          ]);
          const controlContent = createEl("div", { className: "device-control-content" }, [familyGrid]);
          controlsBox.appendChild(controlsSummary);
          controlsBox.appendChild(controlContent);
          if (openControlDevices.has(dev.deviceId)) controlsBox.open = true;
          card.appendChild(controlsBox);

          const deniedCaps =
            (dev.policy && dev.policy.owner_policy && dev.policy.owner_policy.denied_capabilities) ||
            [];
          if (portalReadOnly) {
            controlContent.appendChild(createEl("div", {
              className: "muted-note",
              text: "Explicit denies: " + (deniedCaps.length ? deniedCaps.join(", ") : "None"),
            }));
            return card;
          }
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
          if (dev.emergencyLockdown) {
            controlContent.appendChild(createEl("div", { className: "device-actions-row" }, actionButtons));
            return card;
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
          controlContent.appendChild(createEl("div", { className: "device-actions-row" }, actionButtons));

          const ruleInput = createEl("input", {
            type: "text",
            className: "op-rule-input",
            attrs: {
              placeholder: "e.g. filesystem.write",
              "aria-label": "Canonical operation on " + dev.deviceId,
              required: "",
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
          controlContent.appendChild(detailsBox);
          return card;
        });

        container.replaceChildren.apply(container, cards);
        if (focusedControlDeviceId) {
          const summary = container.querySelector(
            '.device-card[data-device-id="' + CSS.escape(focusedControlDeviceId) + '"] .device-controls > summary',
          );
          if (summary) summary.focus({ preventScroll: true });
        }
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
              portalReadOnly ? null : createEl("div", { className: "identity-actions" }, [
                grants.length === 0 ? null : createEl("button", {
                  type: "button",
                  text: "Edit grants",
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
        const pairedIds = new Set((data.devices || []).map(function(d) { return d.deviceId; }));
        snaps.forEach(function (s) {
          if (s.deviceId && !seenFilterIds.has(s.deviceId)) {
            seenFilterIds.add(s.deviceId);
            deviceOptions.push(s.deviceId);
          }
        });
        filterSelect.closest(".snapshot-controls").classList.toggle("hidden", deviceOptions.length < 2);
        if (snapshotFilterDevice && (!seenFilterIds.has(snapshotFilterDevice) || deviceOptions.length < 2)) {
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
              portalReadOnly || !pairedIds.has(s.deviceId) ? null : createEl("button", {
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

      document.addEventListener("input", function (e) {
        if (e.target.matches("[data-role=op-rule-input], #op-principal-id, #op-profile-id")) e.target.setCustomValidity("");
      });

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
            const valid = cap && Array.from(canonicalOpsList.options).some(function(o) { return o.value === cap; });
            if (!valid) {
              if (input) { input.setCustomValidity("Choose a valid operation from the canonical operation list."); input.reportValidity(); input.focus(); }
              showToast("Choose a valid operation before changing access.", "error", "input-validation");
              return;
            }
            input.setCustomValidity("");
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
            const matchedProfiles = new Set();
            (currentOverview.devices || []).forEach(function (dev) {
              const opPol =
                dev.policy &&
                dev.policy.operator_policies &&
                dev.policy.operator_policies[principalId];
              if (opPol) {
                matchingDeviceIds.push(dev.deviceId);
                matchedProfiles.add(opPol.profile_id || "custom");
              }
            });
            const profileSelect = document.getElementById("op-profile-id");
            const matchedProfile = matchedProfiles.size === 1 ? Array.from(matchedProfiles)[0] : "";
            profileSelect.value = Array.from(profileSelect.options).some(function(o) { return o.value === matchedProfile; }) ? matchedProfile : "";
            if (!matchingDeviceIds.length) {
              showToast("This operator has no device grants to edit. Select devices and use the authorization form.", "info", "operator-no-grants");
              return;
            }
            selectedDeviceIds.clear();
            matchingDeviceIds.forEach(function (id) { selectedDeviceIds.add(id); });
            updateSelectionIndicators();
            if (!profileSelect.value) showToast("Mixed or custom profiles. Choose an explicit replacement profile for the selected devices.", "info", "operator-mixed-profile");
            if (detailsBox && typeof detailsBox.scrollIntoView === "function") {
              detailsBox.scrollIntoView({ block: "nearest" });
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

      function scopeDescriptionText(ids) {
        return "the " + ids.length + " device(s) (" + ids.join(", ") + ")";
      }
      function capturedTargets(lockedOnly) {
        return targetDevices().filter(function(d) { return !lockedOnly || d.emergencyLockdown; }).map(function(d) { return d.deviceId; });
      }
      function requireTargets(ids) {
        if (ids.length > 0) return true;
        showToast("No eligible paired devices in the current scope.", "error", "input-validation");
        return false;
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
        const scopeIds = capturedTargets(false);
        if (!requireTargets(scopeIds)) return;
        openConfirmModal(
          "Grant Universal Access",
          "This will enable all six MCP tool families (auto-allowing destructive file replacements and AI-owned process termination, while human-origin process termination and unshared human tabs/windows remain blocked) on " + scopeDescriptionText(scopeIds) + ".",
          function (reason) {
            return apiCall("/portal/api/global/apply", "POST", {
              confirm: true,
              profileId: "universal",
              emergencyLockdown: false,
              deviceIds: scopeIds,
              reason: reason || "Global grant universal access",
            });
          },
        );
      });

      document.getElementById("global-readonly-btn").addEventListener("click", function () {
        const scopeIds = capturedTargets(false);
        if (!requireTargets(scopeIds)) return;
        openConfirmModal(
          "Apply Read-Only Profile",
          "This will restrict " + scopeDescriptionText(scopeIds) + " to non-destructive inspection operations.",
          function (reason) {
            return apiCall("/portal/api/global/apply", "POST", {
              confirm: true,
              profileId: "read_only",
              deviceIds: scopeIds,
              reason: reason || "Global read-only profile",
            });
          },
        );
      });

      document.getElementById("global-revoke-btn").addEventListener("click", function () {
        const scopeIds = capturedTargets(false);
        if (!requireTargets(scopeIds)) return;
        openConfirmModal(
          "Revoke All Tool Families",
          "This will disable all six MCP tool families on " + scopeDescriptionText(scopeIds) + " until re-enabled.",
          function (reason) {
            return apiCall("/portal/api/global/apply", "POST", {
              confirm: true,
              profileId: "lockdown",
              deviceIds: scopeIds,
              reason: reason || "Global revoke all tool families",
            });
          },
        );
      });

      document.getElementById("global-lift-lockdown-btn").addEventListener("click", function () {
        const scopeIds = capturedTargets(true);
        if (!requireTargets(scopeIds)) return;
        openConfirmModal(
          "Lift Emergency Access Lockdown",
          "This will lift emergency lockdown and restore baseline Universal Access (all six MCP tool families, auto-allowing destructive operations subject to human-coexistence protections) on " + scopeDescriptionText(scopeIds) + ". To restore prior custom restrictions instead, use Recoverable Snapshots & Rollback below.",
          function (reason) {
            return apiCall("/portal/api/global/emergency-revoke", "POST", {
              confirm: true,
              restore: true,
              deviceIds: scopeIds,
              reason: reason || "Lift emergency access lockdown from Portal",
            });
          },
        );
      });

      document.getElementById("emergency-revoke-btn").addEventListener("click", function () {
        const scopeIds = capturedTargets(false);
        if (!requireTargets(scopeIds)) return;
        openConfirmModal(
          "Emergency Access Revocation",
          "Immediate lockdown on " + scopeDescriptionText(scopeIds) + ". All owner and operator capabilities will be blocked until lifted.",
          function (reason) {
            return apiCall("/portal/api/global/emergency-revoke", "POST", {
              confirm: true,
              deviceIds: scopeIds,
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
        if (savingOperator) return;
        if (!principalId || !profileId) {
          const field = !principalId ? principalInput : document.getElementById("op-profile-id");
          field.setCustomValidity(!principalId ? "Enter an operator principal ID." : "Choose a permission profile.");
          field.reportValidity();
          showToast("An operator ID and explicit profile are required.", "error", "input-validation");
          return;
        }
        principalInput.setCustomValidity("");
        document.getElementById("op-profile-id").setCustomValidity("");
        const scopeIds = capturedTargets(false);
        if (!requireTargets(scopeIds)) return;
        savingOperator = true;
        document.getElementById("save-operator-btn").disabled = true;
        try {
          const result = await apiCall("/portal/api/operators", "POST", {
            principalId: principalId,
            displayName: displayName || principalId,
            profileId: profileId,
            deviceIds: scopeIds,
            reason: "Configured operator " + principalId + " (" + profileId + ")",
          });
          principalInput.value = "";
          displayInput.value = "";
          document.getElementById("op-profile-id").value = "";
          trackAccessChange("Operator access policy", result);
          await loadOverview();
        } catch (err) {
          showBanner("Operator update failed: " + err.message);
          showToast("Operator update rejected: " + err.message, "error", "policy-error");
        } finally {
          savingOperator = false;
          document.getElementById("save-operator-btn").disabled = false;
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
    background_color: "#111110",
    theme_color: "#111110",
  });
}

export function renderControlPortalPage(
  options: { loginMode?: "token" | "oidc"; readOnly?: boolean } = {},
): {
  html: string;
  contentSecurityPolicy: string;
} {
  return {
    html: renderControlPortalHtml(options.loginMode, options.readOnly),
    contentSecurityPolicy: PORTAL_CONTENT_SECURITY_POLICY,
  };
}

export function renderControlPortalHtml(loginMode: "token" | "oidc" = "token", readOnly = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tetherplane Control Portal</title>
  <meta name="theme-color" content="#111110" />
  <link rel="manifest" href="/portal/manifest.webmanifest" />
  <style>${PORTAL_STYLE}</style>
</head>
<body data-auth="signed-out" data-login-mode="${loginMode}" data-portal-read-only="${readOnly}" data-has-devices="false">
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
        <details class="session-menu">
          <summary>Session</summary>
          <div class="session-actions">
            <button id="live-alerts-btn" type="button" aria-pressed="false">Enable live page alerts</button>
            <button id="logout-btn" class="hidden" type="button">Sign Out</button>
          </div>
        </details>
      </div>
    </header>

    <section class="summary-strip" aria-label="System Summary">
      <div class="stat-card">
        <div class="stat-label">Paired Devices</div>
        <div class="stat-value" id="stat-devices">0</div>
      </div>
      <div class="stat-card confirmed-readout">
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

    <nav class="owner-nav" aria-label="Dashboard sections">
      <a href="#devices-container">Devices</a>
      <a href="#global-controls">Access</a>
      <a href="#owner-identities">Operators</a>
      <a href="#security-audit">Audit</a>
    </nav>

    <main>
      <div id="status-banner" class="unavailable-banner status-banner-outer hidden" role="status" aria-live="polite"></div>
      <p class="read-only-notice">Read-only pilot — device status and audit history are available; permission changes are not.</p>
      <div class="fleet-heading"><h2>Connected devices</h2><span>Owner fleet</span></div>
      <div id="fleet-filter-bar" class="fleet-toolbar" aria-label="Fleet filters"></div>
      <section class="devices-grid" id="devices-container" aria-label="Connected Devices">
        <div class="signed-out-card">${loginMode === "oidc" ? "Sign in with TetherAuth to view your authorized devices." : "Enter your owner token above to load paired Tetherplane devices."}</div>
      </section>

      <p class="live-alerts-note">Notifications appear only while this portal page is open. iPhone background push is not yet configured.</p>
      <section id="global-controls" class="global-panel" aria-label="Global Permission Controls">
        <div>
          <strong>Global Controls</strong>
          <div class="global-subtitle">
            Apply permissions to selected devices, or all paired devices if none are selected. Universal Access auto-approves allowed destructive operations.
          </div>
          <details class="policy-explainer">
            <summary>Policy scope &amp; recovery details</summary>
            <div class="global-subtitle">Universal Access blocks human-origin process termination and protects unshared human tabs/windows. Lift Emergency Lockdown restores baseline Universal Access (use Recoverable Snapshots &amp; Rollback below for prior custom restrictions).</div>
          </details>
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
        <section id="owner-identities" class="panel-card" aria-label="Owner and Operator Identities">
          <h2>Owner &amp; Operator Identities</h2>
          <div id="identities-container" class="identities-list">
            No active identity telemetry yet.
          </div>
          <details id="operator-advanced-box" class="advanced-box">
            <summary>Authorize / Update Scoped Operator Identity</summary>
            <div class="op-form-stack">
              <div id="op-target-scope-note" class="muted-note">Applies to: All paired devices (select checkboxes above to scope)</div>
              <input id="op-principal-id" type="text" placeholder="operator:assistant-id" aria-label="Operator principal ID" required />
              <input id="op-display-name" type="text" placeholder="Display Name (e.g. Build Agent)" aria-label="Operator display name" />
              <select id="op-profile-id" aria-label="Operator permission profile" required>
                <option value="" disabled selected>Choose a permission profile</option>
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

        <section id="security-audit" class="panel-card" aria-label="Security Audit and Rollback">
          <h2>${readOnly ? "Security Audit" : "Security Audit &amp; Safe Rollback"}</h2>
          <div id="audit-container" class="audit-scroll">
            <div class="muted-note">No audit events loaded.</div>
          </div>
          <details id="snapshots-advanced-box" class="advanced-box advanced-box-spaced">
            <summary>${readOnly ? "Recoverable Snapshots" : "Recoverable Snapshots &amp; Rollback"}</summary>
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
  <div class="modal-backdrop" id="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-desc">
    <div class="modal">
      <h3 id="modal-title">Confirm Global Security Change</h3>
      <p id="modal-desc" class="modal-desc"></p>
      <input id="modal-reason" class="modal-reason-input" type="text" placeholder="Reason for audit history" aria-label="Reason for audit history" />
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
