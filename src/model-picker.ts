import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  CATALOG_MODELS,
  canonicalLanguage,
  languageIdentity,
  displayLanguage,
  formatBinarySize,
  modelMatchesLanguage,
  rankCatalogModels,
  type CatalogModel,
  modelFile,
} from "./catalog.js";
import {
  benchmarkModels,
  frontierModelIds,
  getPreferredRecommendationLanguages,
  recommendModels,
  type ModelBenchmark,
} from "./recommendations.js";
import {
  autoUnavailableNotice,
  downloadAction,
  MANUAL_LANGUAGE_TAG,
  ON_DISK_LABEL,
  matchesCatalogSearch,
  modelDetailText,
  modelTableLayout,
  modelTableRow,
  ROLE_LABELS,
} from "./model-cells.js";
import { ModelSelectionController } from "./model-selection-controller.js";
import { ModelRatingsHelp } from "./model-ratings-help.js";
import type { CatalogModelActivation } from "./model-activation.js";
import { autoLanguagePolicy } from "./language-detection-policy.js";
import { VoiceKeys } from "./keybindings.js";
import type { TranscriptionLanguage } from "./settings.js";
import {
  DownloadPanel,
  LIST_PADDING,
  MIN_VISIBLE_ROWS,
  onboardingHeader,
  PANEL_PADDING,
  padToWidth,
  panelBorder,
  paneListWindow,
  paneRowBudget,
  selectedWindow,
  selectionMarker,
  SingleSelectPicker,
  windowSizeForBudget,
  type SingleSelectChoice,
} from "./ui-components.js";

type UiTheme = ExtensionContext["ui"]["theme"];

const MAX_VISIBLE_LANGUAGES = 9;
const PREFERRED_RECOMMENDATION_LANGUAGES =
  getPreferredRecommendationLanguages(CATALOG_MODELS);
const MAX_VISIBLE_MODELS = 16;

function formatEta(seconds: number): string {
  if (seconds < 90) return `~${Math.max(1, Math.round(seconds))}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `~${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `~${hours} h ${minutes % 60} min left`;
}
const TEXT_PADDING = PANEL_PADDING;
// Longest catalog language name is "Norwegian Nynorsk" (17).
const LANGUAGE_NAME_WIDTH = 20;
const TRANSCRIPTION_LANGUAGE_NAME_WIDTH = 28;
/**
 * A line in the model list: a section heading, a model, or the fold that
 * hides the models missing one of the chosen languages.
 */
type ListRow =
  | { type: "gap" }
  | { type: "section"; label: string }
  | { type: "model"; model: CatalogModel }
  | { type: "fold"; count: number };

function transcriptionLanguageName(
  language: string,
  supportedLanguages: readonly string[],
): string {
  const base = canonicalLanguage(language);
  const variants = supportedLanguages.filter(
    (supported) => canonicalLanguage(supported) === base,
  );
  return displayLanguage(variants.length > 1 ? language : base);
}

export type LanguageSelection = {
  languages: string[];
  /** False when the picker was closed with Esc instead of Continue. */
  confirmed: boolean;
};

export class LanguagePicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly list = new Container();
  private readonly footer = new Text("", TEXT_PADDING, 0);
  private readonly selected: Set<string>;
  private readonly available: readonly string[];
  private ordered: string[] = [];
  private filtered: string[] = [];
  private selectedIndex = 0;
  /** Scroll-window rows (rule included); shrinks to fit short terminals. */
  private windowRows = MAX_VISIBLE_LANGUAGES + 1;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  private readonly keys: VoiceKeys;

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    keybindings: KeybindingsManager,
    initial: readonly string[],
    private readonly cancelLabel: string,
    private readonly done: (result: LanguageSelection | undefined) => void,
    private readonly onboardingStep?: number,
  ) {
    super();
    this.keys = new VoiceKeys(keybindings);
    // Benchmark filtering controls new choices, not existing preferences.
    // Keep saved languages visible and removable even if their support worsens.
    this.selected = new Set(initial.map(languageIdentity).filter(Boolean));
    this.available = [...new Set([...PREFERRED_RECOMMENDATION_LANGUAGES, ...this.selected])];
    this.reorder();

    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(
      onboardingStep
        ? onboardingHeader(theme, "Choose your languages", onboardingStep)
        : new Text(
            theme.fg("accent", theme.bold("Select the languages you speak")),
            TEXT_PADDING,
            0,
          ),
    );
    this.addChild(
      new Text(
        onboardingStep
          ? "Which languages will you speak to Pi in?"
          : theme.fg("muted", "Used to recommend models"),
        TEXT_PADDING,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    // The search caret sits in the gutter, aligned with the list cursor; its
    // "> " prompt then puts the typed query on the content edge.
    const searchBox = new Box(LIST_PADDING, 0);
    searchBox.addChild(this.search);
    this.addChild(searchBox);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));
    this.refresh();
  }

  private selectedLanguages(): string[] {
    return this.available.filter((language) =>
      this.selected.has(language),
    );
  }

  // Selected languages are pinned to the top of the list so the current
  // selection is always visible without scrolling.
  private reorder(): void {
    const available = this.available;
    this.ordered = [
      ...available.filter((language) => this.selected.has(language)),
      ...available.filter((language) => !this.selected.has(language)),
    ];
  }

  private continueRowIndex(): number {
    return this.filtered.length;
  }

  private refresh(focusLanguage?: string): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter(this.ordered, query, (language) => `${displayLanguage(language)} ${language}`)
      : this.ordered;
    if (focusLanguage) {
      const index = this.filtered.indexOf(focusLanguage);
      if (index >= 0) this.selectedIndex = index;
    }
    this.selectedIndex = Math.min(this.selectedIndex, this.continueRowIndex());
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching languages"), LIST_PADDING, 0));
    } else {
      // In the unfiltered list, a rule separates the pinned (selected) group
      // from the rest. It is a real row in the scroll window (null entry), so
      // it scrolls like any other line instead of appearing and disappearing,
      // which would shift the layout below the list.
      const boundary =
        !query && this.selected.size > 0 && this.selected.size < this.filtered.length
          ? this.selected.size
          : -1;
      const rows: (string | null)[] =
        boundary >= 0
          ? [...this.filtered.slice(0, boundary), null, ...this.filtered.slice(boundary)]
          : [...this.filtered];
      const cursorRow =
        boundary >= 0 && this.selectedIndex >= boundary
          ? this.selectedIndex + 1
          : this.selectedIndex;
      // Sized +1 so the window holds the same line count with or without the
      // rule row.
      const [start, end] = selectedWindow(rows, cursorRow, this.windowRows);
      for (let index = start; index < end; index += 1) {
        const language = rows[index]!;
        if (language === null) {
          this.list.addChild(
            new Text(`  ${this.theme.fg("dim", "─".repeat(LANGUAGE_NAME_WIDTH + 6))}`, LIST_PADDING, 0),
          );
          continue;
        }
        const active = index === cursorRow;
        const checked = this.selected.has(language);
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const mark = selectionMarker(this.theme, checked);
        const name = padToWidth(displayLanguage(language), LANGUAGE_NAME_WIDTH);
        this.list.addChild(
          new Text(
            `${prefix}${mark} ${active ? this.theme.fg("accent", name) : name}${this.theme.fg("dim", language)}`,
            LIST_PADDING,
            0,
          ),
        );
      }
    }

    const selected = this.selectedLanguages();
    const onContinue = this.selectedIndex === this.continueRowIndex();
    const continuePrefix = onContinue ? this.theme.fg("accent", "→ ") : "  ";
    const continueAction = ` ${this.keys.keyText("voice.languages.continue")}  Continue `;
    const continueRow = selected.length === 0
      ? this.theme.fg("warning", "Select at least one language to continue")
      : this.theme.inverse(
          this.theme.fg("accent", this.theme.bold(continueAction)),
        );
    this.list.addChild(new Spacer(1));
    this.list.addChild(new Text(`${continuePrefix}${continueRow}`, LIST_PADDING, 0));

    this.footer.setText(
      `${this.keys.navHint("move")}  ${this.keys.hint(["voice.languages.toggle", "tui.select.confirm"], "select")}  ${this.keys.hint("tui.select.cancel", query ? "clear search" : this.cancelLabel)}`,
    );
    this.tui.requestRender();
  }

  private toggleHighlighted(): void {
    const language = this.filtered[this.selectedIndex];
    if (!language) return;
    const adding = !this.selected.has(language);
    if (adding) this.selected.add(language);
    else this.selected.delete(language);
    this.reorder();
    // A search query is spent once used: clear it so the full list returns.
    this.search.setValue("");
    // Follow a newly selected language so the user sees it land in the pinned
    // group; on deselect stay put — trailing the language to its new spot far
    // down the list is disorienting.
    this.refresh(adding ? language : undefined);
  }

  // The pane replaces the host editor and cannot scroll: when the terminal is
  // short, shrink the window so the title, Continue row, and footer stay on
  // screen.
  override render(width: number): string[] {
    const budget = paneRowBudget(this.tui);
    if (budget !== undefined) {
      const chrome = super.render(width).length - this.list.render(width).length;
      // The spacer and Continue row live inside the list; the scroll window
      // gets the rest, still +1 sized for the rule row.
      const rows = windowSizeForBudget(
        budget - chrome - 2,
        MAX_VISIBLE_LANGUAGES + 1,
        MIN_VISIBLE_ROWS + 1,
      );
      if (rows !== this.windowRows) {
        this.windowRows = rows;
        this.refresh();
      }
    }
    return super.render(width);
  }

  handleInput(data: string): void {
    const lastIndex = this.continueRowIndex();
    if (this.keys.matches(data, "voice.languages.continue")) {
      const selected = this.selectedLanguages();
      if (selected.length > 0) this.done({ languages: selected, confirmed: true });
      return;
    }
    if (this.keys.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? lastIndex : this.selectedIndex - 1;
      this.refresh();
      return;
    }
    if (this.keys.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === lastIndex ? 0 : this.selectedIndex + 1;
      this.refresh();
      return;
    }
    if (this.keys.matches(data, "voice.languages.toggle")) {
      this.toggleHighlighted();
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (this.selectedIndex === this.continueRowIndex()) {
        const selected = this.selectedLanguages();
        if (selected.length > 0) this.done({ languages: selected, confirmed: true });
        return;
      }
      // Enter on a language toggles it, so landing Enter never silently
      // confirms a selection the user was not pointing at.
      this.toggleHighlighted();
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else {
        // Esc keeps the current selection; only an empty selection reads as
        // "never mind".
        const selected = this.selectedLanguages();
        this.done(
          selected.length > 0 ? { languages: selected, confirmed: false } : undefined,
        );
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }
}

export type CatalogModelPickerResult =
  | { type: "change-languages" }
  | { type: "complete" };

export type CatalogModelPostActivation = "stay" | "advance";

export type CatalogModelPickerOptions = {
  /** What the host does after activation and its settings commit succeed. */
  postActivation?: CatalogModelPostActivation;
  /** The host is reopening this picker after an activation in the same flow. */
  activatedInFlow?: boolean;
  /** What Esc does once there is no search to clear; the host knows where it leads. */
  cancelLabel?: string;
  /** Optional onboarding shell for catalog detours. */
  onboardingStep?: number;
  title?: string;
};

export class CatalogModelPicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly searchBox = new Box(LIST_PADDING, 0);
  private readonly body = new Container();
  private readonly preferredLine = new Text("", TEXT_PADDING, 0);
  private readonly list = new Container();
  private readonly detail = new Text("", TEXT_PADDING, 0);
  private readonly footer = new Text("", TEXT_PADDING, 0);
  private readonly ratingsHelp: ModelRatingsHelp;
  private readonly selection: ModelSelectionController<CatalogModelPickerResult | undefined>;
  private readonly cancelLabel: string;
  private readonly languageColumns: readonly string[];
  /** Benchmarks on every chosen language; absent models miss one. */
  private readonly benchmarks: ReadonlyMap<string, ModelBenchmark>;
  /** Frontier models and role picks, most accurate first. */
  private readonly recommended: readonly CatalogModel[];
  /** The other benchmarked models, most accurate first, the unusable last. */
  private readonly benchmarked: readonly CatalogModel[];
  /** The rest: missing a chosen language or a benchmark for it. */
  private readonly unbenchmarked: readonly CatalogModel[];
  private readonly roleTags: ReadonlyMap<string, string>;
  private folded = true;
  /** Widest model name / formatted size in the catalog; column ceilings. */
  private readonly modelNameWidth: number;
  private readonly modelSizeWidth: number;
  /** Width of the last render; row columns are laid out against it. */
  private renderWidth = 80;
  /** Rows the model window may use; shrinks to fit short terminals. */
  private visibleModels = MAX_VISIBLE_MODELS;
  private rows: ListRow[] = [];
  /** The models in list order; the cursor only ever rests on these or the fold. */
  private filtered: CatalogModel[] = [];
  private selectedIndex = 0;
  private downloadPanel: DownloadPanel | undefined;
  private disposed = false;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && !this.selection.download && !this.ratingsHelp.isOpen;
  }

  private readonly keys: VoiceKeys;

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    keybindings: KeybindingsManager,
    private readonly preferredLanguages: readonly string[],
    currentModelId: string | undefined,
    private readonly done: (result: CatalogModelPickerResult | undefined) => void,
    private readonly onActivate: CatalogModelActivation,
    options: CatalogModelPickerOptions = {},
  ) {
    super();
    this.keys = new VoiceKeys(keybindings);
    this.cancelLabel = options.cancelLabel ?? "close";
    this.ratingsHelp = new ModelRatingsHelp(tui, theme, this.keys, true);
    this.selection = new ModelSelectionController<CatalogModelPickerResult | undefined>((...args) => this.onActivate(...args), {
      models: CATALOG_MODELS,
      currentModelId,
      activatedInFlow: options.activatedInFlow,
      advance: options.postActivation === "advance",
      completion: { type: "complete" },
      onChange: () => this.refresh(),
      onExit: (result) => { this.ratingsHelp.close(); this.stopSpinner(); this.done(result); },
    });
    this.languageColumns = [...new Set(preferredLanguages.map(languageIdentity))];
    // Without chosen languages there is nothing to benchmark against, so the
    // list falls back to the catalog's own ranking, unsectioned.
    this.benchmarks = this.languageColumns.length
      ? benchmarkModels(CATALOG_MODELS, this.languageColumns)
      : new Map();
    const byError = (left: CatalogModel, right: CatalogModel) =>
      this.benchmarks.get(left.id)!.error - this.benchmarks.get(right.id)!.error;
    const measured = CATALOG_MODELS.filter((model) => this.benchmarks.has(model.id));
    const byAccuracy = [
      ...measured.filter((model) => this.benchmarks.get(model.id)!.usable).sort(byError),
      ...measured.filter((model) => !this.benchmarks.get(model.id)!.usable).sort(byError),
    ];
    // The model in use is never folded away, whatever the chosen languages:
    // it takes the last row of the second section, dashes and all.
    const current = CATALOG_MODELS.find(
      (model) => model.id === currentModelId && !this.benchmarks.has(model.id),
    );
    this.unbenchmarked = rankCatalogModels(
      CATALOG_MODELS.filter((model) => !this.benchmarks.has(model.id) && model !== current),
      preferredLanguages,
      (model) => this.selection.cachedById.has(model.id),
    );
    // The picks carry their role; a pick that is also a frontier model is
    // still listed once.
    const roleTags = new Map<string, string>();
    if (this.languageColumns.length) {
      for (const pick of recommendModels(CATALOG_MODELS, this.languageColumns)) {
        if (pick.status !== "eligible") continue;
        roleTags.set(pick.model.id, pick.roles.map((role) => ROLE_LABELS[role]).join(" · "));
      }
    }
    this.roleTags = roleTags;
    // A model is listed once: recommended, or among the rest.
    const frontier = frontierModelIds(this.benchmarks);
    this.recommended = byAccuracy.filter(
      (model) => frontier.has(model.id) || roleTags.has(model.id),
    );
    this.benchmarked = [
      ...byAccuracy.filter((model) => !this.recommended.includes(model)),
      ...(current ? [current] : []),
    ];

    this.modelNameWidth = Math.max(
      ...CATALOG_MODELS.map((model) => visibleWidth(model.name)),
    );
    this.modelSizeWidth = Math.max(
      visibleWidth(ON_DISK_LABEL),
      ...CATALOG_MODELS.map((model) => visibleWidth(formatBinarySize(modelFile(model).size))),
    );

    const title = options.title ?? (options.onboardingStep ? "Browse all models" : "Choose a model");
    this.searchBox.addChild(this.search);
    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(
      options.onboardingStep
        ? onboardingHeader(theme, title, options.onboardingStep)
        : new Text(
            theme.fg("accent", theme.bold(title)),
            TEXT_PADDING,
            0,
          ),
    );
    this.addChild(this.preferredLine);
    this.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));

    // The cursor opens on the model in use, the first row of Downloaded;
    // without one it rests at the top, on the best recommendation.
    this.refresh();
    if (currentModelId) {
      const index = this.rows.findIndex(
        (row) => row.type === "model" && row.model.id === currentModelId,
      );
      if (index !== -1) {
        this.selectedIndex = index;
        this.refresh();
      }
    }
  }

  /** Cached models, current first, then most accurate on the chosen languages. */
  private downloadedModels(): CatalogModel[] {
    const currentId = this.selection.displayedModelId;
    const error = (model: CatalogModel) =>
      this.benchmarks.get(model.id)?.error ?? Number.POSITIVE_INFINITY;
    return CATALOG_MODELS.filter((model) => this.selection.cachedById.has(model.id)).sort(
      (left, right) =>
        Number(right.id === currentId) - Number(left.id === currentId) ||
        error(left) - error(right),
    );
  }

  // Section headings and the gaps above them are landmarks, not choices:
  // the cursor skips them.
  private selectable(index: number): boolean {
    const type = this.rows[index]?.type;
    return type !== "section" && type !== "gap";
  }

  private moveSelection(step: 1 | -1): void {
    if (!this.rows.some((_, index) => this.selectable(index))) return;
    let index = this.selectedIndex;
    do {
      index = (index + step + this.rows.length) % this.rows.length;
    } while (!this.selectable(index));
    this.selectedIndex = index;
    this.refresh();
  }

  private highlightedModel(): CatalogModel | undefined {
    const row = this.rows[this.selectedIndex];
    return row?.type === "model" ? row.model : undefined;
  }

  // The sectioned list: models on disk first, then the ranked catalog with
  // each of them left out, so a model is listed once. A search filters each
  // section in place, in its own order, and reaches the folded models too:
  // while a query is on they are a section of their own, so a match there
  // says why it was folded.
  private buildRows(query: string): ListRow[] {
    const downloaded = this.downloadedModels();
    const onDisk = new Set(downloaded.map((model) => model.id));
    const matching = (models: readonly CatalogModel[]) =>
      query ? models.filter((model) => matchesCatalogSearch(model, query)) : models;
    const keep = (models: readonly CatalogModel[]) =>
      matching(models).filter((model) => !onDisk.has(model.id));
    const rows: ListRow[] = [];
    const section = (label: string, models: readonly CatalogModel[]) => {
      if (!models.length) return;
      if (rows.length) rows.push({ type: "gap" });
      rows.push({ type: "section", label });
      for (const model of models) rows.push({ type: "model", model });
    };
    // Every section row is also the column header row, so the language the
    // grades cover is on the same line and the labels can stay short.
    section("Downloaded", matching(downloaded));
    if (!this.languageColumns.length) {
      section("All models", keep(this.unbenchmarked));
      return rows;
    }
    section("Recommended", keep(this.recommended));
    section(`${this.recommended.length ? "Other" : "All"} models`, keep(this.benchmarked));
    const rest = keep(this.unbenchmarked);
    if (query) {
      section("Other languages", rest);
    } else if (rest.length) {
      rows.push({ type: "fold", count: rest.length });
      if (!this.folded) for (const model of rest) rows.push({ type: "model", model });
    }
    return rows;
  }

  override invalidate(): void {
    super.invalidate();
    this.ratingsHelp.invalidate();
  }

  // Column widths depend on the terminal: relay out when the width changes so
  // rows truncate their name column instead of wrapping onto a second line.
  // Short terminals also shrink the list window so the title, Languages line,
  // detail, and footer stay on screen; the downloading panel is short enough
  // to be exempt.
  override render(width: number): string[] {
    if (this.ratingsHelp.isOpen) return this.ratingsHelp.render(width);
    if (width !== this.renderWidth) {
      this.renderWidth = width;
      this.refresh();
    }
    const visible = this.selection.download
      ? undefined
      : paneListWindow(
          this.tui,
          super.render(width).length,
          this.list.render(width).length,
          this.detail.render(width).length,
          this.detailReserve(width),
          MAX_VISIBLE_MODELS,
        );
    if (visible !== undefined && visible !== this.visibleModels) {
      this.visibleModels = visible;
      this.refresh();
    }
    return super.render(width);
  }

  // The description is truncated to one line, so only transient feedback can
  // change the detail height; reserving for it keeps the window steady.
  private detailReserve(width: number): number {
    const feedbackLines = this.selection.feedback
      ? new Text(this.selection.feedback.text, TEXT_PADDING, 0).render(width).length
      : 0;
    const model = this.highlightedModel();
    const notices = model ? this.modelNotices(model) : "";
    const noticeLines = notices ? new Text(notices, TEXT_PADDING, 0).render(width).length : 0;
    // Description, features, and the undetectable-language warning.
    return 2 + feedbackLines + noticeLines;
  }

  private refresh(): void {
    if (this.disposed) return;
    this.body.clear();
    if (!this.selection.download) this.stopSpinner();
    const preferredAction = this.selection.selectedDuringSession
      ? ""
      : ` · ${this.keys.hint("voice.languages.change", "change")}`;
    const languagesText = truncateToWidth(
      `Your languages: ${this.preferredLanguages.map(displayLanguage).join(", ")}`,
      Math.max(24, this.renderWidth - TEXT_PADDING * 2 - visibleWidth(preferredAction)),
      "…",
    );
    this.preferredLine.setText(`${this.theme.fg("muted", languagesText)}${preferredAction}`);
    this.search.focused = this._focused && !this.selection.download && !this.ratingsHelp.isOpen;

    if (this.selection.download) {
      this.downloadPanel ??= new DownloadPanel(this.tui, this.theme, this.keys, this.selection.download);
      this.downloadPanel.update(this.selection.download, this.downloadStats());
      this.body.addChild(this.downloadPanel);
      this.tui.requestRender();
      return;
    }

    this.body.addChild(new Spacer(1));
    this.body.addChild(this.searchBox);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.list);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.detail);
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.footer);

    const query = this.search.getValue().trim();
    // Selecting a model reorders the Downloaded section, so the cursor
    // follows the highlighted model rather than its old row number.
    const highlightedId = this.highlightedModel()?.id;
    this.rows = this.buildRows(query);
    this.filtered = this.rows.flatMap((row) => (row.type === "model" ? [row.model] : []));
    const followed = highlightedId === undefined
      ? -1
      : this.rows.findIndex((row) => row.type === "model" && row.model.id === highlightedId);
    this.selectedIndex = followed !== -1
      ? followed
      : Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
    if (!this.selectable(this.selectedIndex)) {
      const next = this.rows.findIndex((_, index) => index > this.selectedIndex && this.selectable(index));
      this.selectedIndex = next === -1 ? this.selectedIndex : next;
    }
    this.list.clear();
    const displayedId = this.selection.displayedModelId;

    if (this.rows.length === 0) {
      this.list.addChild(new Text(this.theme.fg("dim", "  No matching models"), LIST_PADDING, 0));
      this.detail.setText("");
    } else {
      const [start, end] = selectedWindow(this.rows, this.selectedIndex, this.visibleModels);
      const table = modelTableLayout(
        this.theme,
        this.renderWidth,
        this.modelNameWidth,
        this.languageColumns,
        this.modelSizeWidth,
      );
      for (let index = start; index < end; index += 1) {
        const row = this.rows[index]!;
        const active = index === this.selectedIndex;
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        if (row.type === "gap") {
          this.list.addChild(new Spacer(1));
          continue;
        }
        if (row.type === "section") {
          this.list.addChild(new Text(table.header(row.label), LIST_PADDING, 0));
          continue;
        }
        if (row.type === "fold") {
          const arrow = this.folded ? "▸" : "▾";
          const label = `${arrow} ${row.count} more models missing one of your languages`;
          this.list.addChild(
            new Text(`${prefix}  ${active ? this.theme.fg("accent", label) : label}`, LIST_PADDING, 0),
          );
          continue;
        }
        const model = row.model;
        const benchmark = this.benchmarks.get(model.id);
        const role = this.roleTags.get(model.id);
        const tag = role
          ? this.theme.fg("accent", role)
          : benchmark?.manual
            ? this.theme.fg("dim", MANUAL_LANGUAGE_TAG)
            : "";
        this.list.addChild(
          new Text(
            modelTableRow(this.theme, model, this.languageColumns, table, {
              active,
              current: model.id === displayedId,
              tag,
              downloaded: this.selection.cachedById.has(model.id),
            }),
            LIST_PADDING,
            0,
          ),
        );
      }
      const selected = this.highlightedModel();
      if (!selected) {
        this.detail.setText(
          `${this.theme.fg("muted", "Models that lack one of your languages, or a benchmark for it.")}\n${this.theme.fg("dim", this.folded ? "Enter shows them" : "Enter hides them again")}`,
        );
        this.finishFooter(query);
        return;
      }
      this.detail.setText(
        modelDetailText(
          this.theme,
          selected,
          this.renderWidth,
          TEXT_PADDING,
          this.selection.feedback,
        ) + this.modelNotices(selected),
      );
    }
    this.finishFooter(query);
  }

  private modelNotices(model: CatalogModel): string {
    const notice = autoUnavailableNotice(model, this.preferredLanguages);
    return notice ? `\n${this.theme.fg("warning", notice)}` : "";
  }

  private finishFooter(query: string): void {
    const displayedId = this.selection.displayedModelId;
    const total = CATALOG_MODELS.length;
    const shown = query
      ? `${this.filtered.length}/${total} matching models`
      : `${total} models`;
    const statusLegend = displayedId
      ? `${selectionMarker(this.theme, true)} ${this.theme.fg("dim", "current")}`
      : "";
    const closeLabel = query ? "clear search" : this.cancelLabel;
    // The confirm key says what it will do for the highlighted row.
    const highlighted = this.highlightedModel();
    const confirmLabel = this.rows[this.selectedIndex]?.type === "fold"
      ? this.folded ? "show" : "hide"
      : highlighted
        ? downloadAction(highlighted, this.selection.cachedById.has(highlighted.id))
        : "choose";
    this.footer.setText(
      `${this.theme.fg("dim", shown)}  ${statusLegend}  ${this.keys.hint("voice.models.ratingsHelp", "rating guide")}\n${this.keys.navHint("navigate")}  ${this.keys.hint("tui.select.confirm", confirmLabel)}  ${this.keys.hint("tui.select.cancel", closeLabel)}`,
    );
    this.tui.requestRender();
  }

  private downloadStats(): string {
    const { downloaded, total } = this.selection.download!;
    if (total === 0) return "Preparing download…";
    const parts = [`${formatBinarySize(downloaded)} / ${formatBinarySize(total)}`];
    const speed = this.selection.downloadSpeed;
    if (speed !== undefined && speed > 0) {
      parts.push(`${formatBinarySize(speed)}/s`);
      const remaining = (total - downloaded) / speed;
      if (remaining > 1) parts.push(formatEta(remaining));
    }
    return parts.join(" · ");
  }

  private stopSpinner(): void {
    this.downloadPanel?.dispose();
    this.downloadPanel = undefined;
  }

  handleInput(data: string): void {
    // An exit is waiting on the final save; the picker is already closing.
    if (!this.selection.acceptsInput) return;
    if (this.ratingsHelp.isOpen) {
      this.ratingsHelp.handleInput(data);
      this.focused = this._focused;
      return;
    }
    if (this.selection.download) {
      // Downloading is the one modal state: the progress panel is visible, so
      // ignoring everything except cancel cannot read as a dead keyboard.
      // Stopping is cheap: the partial file stays in the cache, and selecting
      // the model again resumes from where it left off.
      if (this.keys.matches(data, "tui.select.cancel")) this.selection.cancelDownload();
      return;
    }

    if (this.keys.matches(data, "voice.models.ratingsHelp")) {
      this.ratingsHelp.open();
      this.focused = this._focused;
      return;
    }
    // Tab policy: see VOICE_KEYBINDINGS. Also keeps it out of the search.
    if (this.keys.matches(data, "voice.languages.continue")) return;
    if (
      !this.selection.selectedDuringSession &&
      this.keys.matches(data, "voice.languages.change")
    ) {
      this.selection.requestExit({ type: "change-languages" });
      return;
    }
    if (this.keys.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.keys.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (this.rows[this.selectedIndex]?.type === "fold") {
        this.folded = !this.folded;
        this.refresh();
        return;
      }
      const selected = this.highlightedModel();
      if (!selected) return;
      // Enter on a model that is not cached starts its download immediately;
      // the detail pane already spells out the size, license, and source.
      this.selection.select(selected);
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else {
        this.selection.requestExit(undefined);
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.ratingsHelp.close();
    this.stopSpinner();
    this.selection.dispose();
  }
}

export function defaultSpokenLanguages(): string[] {
  const locale = languageIdentity(Intl.DateTimeFormat().resolvedOptions().locale);
  return PREFERRED_RECOMMENDATION_LANGUAGES.includes(locale) ? [locale] : ["en"];
}

export async function chooseLanguages(
  ctx: ExtensionContext,
  initial: readonly string[] = defaultSpokenLanguages(),
  options: { cancelLabel?: string; onboardingStep?: number } = {},
): Promise<LanguageSelection | undefined> {
  return ctx.ui.custom<LanguageSelection | undefined>((tui, theme, keybindings, done) =>
    new LanguagePicker(
      tui,
      theme,
      keybindings,
      initial,
      options.cancelLabel ?? "close",
      done,
      options.onboardingStep,
    ),
  );
}

export async function chooseCatalogModel(
  ctx: ExtensionContext,
  preferredLanguages: readonly string[],
  currentModelId: string | undefined,
  options: {
    onActivate: CatalogModelActivation;
    postActivation?: CatalogModelPostActivation;
    /** A model was already activated earlier in this flow. */
    activatedInFlow?: boolean;
    /** What Esc does once there is no search to clear. */
    cancelLabel?: string;
    /** Optional onboarding shell for catalog detours. */
    onboardingStep?: number;
    title?: string;
  },
): Promise<CatalogModelPickerResult | undefined> {
  return ctx.ui.custom<CatalogModelPickerResult | undefined>(
    (tui, theme, keybindings, done) =>
      new CatalogModelPicker(
        tui,
        theme,
        keybindings,
        preferredLanguages,
        currentModelId,
        done,
        options.onActivate,
        {
          postActivation: options.postActivation,
          activatedInFlow: options.activatedInFlow,
          cancelLabel: options.cancelLabel,
          onboardingStep: options.onboardingStep,
          title: options.title,
        },
      ),
  );
}

export function transcriptionLanguageSummary(
  language: TranscriptionLanguage,
  model: CatalogModel,
): string {
  return language === "auto"
    ? "Auto detect"
    : transcriptionLanguageName(language, model.languages);
}

/** Single-choice picker over a model's transcription languages. */
export function createTranscriptionLanguagePicker(
  tui: TUI,
  theme: UiTheme,
  keybindings: KeybindingsManager,
  model: CatalogModel,
  current: TranscriptionLanguage,
  preferredLanguages: readonly string[],
  done: (language: TranscriptionLanguage | undefined) => void,
): SingleSelectPicker<TranscriptionLanguage> {
  const preferred = new Set(preferredLanguages.map(languageIdentity));
  const isPreferred = (value: TranscriptionLanguage): boolean =>
    value !== "auto" && preferred.has(languageIdentity(value));
  const languages: SingleSelectChoice<TranscriptionLanguage>[] = [
    ...new Set(model.languages),
  ]
    .map((language) => ({
      value: language,
      label: transcriptionLanguageName(language, model.languages),
    }))
    .sort(
      (left, right) =>
        Number(isPreferred(right.value)) - Number(isPreferred(left.value)) ||
        left.label.localeCompare(right.label) ||
        left.value.localeCompare(right.value),
    );
  const policy = autoLanguagePolicy(model, preferredLanguages);
  const autoAvailable = policy.kind !== "unsupported";
  const auto: SingleSelectChoice<TranscriptionLanguage> = policy.kind === "detect"
    ? {
      value: "auto",
      label: "Auto detect",
      description: `Detects which of your preferred languages you're speaking (${new Intl.ListFormat("en", { type: "disjunction" }).format(
        policy.languages.map((language) => transcriptionLanguageName(language, model.languages)),
      )}) in each recording.`,
    }
    : { value: "auto", label: "Auto detect" };
  const choices: SingleSelectChoice<TranscriptionLanguage>[] = [
    ...(autoAvailable ? [auto] : []),
    ...languages,
  ];
  return new SingleSelectPicker(
    tui,
    theme,
    keybindings,
    choices,
    current,
    {
      title: "Choose transcription language",
      subtitle: autoAvailable
        ? "Language expected in recordings, or automatic detection."
        : "Language expected in recordings.",
      searchable: true,
      maximumVisible: MAX_VISIBLE_LANGUAGES,
      cancelLabel: "back",
      renderLabel: (choice, active) => {
        const nameText = padToWidth(choice.label, TRANSCRIPTION_LANGUAGE_NAME_WIDTH);
        const name = active ? theme.fg("accent", nameText) : nameText;
        const code = choice.value === "auto" ? "" : theme.fg("dim", choice.value);
        return `${name}  ${code}`;
      },
    },
    done,
  );
}
