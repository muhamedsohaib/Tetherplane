import { win32 } from "node:path";

// Windows PowerShell 5.1 must not inherit PowerShell 7's module directories.
// In mixed-hosted-runner shells that collision can load an incompatible
// Microsoft.PowerShell.Security module and remove the Cert: provider.
// Scope this change to the spawned subprocess. Never mutate the host env.
export function windowsPowerShell51Environment(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "psmodulepath") delete env[key];
  }

  const required = [
    ["USERPROFILE", "Documents", "WindowsPowerShell", "Modules"],
    ["ProgramFiles", "WindowsPowerShell", "Modules"],
    ["SystemRoot", "System32", "WindowsPowerShell", "v1.0", "Modules"],
  ];
  const paths = required.map(([variable, ...segments]) => {
    const base = source[variable];
    if (typeof base !== "string" || !base.trim()) {
      throw new Error("Missing Windows PowerShell prerequisite: " + variable);
    }
    return win32.join(base, ...segments);
  });
  env.PSModulePath = paths.join(";");
  return env;
}
