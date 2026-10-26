// Mirrors the per-tool `toolExposure` map of Pi's MCP configuration, limited to
// the one model tool Pi Voice registers and the two exposures it supports.
export type TranscribeFileExposure = "direct" | "codemode";
export type ToolExposureSetting = { transcribe_file: TranscribeFileExposure };

export function parseToolExposure(value: unknown): {
  setting?: ToolExposureSetting;
  invalid: boolean;
} {
  if (value === undefined) return { invalid: false };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { invalid: true };
  const keys = Object.keys(value);
  const exposure = (value as Record<string, unknown>).transcribe_file;
  if (keys.length !== 1 || (exposure !== "direct" && exposure !== "codemode")) {
    return { invalid: true };
  }
  return { setting: { transcribe_file: exposure }, invalid: false };
}

/** Pi's MCP support registers `codemode` tools with the extension `deferred` exposure. */
export function extensionExposure(setting: ToolExposureSetting | undefined): "direct" | "deferred" {
  return setting?.transcribe_file === "codemode" ? "deferred" : "direct";
}
