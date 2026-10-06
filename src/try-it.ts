import { rawKeyHint, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Text,
  truncateToWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { microphonePermission, openMicrophone } from "./audio.js";
import { isMacOSPermissionDenied } from "./audio-errors.js";
import { markKeyPress, watchEventLoop } from "./log.js";
import { getCatalogModel } from "./catalog.js";
import { DictationController, type DictationControllerOptions } from "./dictation-controller.js";
import { microphoneSummary } from "./microphone-picker.js";
import { matchesShortcut, VoiceKeys } from "./keybindings.js";
import { COMFORTABLE_REAL_TIME_FACTOR } from "./recommendations.js";
import type { TranscribeSettings } from "./settings.js";
import { displayShortcut } from "./shortcut-core.js";
import { TranscriptionService } from "./transcription-service.js";
import { TranscriptPreview } from "./transcript-preview.js";
import { editorBorder, onboardingHeader, PANEL_PADDING, panelBorder, paneRowBudget } from "./ui-components.js";
import {
  formatTranscriptionSummary,
  METER_UPDATE_MS,
  renderMeterLine,
  SpectrumAnalyzer,
} from "./visualizer.js";

type UiTheme = ExtensionContext["ui"]["theme"];

type TryItPaneOptions = Pick<DictationControllerOptions, "openCapture" | "now"> & {
  /** Shown only before the first recording attempt when macOS has not asked yet. */
  showMacPermissionNote?: boolean;
};

export type TryItResult =
  | { action: "done" }
  | { action: "skip" }
  | { action: "shortcut" }
  | { action: "microphone" }
  | { action: "model" };

/** Shorter takes are dominated by fixed costs and say little about speed. */
const MIN_SPEECH_SECONDS_TO_JUDGE = 5;

export function realTimeFactor(speechSeconds: number, transcribeSeconds: number): number {
  return speechSeconds / Math.max(transcribeSeconds, 0.05);
}

export function needsFasterModel(speechSeconds: number, transcribeSeconds: number): boolean {
  return (
    speechSeconds >= MIN_SPEECH_SECONDS_TO_JUDGE &&
    realTimeFactor(speechSeconds, transcribeSeconds) < COMFORTABLE_REAL_TIME_FACTOR
  );
}

/** Presentation and navigation only; native resources belong to the controller. */
export class TryItPane implements Component {
  private readonly dictation: DictationController;
  private readonly analyzer = new SpectrumAnalyzer();
  private readonly preview: TranscriptPreview;
  private readonly keys: VoiceKeys;
  private nextPaintAt = 0;
  private disposed = false;
  private closed = false;
  private showMacPermissionNote: boolean;
  private modelPreparationScheduled = false;
  /** Onboarding loads models in the background; watch the loop while it's up. */
  private readonly unwatch = watchEventLoop();

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    keybindings: KeybindingsManager,
    private readonly settings: TranscribeSettings,
    service: Pick<TranscriptionService, "reserveDictation">,
    private readonly done: (result: TryItResult) => void,
    options: TryItPaneOptions = { openCapture: openMicrophone },
  ) {
    this.keys = new VoiceKeys(keybindings);
    this.preview = new TranscriptPreview(this.keys);
    this.showMacPermissionNote = options.showMacPermissionNote ?? false;
    this.dictation = new DictationController(service, {
      openCapture: options.openCapture,
      now: options.now,
      onChange: () => this.refresh(),
      onAudio: (chunk) => {
        this.analyzer.push(chunk);
        const now = Date.now();
        if (now < this.nextPaintAt) return;
        this.nextPaintAt = now + METER_UPDATE_MS;
        this.refresh();
      },
    });
  }

  private refresh(): void {
    if (!this.closed && !this.disposed) this.tui.requestRender();
  }

  invalidate(): void {
    this.preview.invalidate();
    this.refresh();
  }

  render(width: number): string[] {
    // The native backend performs some synchronous first-use initialization.
    // Start it only after this first render has put Try It on screen, so the
    // model picker never looks stuck while the next model is being prepared.
    if (!this.modelPreparationScheduled) {
      this.modelPreparationScheduled = true;
      setImmediate(() => {
        if (!this.closed && !this.disposed) this.dictation.prepare(this.settings);
      });
    }

    const state = this.dictation.state;
    const shortcut = displayShortcut(this.settings.shortcut);
    const modelName = getCatalogModel(this.settings.model.id)?.name ?? this.settings.model.id;
    const title = "Try it";
    const fg = (color: Parameters<UiTheme["fg"]>[0], text: string) => this.theme.fg(color, text);
    const text = (value: string) => new Text(value, PANEL_PADDING, 0).render(width);
    const line = (value: string) => truncateToWidth(` ${value}`, width);
    let activity = "";
    let content = fg("dim", "Your transcript will appear here.");
    let details = "";
    if (state.phase === "listening") {
      activity = renderMeterLine(this.theme, {
        bands: this.analyzer.bands, elapsedMs: this.dictation.elapsedMs,
        modelState: this.dictation.modelState,
        microphoneStopped: this.dictation.interruption !== undefined,
      });
    } else if (
      (state.phase === "idle" || state.phase === "ready") &&
      this.dictation.modelState === "loading"
    ) {
      activity = fg("muted", `Loading ${modelName}… You can start recording now.`);
    } else if (state.phase === "transcribing") {
      activity = fg("accent", "Transcribing…");
    } else if (state.phase === "starting") {
      activity = fg("muted", "Starting microphone…");
    } else if (state.phase === "cancelling") {
      activity = fg("muted", "Cancelling…");
    } else if (state.phase === "result") {
      const { text: transcript, speechSeconds, transcribeSeconds, interruption } = state.result;
      content = transcript || fg("muted", "No speech detected");
      activity = fg("muted", formatTranscriptionSummary(speechSeconds, transcribeSeconds));
      if (interruption) {
        details = fg("warning", `The microphone stopped after ${speechSeconds.toFixed(1)}s: ${interruption.message}`);
      } else if (needsFasterModel(speechSeconds, transcribeSeconds)) {
        details = fg("warning", `Slow on this machine? Press ${this.keys.keyText("voice.tryIt.model")} to try another model.`);
      }
    } else if (state.phase === "error") {
      activity = fg("error", state.stage === "model" ? "Could not load the model" : state.stage === "capture" ? "Microphone capture failed" : "Transcription failed");
      const message = state.cause instanceof Error ? state.cause.message : String(state.cause);
      details = fg("error", message);
      if (state.stage === "capture" && isMacOSPermissionDenied(state.cause)) {
        details += "\nCheck System Settings → Privacy & Security → Microphone for your terminal app.";
      }
    }
    this.preview.setText(content);

    let hints: string;
    if (state.phase === "listening") {
      hints = `${rawKeyHint(shortcut, "to transcribe")}  ${this.keys.hint("tui.select.cancel", "to discard")}`;
    } else if (
      state.phase === "transcribing" ||
      state.phase === "starting" ||
      state.phase === "cancelling"
    ) {
      hints = this.keys.hint("tui.select.cancel", "cancel");
    } else if (state.phase === "result") {
      hints = `${this.keys.hint("tui.select.confirm", "looks good")}  ${this.keys.hint("tui.select.cancel", "done")}  ${rawKeyHint(shortcut, "try again")}`;
    } else {
      hints = `${rawKeyHint(shortcut, state.phase === "error" ? "try again" : "record")}  ${this.keys.hint("tui.select.cancel", "skip")}`;
    }

    const setting = (label: string, value: string, key: string, compact: boolean) => {
      const suffix = ` (${key} to change)`;
      const labelColumn = compact ? `${label}: ` : `${label}:`.padEnd(12);
      const body = compact
        ? truncateToWidth(`${labelColumn}${value}`, Math.max(1, width - 2 - suffix.length))
        : `${labelColumn}${value}`;
      return fg("muted", body) + fg("dim", suffix);
    };
    const instructions = (compact: boolean) => compact
      ? `${shortcut} starts/stops recording`
      : `Press ${shortcut} to record, start speaking, then press again to transcribe.`;
    const topChrome = (compact: boolean): string[] => [
      ...panelBorder(this.theme).render(width),
      ...(compact ? [] : [""]),
      ...onboardingHeader(this.theme, title, 3).render(width),
      ...(compact ? [] : [""]),
      ...(compact ? [line(instructions(true))] : text(instructions(false))),
      ...(compact ? [] : [""]),
      ...(activity ? (compact ? [line(activity)] : text(activity)) : []),
    ];
    const bottomChrome = (compact: boolean): string[] => {
      const render = compact ? (value: string) => [line(value)] : text;
      const permission = !compact && this.showMacPermissionNote
        ? [
            ...text(fg("muted", "macOS will ask for microphone access the first time. Your terminal may need to be restarted.")),
            "",
          ]
        : compact || details ? [] : [""];
      return [
        ...(details ? [...text(details), ...(compact ? [] : [""])] : []),
        ...permission,
        ...render(setting("Shortcut", shortcut, this.keys.keyText("voice.tryIt.shortcut"), compact)),
        ...render(setting("Microphone", microphoneSummary(this.settings.microphone), this.keys.keyText("voice.tryIt.microphone"), compact)),
        ...render(setting("Model", modelName, this.keys.keyText("voice.tryIt.model"), compact)),
        ...(compact ? [] : [""]),
        ...text(hints),
        ...(compact ? [] : [""]),
        ...panelBorder(this.theme).render(width),
      ];
    };

    const budget = Math.max(1, paneRowBudget(this.tui) ?? 32);
    const frame = budget >= 6 ? editorBorder(this.theme).render(width) : [];
    const frameRows = frame.length * 2;
    let top = topChrome(false);
    let bottom = bottomChrome(false);
    // Reserve useful room for a transcript or error before switching to the compact chrome.
    const previewReserve = state.phase === "result" || state.phase === "error" ? 5 : 3;
    if (top.length + bottom.length + frameRows + previewReserve > budget) {
      top = topChrome(true);
      bottom = bottomChrome(true);
    }
    if (top.length + bottom.length + frameRows + 1 > budget) {
      // Tiny terminals: drop settings, but keep the task and current actions visible.
      top = [
        ...onboardingHeader(this.theme, title, 3).render(width),
        line(instructions(true)),
      ];
      bottom = [...text(hints), ...panelBorder(this.theme).render(width)];
    }
    bottom = bottom.slice(0, Math.max(0, budget - frameRows - 1));
    top = top.slice(0, Math.max(0, budget - bottom.length - frameRows - 1));
    const available = Math.max(1, budget - top.length - bottom.length - frameRows);
    const preview = this.preview.render(width, available, (value) => fg("dim", value));
    return [...top, ...frame, ...preview, ...frame, ...bottom];
  }

  private start(): void {
    markKeyPress();
    this.showMacPermissionNote = false;
    this.preview.setText("");
    this.analyzer.reset();
    this.nextPaintAt = 0;
    void this.dictation.start(this.settings);
  }

  private leave(result: TryItResult): void {
    if (this.closed || this.disposed) return;
    this.closed = true;
    void this.dictation.dispose();
    this.done(result);
  }
  handleInput(data: string): void {
    if (this.closed || this.disposed) return;
    const phase = this.dictation.state.phase;
    if (matchesShortcut(data, this.settings.shortcut)) {
      if (phase === "listening") {
        void this.dictation.stop();
      } else if (["idle", "ready", "result", "error"].includes(phase)) {
        this.start();
      }
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (["starting", "listening", "transcribing", "cancelling"].includes(phase)) {
        void this.dictation.cancel();
      } else {
        this.leave({ action: phase === "result" ? "done" : "skip" });
      }
      return;
    }
    if (!["idle", "ready", "result", "error"].includes(phase)) return;
    if ((phase === "result" || phase === "error") && this.preview.handleInput(data)) {
      this.refresh();
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (phase === "result") this.leave({ action: "done" });
      return;
    }
    if (this.keys.matches(data, "voice.tryIt.microphone")) {
      this.leave({ action: "microphone" });
    } else if (this.keys.matches(data, "voice.tryIt.shortcut")) {
      this.leave({ action: "shortcut" });
    } else if (this.keys.matches(data, "voice.tryIt.model")) {
      this.leave({ action: "model" });
    }
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.unwatch();
    return this.dictation.dispose();
  }
}

export async function tryVoice(ctx: ExtensionContext, settings: TranscribeSettings): Promise<TryItResult | undefined> {
  const service = new TranscriptionService();
  let pane: TryItPane | undefined;
  try {
    return await ctx.ui.custom<TryItResult>((tui, theme, keybindings, done) =>
      (pane = new TryItPane(tui, theme, keybindings, settings, service, done, {
        openCapture: openMicrophone,
        showMacPermissionNote: process.platform === "darwin" && microphonePermission() === "not-determined",
      })),
    );
  } finally {
    await pane?.dispose();
    await service.shutdown();
  }
}
