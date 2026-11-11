import { readFileSync } from "node:fs";
import { defaultShortcut } from "./default-shortcut.js";
import { normalizeShortcut } from "./shortcut-core.js";
import { legacySettingsPath, settingsPath } from "./settings-path.js";
import type { TranscribeFileExposure } from "./settings.js";

export type RegistrationSettings = {
  shortcut: string;
  transcribeFileExposure: TranscribeFileExposure;
};

/** A function, not a constant: defaultShortcut() may probe the system. */
function defaults(): RegistrationSettings {
  return { shortcut: defaultShortcut(), transcribeFileExposure: "direct" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only the settings Pi needs while synchronously registering the extension. */
export function readRegistrationSettings(): RegistrationSettings {
  for (const path of [settingsPath(), legacySettingsPath()]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.shortcut !== "string") {
        return defaults();
      }
      return {
        shortcut: normalizeShortcut(parsed.shortcut) ?? defaultShortcut(),
        transcribeFileExposure: parsed.transcribeFileExposure === "deferred" ? "deferred" : "direct",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return defaults();
    }
  }
  return defaults();
}
