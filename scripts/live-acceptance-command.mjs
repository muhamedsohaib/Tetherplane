export function normalizeCommandForPlatform(
  command,
  args,
  platform,
  comSpec,
) {
  const isWindowsBatch =
    platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

  if (!isWindowsBatch) {
    return {
      command,
      args: [...args],
    };
  }

  return {
    command: comSpec || "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args],
  };
}
