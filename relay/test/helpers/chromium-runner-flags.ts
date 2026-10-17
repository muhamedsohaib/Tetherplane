type TestRunner = {
  platform: NodeJS.Platform;
  ci: boolean;
  githubActions: boolean;
  allowCiUnsandboxed: boolean;
};

/**
 * Only the disposable GitHub-hosted Linux synthetic OAuth fixture can opt out
 * of Chromium's process sandbox when AppArmor blocks unprivileged user namespaces.
 * This helper is test-only; production browser launches remain unchanged.
 */
export function chromiumTestLaunchArgs(
  profileDir: string,
  runner: TestRunner = {
    platform: process.platform,
    ci: process.env.CI === "true",
    githubActions: process.env.GITHUB_ACTIONS === "true",
    allowCiUnsandboxed: process.env.TETHERPLANE_CI_CHROMIUM_UNSANDBOXED === "1",
  },
): string[] {
  const args = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
  if (runner.platform === "linux" && runner.ci && runner.githubActions && runner.allowCiUnsandboxed) {
    args.unshift("--no-sandbox");
  }
  return args;
}
