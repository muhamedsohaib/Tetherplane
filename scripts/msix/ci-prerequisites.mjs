import { spawnSync } from "node:child_process";

const environment = process.env;
const permitted =
  environment.GITHUB_ACTIONS === "true" &&
  environment.GITHUB_EVENT_NAME === "pull_request" &&
  environment.RUNNER_OS === "Windows" &&
  environment.RUNNER_ENVIRONMENT === "github-hosted" &&
  environment.GITHUB_HEAD_REF?.startsWith("feature/msix-feasibility-");

if (!permitted) {
  console.error("MSIX_PREREQUISITES_DENIED: disposable same-repo Windows PR runner required");
  process.exitCode = 1;
} else {
  const powerShell = [
    "$ErrorActionPreference='Stop'",
    "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop",
    "if($null -eq (Get-PSDrive -Name Cert -ErrorAction SilentlyContinue)){throw 'CERT_PS_DRIVE_MISSING'}",
    "$required=@('New-SelfSignedCertificate','Export-Certificate','Import-Certificate','Get-AppxPackage','Add-AppxPackage','Remove-AppxPackage','ConvertTo-Json')",
    "foreach($name in $required){if($null -eq (Get-Command -Name $name -ErrorAction SilentlyContinue)){throw ('MISSING_REQUIRED_CMDLET: '+$name)}}",
    "$sdkRoot=Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\\10\\bin'",
    "if(-not(Test-Path -LiteralPath $sdkRoot)){throw 'MISSING_WINDOWS_SDK_BIN_DIRECTORY'}",
    "Write-Output 'MSIX_HOSTED_PREREQUISITES_PASS'",
  ].join("; ");

  // The probe must not spend minutes compiling if the *child* PowerShell
  // lacks an MSIX installation cmdlet or the Windows SDK prerequisite.
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", powerShell],
    { encoding: "utf8", windowsHide: true, shell: false, timeout: 20_000 },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0 || !result.stdout?.includes("MSIX_HOSTED_PREREQUISITES_PASS")) {
    console.error("MSIX_HOSTED_PREREQUISITES_NO_GO:", result.error?.code || result.status);
    process.exitCode = 1;
  }
}
