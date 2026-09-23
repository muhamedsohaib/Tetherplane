export type PopupBrowserApi = {
  activeTabs(): Promise<Array<{ id?: number | undefined }>>;
  sendMessage(message: unknown): Promise<unknown>;
};

export type ShareCurrentTabOptions = {
  ttl_ms: number;
  allow_navigate: boolean;
  allow_upload: boolean;
};

export async function shareCurrentTab(
  api: PopupBrowserApi,
  options: ShareCurrentTabOptions,
): Promise<unknown> {
  const tabId = await activeTabId(api);
  return api.sendMessage({
    type: "tetherplane.share_current_tab",
    tab_id: tabId,
    ttl_ms: options.ttl_ms,
    allow_navigate: options.allow_navigate,
    allow_upload: options.allow_upload,
  });
}

export async function detachCurrentTab(
  api: PopupBrowserApi,
): Promise<unknown> {
  const tabId = await activeTabId(api);
  return api.sendMessage({
    type: "tetherplane.detach_current_tab",
    tab_id: tabId,
  });
}

async function activeTabId(
  api: PopupBrowserApi,
): Promise<number> {
  const tabs = await api.activeTabs();
  const id = tabs[0]?.id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 0
  ) {
    throw new Error("active browser tab is unavailable");
  }
  return id;
}
