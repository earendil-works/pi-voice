/**
 * Recorder errors, matched structurally so eagerly loaded modules need not
 * load the native recorder that audio.ts imports.
 */
function recorderErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "RecorderError") return undefined;
  const { code } = error as Error & { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/** macOS refused the terminal microphone access; the fix is in System Settings. */
export function isMacOSPermissionDenied(error: unknown): boolean {
  return process.platform === "darwin" && recorderErrorCode(error) === "PermissionDenied";
}
