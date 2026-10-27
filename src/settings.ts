import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  languageIdentity,
  getCatalogModel,
  resolveModelLanguage,
  type CatalogModel,
} from "./catalog.js";
import { autoLanguagePolicy } from "./language-detection-policy.js";
import { normalizeShortcut } from "./shortcut-core.js";
import { legacySettingsPath, settingsPath } from "./settings-path.js";

const SETTINGS_VERSION = 1;

export type MicrophoneSetting =
  | { type: "system-default" }
  | { type: "device"; name: string; occurrence: number };

export const DEFAULT_MICROPHONE: MicrophoneSetting = { type: "system-default" };

export type ChineseOutput = "simplified" | "traditional-taiwan" | "traditional-hong-kong";

function defaultChineseOutput(): ChineseOutput {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const subtags = locale.toLowerCase().split("-");
  if (subtags.includes("hk") || subtags.includes("mo")) return "traditional-hong-kong";
  if (subtags.includes("tw") || subtags.includes("hant")) return "traditional-taiwan";
  return "simplified";
}

/** "auto" uses native detection or the external detector; otherwise a language code. */
export type TranscriptionLanguage = string;

export type TranscribeFileExposure = "direct" | "deferred";

export type TranscribeSettings = {
  version: 1;
  backend: { type: "transcribe-cpp" };
  shortcut: string;
  preferredLanguages: string[];
  transcriptionLanguage: TranscriptionLanguage;
  chineseOutput: ChineseOutput;
  microphone: MicrophoneSetting;
  /** Transcribe only the speech in a recording, not its silence and noise. */
  voiceActivityDetection: boolean;
  /** Hidden, settings.json only: false decodes long audio in one piece, without voice activity cuts. */
  longformChunking: boolean;
  /** Hidden, settings.json only: how Pi declares transcribe_file to the model. */
  transcribeFileExposure: TranscribeFileExposure;
  model: {
    source: "catalog";
    id: string;
    path: string;
  };
};

type SettingsReadResult = {
  settings?: TranscribeSettings;
  warning?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLanguages(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((language) => typeof language === "string")) {
    return undefined;
  }
  const languages = [...new Set(value.map(languageIdentity).filter(Boolean))];
  return languages.length > 0 ? languages : undefined;
}

function validateChineseOutput(value: unknown): ChineseOutput {
  return value === "simplified" ||
    value === "traditional-taiwan" ||
    value === "traditional-hong-kong"
    ? value
    : defaultChineseOutput();
}

function validateMicrophone(value: unknown): MicrophoneSetting | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === "system-default") return { type: "system-default" };
  if (
    value.type !== "device" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !Number.isInteger(value.occurrence) ||
    (value.occurrence as number) < 0
  ) {
    return undefined;
  }
  return { type: "device", name: value.name, occurrence: value.occurrence as number };
}

function defaultTranscriptionLanguage(
  model: CatalogModel,
  preferredLanguages: readonly string[] = [],
): TranscriptionLanguage {
  if (autoLanguagePolicy(model, preferredLanguages).kind !== "unsupported") return "auto";
  for (const language of preferredLanguages) {
    const code = resolveModelLanguage(model, language);
    if (code) return code;
  }
  return model.languages[0] ?? "en";
}

/** Keep an exact model language when possible; otherwise choose a safe default. */
export function transcriptionLanguageForModel(
  value: unknown,
  model: CatalogModel,
  preferredLanguages: readonly string[] = [],
): TranscriptionLanguage {
  if (typeof value === "string") {
    if (value === "auto" && autoLanguagePolicy(model, preferredLanguages).kind !== "unsupported") {
      return value;
    }
    if (value !== "auto") {
      const code = resolveModelLanguage(model, value);
      if (code) return code;
    }
  }
  return defaultTranscriptionLanguage(model, preferredLanguages);
}

function validateSettings(value: unknown): TranscribeSettings | undefined {
  if (!isObject(value) || value.version !== SETTINGS_VERSION) return undefined;
  if (!isObject(value.backend) || value.backend.type !== "transcribe-cpp") return undefined;
  const shortcut =
    typeof value.shortcut === "string" ? normalizeShortcut(value.shortcut) : undefined;
  if (!shortcut) return undefined;
  if (!isObject(value.model) || value.model.source !== "catalog") return undefined;
  if (typeof value.model.id !== "string") return undefined;
  const model = getCatalogModel(value.model.id);
  if (!model) return undefined;
  if (typeof value.model.path !== "string" || value.model.path.length === 0) return undefined;

  const preferredLanguages = normalizeLanguages(value.preferredLanguages);
  const microphone = validateMicrophone(value.microphone);
  if (!preferredLanguages || !microphone) return undefined;

  return {
    version: SETTINGS_VERSION,
    backend: { type: "transcribe-cpp" },
    shortcut,
    preferredLanguages,
    transcriptionLanguage: transcriptionLanguageForModel(
      value.transcriptionLanguage,
      model,
      preferredLanguages,
    ),
    chineseOutput: validateChineseOutput(value.chineseOutput),
    microphone,
    voiceActivityDetection: value.voiceActivityDetection !== false,
    longformChunking: value.longformChunking !== false,
    transcribeFileExposure: value.transcribeFileExposure === "deferred" ? "deferred" : "direct",
    model: {
      source: "catalog",
      id: value.model.id,
      path: value.model.path,
    },
  };
}

async function readSettingsFile(path: string): Promise<SettingsReadResult> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const settings = validateSettings(parsed);
    return settings
      ? { settings }
      : { warning: `Invalid settings in ${path}; configuration is required.` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      warning: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function readSettings(): Promise<SettingsReadResult> {
  const currentPath = settingsPath();
  const current = await readSettingsFile(currentPath);
  if (current.settings || current.warning) return current;

  const legacyPath = legacySettingsPath();
  const legacy = await readSettingsFile(legacyPath);
  if (!legacy.settings) return legacy;

  try {
    await writeSettings(legacy.settings);
    await unlink(legacyPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { settings: legacy.settings };
  } catch (error) {
    return {
      settings: legacy.settings,
      warning: `Loaded legacy settings from ${legacyPath}, but could not migrate them to ${currentPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function writeSettings(settings: TranscribeSettings): Promise<void> {
  const path = settingsPath();
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(settings, null, 2)}\n`;

  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

type ModelSettingsOptions = {
  shortcut: string;
  preferredLanguages?: readonly string[];
  transcriptionLanguage?: TranscriptionLanguage;
  chineseOutput?: ChineseOutput;
  microphone?: MicrophoneSetting;
  voiceActivityDetection?: boolean;
  longformChunking?: boolean;
  transcribeFileExposure?: TranscribeFileExposure;
};

export function settingsForModel(
  modelId: string,
  modelPath: string,
  options: ModelSettingsOptions,
): TranscribeSettings {
  const model = getCatalogModel(modelId);
  if (!model) throw new Error(`Unknown catalog model: ${modelId}`);
  const preferredLanguages = [
    ...new Set((options.preferredLanguages ?? ["en"]).map(languageIdentity)),
  ];
  return {
    version: SETTINGS_VERSION,
    backend: { type: "transcribe-cpp" },
    shortcut: options.shortcut,
    preferredLanguages,
    transcriptionLanguage: transcriptionLanguageForModel(
      options.transcriptionLanguage,
      model,
      preferredLanguages,
    ),
    chineseOutput: options.chineseOutput ?? defaultChineseOutput(),
    microphone: { ...(options.microphone ?? DEFAULT_MICROPHONE) },
    voiceActivityDetection: options.voiceActivityDetection ?? true,
    longformChunking: options.longformChunking ?? true,
    transcribeFileExposure: options.transcribeFileExposure ?? "direct",
    model: { source: "catalog", id: modelId, path: modelPath },
  };
}

/** Preference edits re-resolve the language, so Auto never outlives support for it. */
export function settingsWithPreferredLanguages(
  current: TranscribeSettings,
  preferredLanguages: readonly string[],
): TranscribeSettings {
  return settingsForModel(current.model.id, current.model.path, { ...current, preferredLanguages });
}
