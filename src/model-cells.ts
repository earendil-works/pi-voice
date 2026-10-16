import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  canonicalLanguage,
  catalogModelSearchText,
  displayLanguage,
  formatBinarySize,
  modelMatchesLanguage,
  type CatalogModel,
  modelFile,
} from "./catalog.js";
import {
  languageAccuracyGrade,
  modelWaitSeconds,
  SPEED_METER_STEPS,
  speedMeterLevel,
  type AccuracyLetter,
  type RecommendationRole,
} from "./recommendations.js";
import { requiresLanguageDetector, undetectablePreferences } from "./language-detection-policy.js";
import { findIncompleteDownload, pendingDownloads } from "./models.js";
import { LIST_PADDING, padToWidth, selectionMarker } from "./ui-components.js";

type UiTheme = ExtensionContext["ui"]["theme"];

// "A-" is the widest grade; language codes ("yue") can widen a column.
const MIN_GRADE_CELL_WIDTH = 2;
const MIN_MODEL_NAME_WIDTH = 12;
export const ROLE_LABELS: Record<RecommendationRole, string> = {
  best: "Best",
  fast: "Fast",
  accurate: "Accurate",
};
export const MANUAL_LANGUAGE_TAG = "manual lang";
/** Replaces the size column for a model already in the cache. */
export const ON_DISK_LABEL = "on disk";
// "Best · Fast" is the widest role pairing that occurs.
export const TAG_WIDTH = 11;

/** Width of one grade cell for these language columns. */
export function gradeCellWidth(languages: readonly string[]): number {
  return Math.max(MIN_GRADE_CELL_WIDTH, ...languages.map((language) => visibleWidth(language)));
}

/** Width of the whole grade block: the cells and the spaces between them. */
export function gradeColumnsWidth(languages: readonly string[]): number {
  return languages.length * gradeCellWidth(languages) + Math.max(0, languages.length - 1);
}

// Colour reinforces the letter rather than replacing it, one hue per grade so
// no single grade dominates: green A, blue B, gold C, red D and F. The blue
// and gold borrow the markdown link and heading tokens; the theme has no
// dedicated ones, and both shipped themes give them sensible values.
export function gradeStyle(theme: UiTheme, letter: AccuracyLetter, text: string): string {
  switch (letter) {
    case "A": return theme.fg("success", text);
    case "B": return theme.fg("mdLink", text);
    case "C": return theme.fg("mdHeading", text);
    case "D":
    case "F": return theme.fg("error", text);
  }
}

// One cell per preferred language, in preference order, carrying the model's
// benchmark grade for it. A model that lacks the language shows a dash; one
// that claims it without a benchmark shows a question mark, since a claim on
// a model card is not a measurement.
export function gradeCells(
  theme: UiTheme,
  model: CatalogModel,
  languages: readonly string[],
): string {
  const cellWidth = gradeCellWidth(languages);
  return languages
    .map((language) => {
      const grade = languageAccuracyGrade(model, language);
      if (!grade) {
        const mark = modelMatchesLanguage(model, language) ? "?" : "—";
        return theme.fg("dim", padToWidth(mark, cellWidth));
      }
      return gradeStyle(theme, grade.letter, padToWidth(grade.label, cellWidth));
    })
    .join(" ");
}

/** The language codes over the grade cells, in the same widths. */
export function gradeHeader(languages: readonly string[]): string {
  const cellWidth = gradeCellWidth(languages);
  return languages.map((language) => padToWidth(language, cellWidth)).join(" ");
}

// Benchmark processing speed, fuller the quicker (not end-of-speech latency).
// Unbenchmarked models leave the column empty rather than claim a speed.
export function speedCell(model: CatalogModel): string {
  const wait = modelWaitSeconds(model);
  if (wait === undefined) return " ".repeat(SPEED_METER_STEPS);
  const level = speedMeterLevel(wait);
  return "▰".repeat(level) + "▱".repeat(SPEED_METER_STEPS - level);
}

export type ModelTableLayout = {
  nameWidth: number;
  /**
   * A section heading that doubles as the column header row: the label sits
   * over the name column, the column names over theirs.
   */
  header: (label: string) => string;
  sizeWidth?: number;
};

/** Shared column geometry for catalog and downloaded-model tables. */
export function modelTableLayout(
  theme: UiTheme,
  width: number,
  maximumNameWidth: number,
  languages: readonly string[],
  sizeWidth?: number,
): ModelTableLayout {
  const languagesWidth = gradeColumnsWidth(languages);
  const sizeOverhead = sizeWidth === undefined ? 0 : 2 + sizeWidth;
  const overhead =
    LIST_PADDING * 2 +
    4 +
    2 +
    SPEED_METER_STEPS +
    2 +
    languagesWidth +
    sizeOverhead +
    2 +
    TAG_WIDTH;
  const nameWidth = Math.min(
    maximumNameWidth,
    Math.max(MIN_MODEL_NAME_WIDTH, width - overhead),
  );
  // Labels outdent two columns from the names, like a heading; the rest of
  // the name column is theirs, and a long one truncates on narrow terminals.
  const labelWidth = 2 + nameWidth;
  const size = sizeWidth === undefined
    ? ""
    : `  ${theme.fg("dim", "Size".padStart(sizeWidth))}`;
  return {
    nameWidth,
    sizeWidth,
    header: (label) =>
      `  ${theme.fg("muted", padToWidth(label, labelWidth))}  ` +
      `${theme.fg("dim", padToWidth("Speed", SPEED_METER_STEPS))}  ` +
      theme.fg("dim", gradeHeader(languages)) +
      size,
  };
}

/** Shared model row; callers provide only the pane-specific final tag. */
export function modelTableRow(
  theme: UiTheme,
  model: CatalogModel,
  languages: readonly string[],
  layout: ModelTableLayout,
  options: {
    active: boolean;
    current: boolean;
    tag?: string;
    /** Already in the cache: the size column says so instead of the size. */
    downloaded?: boolean;
  },
): string {
  const prefix = options.active ? theme.fg("accent", "→ ") : "  ";
  const current = selectionMarker(theme, options.current);
  const nameText = padToWidth(model.name, layout.nameWidth);
  const name = options.active ? theme.fg("accent", nameText) : nameText;
  const sizeText = options.downloaded ? ON_DISK_LABEL : formatBinarySize(modelFile(model).size);
  const size = layout.sizeWidth === undefined
    ? ""
    : `  ${theme.fg("dim", sizeText.padStart(layout.sizeWidth))}`;
  return (
    `${prefix}${current} ${name}  ${speedCell(model)}  ` +
    `${gradeCells(theme, model, languages)}${size}  ${options.tag ?? ""}`
  );
}

/** Shared description and capability lines below a model table. */
export function modelDetailText(
  theme: UiTheme,
  model: CatalogModel,
  width: number,
  padding: number,
  feedback?: { type: "success" | "error" | "muted"; text: string },
): string {
  const canonicalLanguages = [...new Set(model.languages.map(canonicalLanguage))];
  const features = [
    canonicalLanguages.length === 1
      ? `${displayLanguage(canonicalLanguages[0]!)} only`
      : `${canonicalLanguages.length} languages`,
    // Native detection, or the shared detector for multilingual models.
    model.capabilities.languageDetection || requiresLanguageDetector(model)
      ? "automatic language detection"
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const description = truncateToWidth(
    model.description,
    Math.max(24, width - padding * 2),
    "…",
  );
  const feedbackText = feedback
    ? `\n${theme.fg(feedback.type, feedback.text)}`
    : "";
  return `${description}\n${theme.fg("dim", features.join(" · "))}${feedbackText}`;
}

/** A picker's action for a model: "choose", or what is left to download. */
export function downloadAction(model: CatalogModel, modelCached: boolean): string {
  const pending = pendingDownloads(model, modelCached);
  if (!pending.length) return "choose";
  const partial = pending.map(findIncompleteDownload);
  const bytes = pending.reduce((sum, item, index) => sum + modelFile(item).size - (partial[index]?.bytes ?? 0), 0);
  return partial.some(Boolean)
    ? `resume download (${formatBinarySize(bytes)} left)`
    : `download ${formatBinarySize(bytes)}`;
}

/** Why Auto detect is missing for these preferences, if a language is undetectable. */
export function autoUnavailableNotice(
  model: CatalogModel,
  preferredLanguages: readonly string[],
): string | undefined {
  const skipped = undetectablePreferences(model, preferredLanguages).map(displayLanguage);
  if (!skipped.length) return undefined;
  const languages = new Intl.ListFormat("en", { type: "disjunction" }).format(skipped);
  return `Auto detect is unavailable for your preferred languages because it can't detect ${languages}.`;
}

/**
 * The catalog's search matching, shared by every page that lists models.
 * Each word of the query must appear literally in the model's id, name,
 * family or size, so typing a model name finds that model and little else.
 */
export function matchesCatalogSearch(model: CatalogModel, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const text = catalogModelSearchText(model);
  return tokens.every((token) => text.includes(token));
}
