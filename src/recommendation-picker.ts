import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  Spacer,
  Text,
  truncateToWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  displayLanguage,
  formatBinarySize,
  modelFile,
} from "./catalog.js";
import type { CatalogModelActivation } from "./model-activation.js";
import { undetectablePreferences } from "./language-detection-policy.js";
import { autoUnavailableNotice, downloadAction } from "./model-cells.js";
import { ModelSelectionController } from "./model-selection-controller.js";
import { VoiceKeys } from "./keybindings.js";
import {
  DownloadPanel,
  LIST_PADDING,
  onboardingHeader,
  PANEL_PADDING,
  padToWidth,
  panelBorder,
  paneRowBudget,
  selectedWindow,
} from "./ui-components.js";
import { EXPERIMENTAL_MAX_ERROR_PERCENT, type ModelRecommendation } from "./recommendations.js";

const NAME_WIDTH = 34;

type UiTheme = ExtensionContext["ui"]["theme"];

export type RecommendedModelResult =
  | { type: "complete" }
  | { type: "other-models" }
  | { type: "change-languages" }
  | { type: "back" };

export type RecommendedModelPickerOptions = {
  /** Start with the alternatives unfolded. */
  expanded?: boolean;
  /** Defaults to a model-selection heading. */
  title?: string;
  /** Adds setup context and progress to the heading. */
  onboardingStep?: number;
};

/** Whether the recommendation pane has a distinct, supported trade-off to show. */
export function hasRecommendedAlternatives(
  recommendations: readonly ModelRecommendation[],
): boolean {
  const best = recommendations.find((pick) => pick.roles.includes("best")) ?? recommendations[0];
  return recommendations.some((pick) => pick !== best && pick.status === "eligible");
}

/** A cursor stop: a model to choose, or the line that reveals the rest. */
type Row =
  | { type: "model"; recommendation: ModelRecommendation }
  | { type: "alternatives" }
  | { type: "browse" };

/**
 * Step two of onboarding. One model is recommended and Enter takes it; the
 * faster and more accurate alternatives stay folded behind a question line
 * until someone arrows down to it, so a recommendation never reads as a
 * comparison. Everywhere that fold is spent — unfolded, or absent because one
 * model won every role — a row onto the full catalog replaces it.
 */
export class RecommendedModelPicker extends Container implements Focusable {
  private readonly body = new Container();
  private readonly best: ModelRecommendation;
  private readonly alternatives: readonly ModelRecommendation[];
  private expanded = false;
  private selectedIndex = 0;
  private readonly selection: ModelSelectionController<RecommendedModelResult | undefined>;
  private readonly title: string;
  private readonly onboardingStep: number | undefined;
  private downloadPanel: DownloadPanel | undefined;
  private disposed = false;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  private readonly keys: VoiceKeys;

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    keybindings: KeybindingsManager,
    private readonly languages: readonly string[],
    recommendations: readonly ModelRecommendation[],
    private readonly activate: CatalogModelActivation,
    private readonly done: (result: RecommendedModelResult | undefined) => void,
    options: RecommendedModelPickerOptions = {},
  ) {
    super();
    this.keys = new VoiceKeys(keybindings);
    this.title = options.title ?? "Choose a model";
    this.onboardingStep = options.onboardingStep;
    this.selection = new ModelSelectionController<RecommendedModelResult | undefined>(
      (...args) => this.activate(...args),
      {
        models: recommendations.map((pick) => pick.model),
        advance: true,
        completion: { type: "complete" },
        onChange: () => this.refresh(),
        onExit: (result) => {
          this.downloadPanel?.dispose();
          this.done(result);
        },
      },
    );
    this.best = recommendations.find((pick) => pick.roles.includes("best")) ?? recommendations[0]!;
    // Only benchmark-eligible alternatives are recommendations. Experimental
    // results contain one explicit fallback; unsupported and unbenchmarked
    // results lead to the full model browser instead.
    this.alternatives = recommendations.filter(
      (pick) => pick !== this.best && pick.status === "eligible",
    );
    // Opened from the Try it step the alternatives are the point, so start
    // unfolded with the cursor on the first of them.
    if (options.expanded && this.alternatives.length > 0) {
      this.expanded = true;
      this.selectedIndex = 1;
    }
    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(
      options.onboardingStep
        ? onboardingHeader(theme, this.title, options.onboardingStep)
        : new Text(theme.fg("accent", theme.bold(this.title)), PANEL_PADDING, 0),
    );
    this.addChild(
      new Text(
        `${theme.fg("muted", `Your languages: ${languages.map(displayLanguage).join(", ")}`)} · ${this.keys.hint("voice.languages.change", "change")}`,
        PANEL_PADDING,
        0,
      ),
    );
    this.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));
    this.refresh();
  }

  private rows(): Row[] {
    if (this.best.status === "unsupported" || this.best.status === "unbenchmarked") {
      return [{ type: "browse" }];
    }
    const rows: Row[] = [{ type: "model", recommendation: this.best }];
    // While the trade-offs stay folded that question is the only invitation to
    // look further; a second "more models" row beside it would turn the
    // recommendation into a comparison. Once it unfolds — or when one model
    // carries every role and there is nothing to unfold — the full catalog
    // takes its place, so the pane is never a dead end.
    if (this.expanded) {
      for (const recommendation of this.alternatives) rows.push({ type: "model", recommendation });
      rows.push({ type: "browse" });
    } else if (this.alternatives.length > 0) {
      rows.push({ type: "alternatives" });
    } else {
      rows.push({ type: "browse" });
    }
    return rows;
  }

  private offers(role: "fast" | "accurate"): boolean {
    return this.alternatives.some((pick) => pick.roles.includes(role));
  }

  /** The folded line names only the trade-offs that actually exist. */
  private question(): string {
    const faster = this.offers("fast");
    const accurate = this.offers("accurate");
    if (faster && accurate) return "For faster or more accurate transcriptions";
    return faster ? "For faster transcriptions" : "For more accurate transcriptions";
  }

  // Benchmark timings are deliberately not shown: they come from a reference
  // laptop and read as promises about this machine. The Try it step measures
  // the real wait.
  private detail(recommendation: ModelRecommendation): string {
    const faster = recommendation.roles.includes("fast");
    const accurate = recommendation.roles.includes("accurate");
    if (recommendation === this.best) {
      let text: string;
      if (faster && accurate) {
        text = recommendation.withinFastWaitTarget
          ? "Fast, accurate, and a good all-around choice."
          : "The best balance of speed and accuracy available.";
      } else if (faster && recommendation.withinFastWaitTarget) {
        text = "A well-balanced model that also transcribes quickly.";
      } else if (accurate) {
        text = "A well-balanced model with especially accurate transcriptions.";
      } else {
        text = "A good balance of speed and accuracy.";
      }
      // Recommended models support every chosen language, so Auto covers
      // them all unless the detector cannot identify one.
      if (this.languages.length > 1 && undetectablePreferences(recommendation.model, this.languages).length === 0) {
        text += " It detects which language you're speaking automatically.";
      }
      return text;
    }
    if (faster && accurate) return "Faster and more accurate.";
    if (faster) return "Faster, but may make more mistakes.";
    return "More accurate, but may take longer.";
  }

  /**
   * Title, description, and confirm verb for the rows that are not models.
   * Browsing means something different either side of a usable
   * recommendation, so its copy follows the pick's status rather than the
   * row alone.
   */
  private rowLabel(row: Exclude<Row, { type: "model" }>): {
    title: string;
    description: string;
    action: string;
  } {
    if (row.type === "alternatives") {
      return { title: "Other options", description: this.question(), action: "show alternatives" };
    }
    if (this.best.status === "unsupported" || this.best.status === "unbenchmarked") {
      return {
        title: "Browse models anyway",
        description: this.best.status === "unsupported"
          ? "Available models are unlikely to produce a usable transcript"
          : "Inspect models whose language support has not been verified",
        action: "browse models",
      };
    }
    return {
      title: "Show all models",
      description: "Search the whole catalog and pick a model yourself",
      action: "show all models",
    };
  }

  private addModelRow(recommendation: ModelRecommendation, active: boolean): void {
    const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
    const nameText = padToWidth(recommendation.model.name, NAME_WIDTH);
    const name = active ? this.theme.fg("accent", nameText) : nameText;
    const size = this.theme.fg("dim", formatBinarySize(modelFile(recommendation.model).size));
    this.body.addChild(new Text(`${prefix}${name}  ${size}`, LIST_PADDING, 0));
    this.body.addChild(this.modelDetails(recommendation));
  }

  private modelDetails(recommendation: ModelRecommendation): Container {
    const details = new Container();
    const description = recommendation.status === "experimental" && recommendation.worstLanguage
      ? this.theme.fg("warning", `Experimental: this is the best option we found, but it may make frequent mistakes in ${displayLanguage(recommendation.worstLanguage)}.`)
      : this.theme.fg("muted", this.detail(recommendation));
    details.addChild(new Text(description, LIST_PADDING + 2, 0));
    // A usable pick still spans most of an order of magnitude of error, so a
    // model near the floor should not read exactly like one many times more
    // accurate. Where the shortfall separates the picks it is a short tag on
    // the rows that have it; where it covers all of them the heading carries
    // it instead, so the same sentence never repeats down the pane.
    if (recommendation.nearFloor && recommendation.worstLanguage && !this.sharedNearFloorLanguage()) {
      details.addChild(
        new Text(
          this.theme.fg("warning", `Lower accuracy in ${displayLanguage(recommendation.worstLanguage)}.`),
          LIST_PADDING + 2,
          0,
        ),
      );
    }
    const notice = autoUnavailableNotice(recommendation.model, this.languages);
    if (notice) details.addChild(new Text(this.theme.fg("warning", notice), LIST_PADDING + 2, 0));
    return details;
  }

  private refresh(): void {
    if (this.disposed) return;
    this.body.clear();
    if (!this.selection.download) {
      this.downloadPanel?.dispose();
      this.downloadPanel = undefined;
    }
    if (this.selection.download) {
      this.downloadPanel ??= new DownloadPanel(this.tui, this.theme, this.keys, this.selection.download);
      this.downloadPanel.update(this.selection.download);
      this.body.addChild(this.downloadPanel);
      this.tui.requestRender();
      return;
    }

    this.body.addChild(new Spacer(1));
    this.body.addChild(new Text(this.heading(), PANEL_PADDING, 0));
    const notice = this.notice();
    if (notice) {
      this.body.addChild(new Text(this.theme.fg("warning", notice), PANEL_PADDING, 0));
    }
    this.body.addChild(new Spacer(1));

    // The pick stands alone; the alternatives, folded or not, are styled
    // like the model rows so they read as choices, one blank line apart.
    const rows = this.rows();
    for (const [index, row] of rows.entries()) {
      const active = index === this.selectedIndex;
      const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
      if (index > 0) {
        this.body.addChild(new Spacer(1));
      }
      if (row.type !== "model") {
        // Shaped like a model row, title then description, so it reads as
        // a choice rather than a footnote.
        const { title, description } = this.rowLabel(row);
        const padded = padToWidth(title, NAME_WIDTH);
        this.body.addChild(
          new Text(`${prefix}${active ? this.theme.fg("accent", padded) : padded}`, LIST_PADDING, 0),
        );
        this.body.addChild(
          new Text(this.theme.fg("muted", description), LIST_PADDING + 2, 0),
        );
        continue;
      }
      this.addModelRow(row.recommendation, active);
    }

    if (this.selection.feedback) {
      const { type, text } = this.selection.feedback;
      this.body.addChild(new Spacer(1));
      this.body.addChild(new Text(this.theme.fg(type, text), PANEL_PADDING, 0));
    }
    this.body.addChild(new Spacer(1));
    this.body.addChild(
      new Text(
        `${this.keys.hint("tui.select.confirm", this.confirmLabel())}  ${this.keys.hint("voice.recommendations.browseAll", "all models")}  ${this.keys.hint("tui.select.cancel", "back")}`,
        PANEL_PADDING,
        0,
      ),
    );
    this.tui.requestRender();
  }

  private heading(): string {
    const languageText = this.languages.map(displayLanguage).join(" + ");
    const title = this.best.status === "experimental" ? "Experimental option"
      : this.best.status === "unsupported" ? "No supported model"
      : this.best.status === "unbenchmarked" ? "No benchmark-backed recommendation" : "Recommended";
    return `${title} for ${languageText}`;
  }

  /**
   * The weak language when no pick escapes the note band, which makes the
   * shortfall a property of the language rather than of any one model. Judged
   * over every pick rather than the visible rows, so unfolding the
   * alternatives never changes the story the pane tells.
   */
  private sharedNearFloorLanguage(): string | undefined {
    const picks = [this.best, ...this.alternatives];
    const language = this.best.worstLanguage;
    // Different models can be weakest in different languages. No catalog pick
    // does today, but hoisting one model's weak language over a row it does
    // not describe would state something false, so disagreement falls back to
    // the per-row tags.
    return language !== undefined &&
      picks.every((pick) => pick.nearFloor && pick.worstLanguage === language)
      ? language
      : undefined;
  }

  private notice(): string {
    if (this.best.status === "unsupported") {
      return `Every measured model is at or above ${EXPERIMENTAL_MAX_ERROR_PERCENT}% benchmark error.`;
    }
    if (this.best.status === "unbenchmarked") {
      return "Model cards claim support, but measured accuracy is unavailable.";
    }
    const language = this.sharedNearFloorLanguage();
    return language
      ? `Every model here is less accurate in ${displayLanguage(language)}. Expect to correct transcripts more often.`
      : "";
  }

  private confirmLabel(): string {
    const row = this.rows()[this.selectedIndex];
    if (!row) return "choose";
    if (row.type !== "model") return this.rowLabel(row).action;
    const model = row.recommendation.model;
    return downloadAction(model, this.selection.cachedById.has(model.id));
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const budget = Math.max(1, paneRowBudget(this.tui) ?? Infinity);
    if (lines.length <= budget) return lines;
    const line = (value: string) => truncateToWidth(` ${value}`, width);
    const text = (value: string) => new Text(value, PANEL_PADDING, 0).render(width);
    const title = this.onboardingStep
      ? onboardingHeader(this.theme, this.title, this.onboardingStep).render(width)[0]!
      : line(this.theme.fg("accent", this.title));
    if (this.downloadPanel) {
      return budget === 1 ? this.downloadPanel.render(width, 1)
        : [title, ...this.downloadPanel.render(width, budget - 1)];
    }
    // Collapse whitespace and descriptions before hiding any choices. On tiny
    // terminals window the choices around the cursor, keeping the actions visible.
    const footer = text(`${this.keys.hint("tui.select.confirm", this.confirmLabel())}  ${this.keys.hint("tui.select.cancel", "back")}\n${this.keys.hint("voice.languages.change", "languages")}  ${this.keys.hint("voice.recommendations.browseAll", "all models")}`)
      .slice(0, Math.max(0, budget - 1));
    const header = [title, line(this.heading())].slice(0, Math.max(0, budget - footer.length - 1));
    const rows = this.rows();
    const room = budget - header.length - footer.length;
    const [start, end] = selectedWindow(rows, this.selectedIndex, room);
    const choices = rows.slice(start, end).map((row, index) => {
      const label = row.type === "model"
        ? `${row.recommendation.model.name} · ${formatBinarySize(modelFile(row.recommendation.model).size)}`
        : this.rowLabel(row).title;
      return line(index + start === this.selectedIndex ? this.theme.fg("accent", `→ ${label}`) : `  ${label}`);
    });
    const row = rows[this.selectedIndex];
    const detail = new Container();
    const notice = this.notice();
    if (notice) {
      detail.addChild(new Text(this.theme.fg("warning", notice), PANEL_PADDING, 0));
    }
    if (row?.type === "model") {
      detail.addChild(this.modelDetails(row.recommendation));
    } else if (row) detail.addChild(new Text(this.rowLabel(row).description, PANEL_PADDING, 0));
    const feedback = this.selection.feedback;
    const details = [...(feedback ? text(this.theme.fg(feedback.type, feedback.text)) : []), ...detail.render(width)];
    return [...header, ...choices, ...details.slice(0, room - choices.length), ...footer];
  }

  handleInput(data: string): void {
    if (!this.selection.acceptsInput) return;
    if (this.selection.download) {
      if (this.keys.matches(data, "tui.select.cancel")) {
        this.selection.cancelDownload();
      }
      return;
    }
    // Tab policy: see VOICE_KEYBINDINGS. Activation stays an explicit Enter.
    if (this.keys.matches(data, "voice.languages.continue")) return;
    if (this.keys.matches(data, "voice.languages.change")) {
      this.selection.requestExit({ type: "change-languages" });
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.selection.requestExit({ type: "back" });
      return;
    }
    const count = this.rows().length;
    if (this.keys.matches(data, "tui.select.up") && count > 1) {
      this.selectedIndex = (this.selectedIndex - 1 + count) % count;
      this.refresh();
      return;
    }
    if (this.keys.matches(data, "tui.select.down") && count > 1) {
      this.selectedIndex = (this.selectedIndex + 1) % count;
      this.refresh();
      return;
    }
    if (this.keys.matches(data, "voice.recommendations.browseAll")) {
      this.selection.requestExit({ type: "other-models" });
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      const row = this.rows()[this.selectedIndex];
      if (!row) return;
      if (row.type === "browse") {
        this.selection.requestExit({ type: "other-models" });
        return;
      }
      if (row.type === "alternatives") {
        // Unfold in place and land on the first alternative, since that is
        // what the person asked to see.
        this.expanded = true;
        this.selectedIndex = 1;
        this.refresh();
        return;
      }
      this.selection.select(row.recommendation.model);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.selection.dispose();
    this.downloadPanel?.dispose();
  }
}

export async function chooseRecommendedModel(
  ctx: ExtensionContext,
  languages: readonly string[],
  recommendations: readonly ModelRecommendation[],
  activate: CatalogModelActivation,
  options: RecommendedModelPickerOptions = {},
): Promise<RecommendedModelResult | undefined> {
  return ctx.ui.custom<RecommendedModelResult | undefined>((tui, theme, keybindings, done) =>
    new RecommendedModelPicker(
      tui,
      theme,
      keybindings,
      languages,
      recommendations,
      activate,
      done,
      options,
    ),
  );
}
