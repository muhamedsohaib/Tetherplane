import { execFileSync } from "node:child_process";

export interface BackgroundDesktopObservation {
  cursorBefore: { x: number; y: number };
  cursorAfter: { x: number; y: number };
  foregroundBefore: number;
  foregroundAfter: number;
  clipboardBefore: string;
  clipboardAfter: string;
  inputTickBefore: number;
  inputTickAfter: number;
}

export type DesktopCoexistenceVerdict = "verified" | "violation" | "inconclusive";

/**
 * A changing last-input tick means that movement cannot be attributed.
 * It is NOT proof the human rather than an agent produced that input.
 * Mark uncertain observations inconclusive, never silently passing.
 */
export function classifyBackgroundDesktopObservation(
  beforeAfter: BackgroundDesktopObservation,
): DesktopCoexistenceVerdict {
  const changed =
    beforeAfter.cursorBefore.x !== beforeAfter.cursorAfter.x ||
    beforeAfter.cursorBefore.y !== beforeAfter.cursorAfter.y ||
    beforeAfter.foregroundBefore !== beforeAfter.foregroundAfter ||
    beforeAfter.clipboardBefore !== beforeAfter.clipboardAfter;

  if (!changed) return "verified";
  return beforeAfter.inputTickBefore === beforeAfter.inputTickAfter
    ? "violation"
    : "inconclusive";
}

/**
 * Read-only Windows LastInputInfo tick. No key data, pointer coordinates,
 * clipboard content or window identity is read or retained.
 *
 * Python ctypes invokes the existing OS API without the transient C# compile
 * that made cold PowerShell Add-Type startup miss CI's 15-second bound.
 * Python is already a repository CI prerequisite (check-no-unsafe.py).
 */
export function readWindowsLastInputTick(): number {
  if (process.platform !== "win32") return 0;
  const script = [
    "import ctypes",
    "class LastInput(ctypes.Structure):",
    "    _fields_ = [('cbSize', ctypes.c_uint32), ('dwTime', ctypes.c_uint32)]",
    "info = LastInput()",
    "info.cbSize = ctypes.sizeof(LastInput)",
    "user32 = ctypes.WinDLL('user32', use_last_error=True)",
    "read = user32.GetLastInputInfo",
    "read.argtypes = [ctypes.POINTER(LastInput)]",
    "read.restype = ctypes.c_int",
    "if not read(ctypes.byref(info)):",
    "    raise OSError(ctypes.get_last_error(), 'input metadata unavailable')",
    "print(info.dwTime)",
  ].join("\n");
  const output = execFileSync(
    "python.exe",
    ["-c", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
  const tick = Number(output);
  if (!Number.isSafeInteger(tick) || tick < 0 || tick > 0xffff_ffff) {
    throw new Error("invalid read-only last-input observation");
  }
  return tick;
}
