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
 */
export function readWindowsLastInputTick(): number {
  if (process.platform !== "win32") return 0;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class TetherplaneInputAgeProbe {",
    " [StructLayout(LayoutKind.Sequential)] public struct LastInput {",
    "   public uint cbSize; public uint dwTime;",
    " }",
    " [DllImport(\"user32.dll\")] private static extern bool GetLastInputInfo(ref LastInput info);",
    " public static uint Read() {",
    "   LastInput info = new LastInput { cbSize = (uint)Marshal.SizeOf(typeof(LastInput)) };",
    "   if (!GetLastInputInfo(ref info)) throw new InvalidOperationException(\"input metadata unavailable\");",
    "   return info.dwTime;",
    " }",
    "}",
    "'@",
    "[TetherplaneInputAgeProbe]::Read()",
  ].join("\n");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
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
