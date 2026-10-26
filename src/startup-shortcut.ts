import { readFileSync } from "node:fs";
import { DEFAULT_SHORTCUT, normalizeShortcut } from "./shortcut-core.js";
import { legacySettingsPath, settingsPath } from "./settings-path.js";
import { parseToolExposure, type ToolExposureSetting } from "./tool-exposure.js";

export type RegistrationSettings = {
  shortcut: string;
  toolExposure?: ToolExposureSetting;
  invalidToolExposure: boolean;
};

const DEFAULTS: RegistrationSettings = { shortcut: DEFAULT_SHORTCUT, invalidToolExposure: false };

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
      const { setting, invalid } = parseToolExposure(parsed.toolExposure);
      return {
        shortcut: normalizeShortcut(parsed.shortcut) ?? DEFAULT_SHORTCUT,
        ...(setting ? { toolExposure: setting } : {}),
        invalidToolExposure: invalid,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { ...DEFAULTS };
    }
  }
  return { ...DEFAULTS };
}

export function readShortcutForRegistration(): string {
  return readRegistrationSettings().shortcut;
}
