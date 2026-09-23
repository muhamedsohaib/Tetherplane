import {
  BrowserPolicyError,
  type BrowserOperation,
} from "@tetherplane/browser-bridge/policy";

export type LocalApprovalController = {
  attachHumanTab(
    tabId: number,
    grant: {
      operations: BrowserOperation[];
      ttl_ms: number;
    },
  ): Promise<unknown>;
  detachHumanTab(tabId: number): Promise<unknown>;
};

export type LocalApprovalResult =
  | { handled: false }
  | { handled: true; page: unknown };

const MAX_ATTACHMENT_TTL_MS = 3_600_000;

export async function handleLocalApprovalMessage(
  controller: LocalApprovalController,
  message: unknown,
): Promise<LocalApprovalResult> {
  if (!isRecord(message) || typeof message.type !== "string") {
    return { handled: false };
  }

  if (message.type === "tetherplane.detach_current_tab") {
    const tabId = requiredTabId(message.tab_id);
    return {
      handled: true,
      page: await controller.detachHumanTab(tabId),
    };
  }

  if (message.type !== "tetherplane.share_current_tab") {
    return { handled: false };
  }

  const tabId = requiredTabId(message.tab_id);
  const ttlMs = requiredTtl(message.ttl_ms);
  const operations: BrowserOperation[] = ["act"];

  if (message.allow_navigate === true) {
    operations.push("navigate");
  }
  if (message.allow_upload === true) {
    operations.push("upload");
  }

  return {
    handled: true,
    page: await controller.attachHumanTab(tabId, {
      operations,
      ttl_ms: ttlMs,
    }),
  };
}

function requiredTabId(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new BrowserPolicyError(
      "invalid_arguments",
      "tab_id must be a non-negative integer",
    );
  }
  return value;
}

function requiredTtl(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_ATTACHMENT_TTL_MS
  ) {
    throw new BrowserPolicyError(
      "invalid_arguments",
      "ttl_ms must be between 1 and 3600000",
    );
  }
  return value;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
