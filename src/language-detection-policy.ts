import type { LangIdResult } from "transcribe-cpp";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { autoLanguagePolicy, type AutoLanguagePolicy, type DetectPolicy } from "@handy-computer/models";
import { displayLanguage, getCatalogModel } from "./catalog.js";
import { describeError, log } from "./log.js";
import type { TranscribeSettings } from "./settings.js";

export {
  autoLanguagePolicy,
  detectorLanguageCode,
  requiresLanguageDetector,
  undetectablePreferences,
  type AutoLanguagePolicy,
  type DetectPolicy,
} from "@handy-computer/models";

/** The policy a take runs with: an explicit language is fixed. */
export function settingsLanguagePolicy(settings: TranscribeSettings): AutoLanguagePolicy {
  if (settings.transcriptionLanguage !== "auto") {
    return { kind: "fixed", language: settings.transcriptionLanguage };
  }
  const model = getCatalogModel(settings.model.id);
  // Test/injected backends may use noncatalog ids. Persisted settings never do.
  return model ? autoLanguagePolicy(model, settings.preferredLanguages) : { kind: "native" };
}

const WINDOW_SAMPLES = 7 * CAPTURE_SAMPLE_RATE;
const MIN_SAMPLES = CAPTURE_SAMPLE_RATE / 2;
// Log a pick as uncertain when it is less than 1.5x as likely as the
// runner-up (with two languages: p < 0.6). The pick is used either way.
const UNSURE_RATIO = 1.5;

/** Shown once per session when Auto runs without the detector on disk. */
export function missingDetectorWarning(fallback: string): string {
  return `The language detector isn't downloaded. Transcribed as ${displayLanguage(fallback)}. ` +
    "To download it, open /voice-settings and choose Auto detect as the transcription language.";
}

/**
 * Pick one language for a whole clip from its first seven seconds: always the
 * top candidate. Skipped (< 500 ms), failed, or malformed detection falls back
 * to the first preferred language; only the last two warn.
 */
export async function detectLanguage(
  policy: DetectPolicy,
  pcm: Float32Array,
  identify: (pcm: Float32Array, allowed: readonly string[]) => Promise<LangIdResult>,
): Promise<{ language: string; warning?: string }> {
  const fallback = policy.languages[0]!;
  const seconds = (pcm.length / CAPTURE_SAMPLE_RATE).toFixed(2);
  if (pcm.length < MIN_SAMPLES) {
    log.info(`language detection: skipped, the ${seconds} s clip is under the ` +
      `${MIN_SAMPLES / CAPTURE_SAMPLE_RATE} s minimum; transcribing as ${fallback}, the first preferred language`);
    return { language: fallback };
  }
  const transcribedAs = `Transcribed as ${displayLanguage(fallback)}.`;
  try {
    const result = await identify(pcm.subarray(0, WINDOW_SAMPLES), policy.allowed);
    const [first, second] = result.candidates;
    const language = policy.languages[policy.allowed.indexOf(result.code ?? "")];
    const scores = result.candidates.map((c) => `${c.code} ${(c.p * 100).toFixed(1)}%`).join(", ");
    const unsure = first && second && first.p < UNSURE_RATIO * second.p ? ", uncertain" : "";
    log.info(`language detection: ${language ?? "none"} (${scores}; ` +
      `${seconds} s, allowed mass ${(result.allowedMass * 100).toFixed(1)}%${unsure})`);
    if (!language || !first || !Number.isFinite(first.p)) {
      return { language: fallback, warning: `Couldn't detect the language. ${transcribedAs}` };
    }
    return { language };
  } catch (error) {
    log.warn(`Language detection failed: ${describeError(error)}`);
    return { language: fallback, warning: `Language detection failed (${describeError(error)}). ${transcribedAs}` };
  }
}
