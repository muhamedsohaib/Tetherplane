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

export interface CursorClipboardState {
  cursor: {
    x: number;
    y: number;
  };
  clipboardTextBase64: string;
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

const STATE_CS_SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Program {
    [StructLayout(LayoutKind.Sequential)]
    private struct Point {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr owner);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint format);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr handle);

    private const uint CfUnicodeText = 13;

    [STAThread]
    public static void Main() {
        Point point;
        if (!GetCursorPos(out point)) {
            throw new InvalidOperationException("cursor position is unavailable");
        }

        string clipboard = ReadClipboard();
        string encoded = Convert.ToBase64String(
            Encoding.UTF8.GetBytes(clipboard)
        );
        Console.Out.WriteLine(
            string.Format(
                "{0}\t{1}\t{2}",
                point.X,
                point.Y,
                encoded
            )
        );
    }

    private static string ReadClipboard() {
        for (int attempt = 0; attempt < 5; attempt++) {
            if (OpenClipboard(IntPtr.Zero)) {
                try {
                    IntPtr handle = GetClipboardData(CfUnicodeText);
                    if (handle == IntPtr.Zero) {
                        return "";
                    }

                    IntPtr pointer = GlobalLock(handle);
                    if (pointer == IntPtr.Zero) {
                        return "";
                    }

                    try {
                        return Marshal.PtrToStringUni(pointer) ?? "";
                    } finally {
                        GlobalUnlock(handle);
                    }
                } finally {
                    CloseClipboard();
                }
            }
            Thread.Sleep(20);
        }

        throw new InvalidOperationException("clipboard is unavailable");
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
let stateProbeExePath: string | null = null;

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

export function getCursorClipboardState(): CursorClipboardState {
  if (process.platform !== "win32") {
    return {
      cursor: { x: 0, y: 0 },
      clipboardTextBase64: "",
      raw: "",
    };
  }

  const csc = findCsc();
  if (csc) {
    if (!stateProbeExePath || !existsSync(stateProbeExePath)) {
      const tempDir = os.tmpdir();
      const exePath = path.join(
        tempDir,
        "tetherplane-state-probe.exe",
      );
      const csPath = path.join(
        tempDir,
        "tetherplane-state-probe.cs",
      );

      if (!existsSync(exePath)) {
        writeFileSync(
          csPath,
          STATE_CS_SOURCE.trim(),
          "utf8",
        );
        execFileSync(csc, [
          "/nologo",
          "/target:winexe",
          `/out:${exePath}`,
          csPath,
        ]);
      }
      stateProbeExePath = exePath;
    }

    let output: string | undefined;
    try {
      output = execFileSync(stateProbeExePath, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 5_000,
      });
    } catch (error) {
      if (!isProbeLaunchFailure(error)) throw error;
    }
    if (output !== undefined) {
      return parseCursorClipboardState(output);
    }
  }

  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$p = [System.Windows.Forms.Cursor]::Position",
    "$t = [System.Windows.Forms.Clipboard]::GetText()",
    "$b = if ([string]::IsNullOrEmpty($t)) { '' } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }",
    "Write-Output ($p.X.ToString() + [char]9 + $p.Y.ToString() + [char]9 + $b)",
  ].join("; ");

  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Sta",
      "-Command",
      psScript,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 20_000,
    },
  );

  return parseCursorClipboardState(output);
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

function parseCursorClipboardState(
  value: string,
): CursorClipboardState {
  const output = value.replace(/[\r\n]+$/, "");
  const fields = output.split("\t");
  if (fields.length !== 3) {
    throw new Error(
      "Invalid cursor/clipboard probe output",
    );
  }

  const x = Number(fields[0]);
  const y = Number(fields[1]);
  const clipboardTextBase64 = fields[2]!;
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      clipboardTextBase64,
    )
  ) {
    throw new Error(
      "Invalid cursor/clipboard probe output",
    );
  }

  return {
    cursor: { x, y },
    clipboardTextBase64,
    raw: output,
  };
}
