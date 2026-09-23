import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ForegroundInfo {
  hwnd: number;
  pid: number;
  processName: string;
  className: string;
  raw: string;
}

const CS_SOURCE = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Program {
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [STAThread]
    public static void Main() {
        IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
        string result = null;

        Action read = () => {
            IntPtr fg = GetForegroundWindow();
            uint pid = 0;
            GetWindowThreadProcessId(fg, out pid);
            StringBuilder sb = new StringBuilder(256);
            GetClassName(fg, sb, sb.Capacity);
            string procName = "unknown";
            try {
                if (pid > 0) {
                    procName = Process.GetProcessById((int)pid).ProcessName;
                }
            } catch {}
            result = string.Format("{0}:{1}:{2}:{3}", fg.ToInt64(), pid, procName, sb.ToString());
        };

        if (hDesk != IntPtr.Zero) {
            Thread t = new Thread(() => {
                if (SetThreadDesktop(hDesk)) {
                    read();
                }
            });
            t.Start();
            t.Join();
            CloseDesktop(hDesk);
        }

        if (result == null) {
            read();
        }

        Console.Out.WriteLine(result);
    }
}
`;

function findCsc(): string | null {
  const windir = process.env.WINDIR ?? "C:\\Windows";
  const candidates = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

let probeExePath: string | null = null;

export function getForegroundInfo(): ForegroundInfo {
  if (process.platform !== "win32") {
    return { hwnd: 0, pid: 0, processName: "", className: "", raw: "" };
  }

  const csc = findCsc();
  if (csc) {
    if (!probeExePath || !existsSync(probeExePath)) {
      const tempDir = os.tmpdir();
      const exePath = path.join(tempDir, "tetherplane-fg-probe.exe");
      const csPath = path.join(tempDir, "tetherplane-fg-probe.cs");

      if (!existsSync(exePath)) {
        writeFileSync(csPath, CS_SOURCE.trim(), "utf8");
        execFileSync(csc, [
          "/nologo",
          "/target:winexe",
          `/out:${exePath}`,
          csPath,
        ]);
      }
      probeExePath = exePath;
    }

    const output = execFileSync(probeExePath, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 5_000,
    }).trim();

    const [hwndStr, pidStr, procName, className] = output.split(":");
    return {
      hwnd: Number(hwndStr) || 0,
      pid: Number(pidStr) || 0,
      processName: procName || "unknown",
      className: className || "",
      raw: output,
    };
  }

  // Fallback if csc is unavailable: PowerShell with windowsHide: true and OpenInputDesktop
  const psScript = `
Add-Type -TypeDefinition @'
${CS_SOURCE}
'@
[Program]::Main()
`;
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Sta", "-Command", psScript],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 10_000,
    },
  ).trim();

  const [hwndStr, pidStr, procName, className] = output.split(":");
  return {
    hwnd: Number(hwndStr) || 0,
    pid: Number(pidStr) || 0,
    processName: procName || "unknown",
    className: className || "",
    raw: output,
  };
}
