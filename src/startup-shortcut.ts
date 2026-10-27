import { readFileSync } from "node:fs";
import { DEFAULT_SHORTCUT, normalizeShortcut } from "./shortcut-core.js";
import { legacySettingsPath, settingsPath } from "./settings-path.js";
import type { TranscribeFileExposure } from "./settings.js";

export type RegistrationSettings = {
  shortcut: string;
  transcribeFileExposure: TranscribeFileExposure;
};

const DEFAULTS: RegistrationSettings = { shortcut: DEFAULT_SHORTCUT, transcribeFileExposure: "direct" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only the settings Pi needs while synchronously registering the extension. */
export function readRegistrationSettings(): RegistrationSettings {
  for (const path of [settingsPath(), legacySettingsPath()]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.shortcut !== "string") {
        return { ...DEFAULTS };
      }
      return {
        shortcut: normalizeShortcut(parsed.shortcut) ?? DEFAULT_SHORTCUT,
        transcribeFileExposure: parsed.transcribeFileExposure === "deferred" ? "deferred" : "direct",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { ...DEFAULTS };
    }
  }
  return { ...DEFAULTS };
}
