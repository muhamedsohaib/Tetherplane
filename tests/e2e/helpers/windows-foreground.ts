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

    let output: string | undefined;
    try {
      output = execFileSync(probeExePath, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 5_000,
      });
    } catch (error) {
      if (!isProbeLaunchFailure(error)) throw error;
    }
    if (output !== undefined) return parseForegroundInfo(output);
  }

  // Use the same read-only probe when csc is absent or Windows blocks the EXE.
  const psScript = `
$ErrorActionPreference = 'Stop'
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
  );

  return parseForegroundInfo(output);
}

function isProbeLaunchFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as NodeJS.ErrnoException & {
    pid?: number; status?: number | null; signal?: string | null;
  };
  // Node reports Windows Application Control denials as UNKNOWN. Require
  // evidence that spawn itself failed, not a timeout or a started probe's exit.
  return failure.pid === 0 && failure.status === null && failure.signal === null &&
    failure.syscall?.startsWith("spawnSync ") === true &&
    ["EACCES", "EPERM", "ENOENT", "ENOEXEC", "UNKNOWN"].includes(failure.code ?? "");
}

function parseForegroundInfo(value: string): ForegroundInfo {
  const output = value.trim();
  const match = /^(\d+):(\d+):([^:\r\n]+):([^\r\n]*)$/.exec(output);
  if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) {
    throw new Error("Invalid foreground probe output");
  }
  return {
    hwnd: Number(match[1]),
    pid: Number(match[2]),
    processName: match[3]!,
    className: match[4]!,
    raw: output,
  };
}
