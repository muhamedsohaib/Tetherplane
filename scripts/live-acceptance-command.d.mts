export function normalizeCommandForPlatform(
  command: string,
  args: readonly string[],
  platform: string,
  comSpec: string | undefined,
): {
  command: string;
  args: string[];
};
