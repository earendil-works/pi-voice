import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { STATUS_WIDGET_KEY } from "./shortcut-core.js";

type UiTheme = ExtensionContext["ui"]["theme"];

const WIDGET_KEY = STATUS_WIDGET_KEY;
/** Repaint interval shared by every surface that draws the meter. */
export const METER_UPDATE_MS = 50;
const LEVEL_GAIN = 36;
const DECAY = 0.65;
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const BAND_EDGES_HZ = [80, 160, 250, 400, 650, 1000, 1600, 2500, 4000, 6000] as const;

function floorPowerOfTwo(value: number): number {
  return 2 ** Math.floor(Math.log2(value));
}

function radix2Fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let index = 1, reversed = 0; index < n; index += 1) {
    let bit = n >> 1;
    while ((reversed & bit) !== 0) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      const reTmp = re[index] ?? 0;
      re[index] = re[reversed] ?? 0;
      re[reversed] = reTmp;
      const imTmp = im[index] ?? 0;
      im[index] = im[reversed] ?? 0;
      im[reversed] = imTmp;
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    const half = length >> 1;
    for (let start = 0; start < n; start += length) {
      let twiddleRe = 1;
      let twiddleIm = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddRe = (re[odd] ?? 0) * twiddleRe - (im[odd] ?? 0) * twiddleIm;
        const oddIm = (re[odd] ?? 0) * twiddleIm + (im[odd] ?? 0) * twiddleRe;
        const evenRe = re[even] ?? 0;
        const evenIm = im[even] ?? 0;
        re[even] = evenRe + oddRe;
        im[even] = evenIm + oddIm;
        re[odd] = evenRe - oddRe;
        im[odd] = evenIm - oddIm;
        const nextRe = twiddleRe * stepRe - twiddleIm * stepIm;
        twiddleIm = twiddleRe * stepIm + twiddleIm * stepRe;
        twiddleRe = nextRe;
      }
    }
  }
}

function bandEnergies(samples: Float32Array, re: Float64Array, im: Float64Array): number[] {
  const n = re.length;
  if (n < 2) return BAND_EDGES_HZ.slice(0, -1).map(() => 0);

  re.fill(0);
  im.fill(0);
  for (let index = 0; index < n; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (n - 1));
    re[index] = (samples[index] ?? 0) * window;
  }
  radix2Fft(re, im);

  const bands: number[] = [];
  for (let band = 0; band < BAND_EDGES_HZ.length - 1; band += 1) {
    const start = Math.max(1, Math.floor((BAND_EDGES_HZ[band]! * n) / CAPTURE_SAMPLE_RATE));
    const end = Math.min(
      n / 2,
      Math.ceil((BAND_EDGES_HZ[band + 1]! * n) / CAPTURE_SAMPLE_RATE),
    );
    let peak = 0;
    for (let bin = start; bin < end; bin += 1) {
      peak = Math.max(peak, Math.hypot(re[bin] ?? 0, im[bin] ?? 0));
    }
    bands.push(peak / n);
  }
  return bands;
}

function blockForLevel(level: number): string {
  const normalized = Math.min(1, Math.max(0, level) * LEVEL_GAIN);
  const index = Math.min(
    BLOCKS.length - 1,
    Math.round(Math.sqrt(normalized) * (BLOCKS.length - 1)),
  );
  return BLOCKS[index] ?? "▁";
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Shared completion summary for regular dictation and the onboarding test. */
export function formatTranscriptionSummary(
  audioSeconds: number,
  transcribeSeconds: number,
): string {
  return `Transcribed ${audioSeconds.toFixed(1)}s of audio in ${transcribeSeconds.toFixed(1)}s`;
}

export function showTranscribeStatus(
  ctx: ExtensionContext,
  text: string,
  options?: { cancelKeys?: string },
): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;
  const hint = options?.cancelKeys ? `  ${theme.fg("dim", `${options.cancelKeys} to cancel`)}` : "";
  ctx.ui.setWidget(WIDGET_KEY, [`${theme.fg("muted", text)}${hint}`]);
}

export function clearTranscribeWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/**
 * Ready line shown when setup finishes: a green check, then the body in the
 * terminal's default foreground so it matches what the user types. The help
 * command is accented and its description muted. The caller decides how long it stays.
 */
export function showReadyStatus(
  ctx: ExtensionContext,
  options: {
    talk: string;
    help: { command: string; description: string };
  },
): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;
  ctx.ui.setWidget(WIDGET_KEY, [
    `${theme.fg("success", "✓")} Pi Voice ready · ${options.talk}`,
    `${theme.fg("accent", options.help.command)} ${theme.fg("muted", options.help.description)}`,
  ]);
}

export type MeterModelState = "loading" | "ready" | "failed";

/** Peak-hold band levels computed from capture chunks. */
export class SpectrumAnalyzer {
  readonly bands: number[] = Array.from({ length: BAND_EDGES_HZ.length - 1 }, () => 0);
  private re: Float64Array | undefined;
  private im: Float64Array | undefined;

  reset(): void {
    this.bands.fill(0);
    this.re = undefined;
    this.im = undefined;
  }

  push(samples: Float32Array): void {
    const n = floorPowerOfTwo(samples.length);
    if (!this.re || !this.im || this.re.length !== n) {
      this.re = new Float64Array(n);
      this.im = new Float64Array(n);
    }
    const energies = bandEnergies(samples, this.re, this.im);
    for (let index = 0; index < this.bands.length; index += 1) {
      this.bands[index] = Math.max(energies[index] ?? 0, (this.bands[index] ?? 0) * DECAY);
    }
  }
}

/**
 * The one-line recording meter: band blocks, elapsed time, model state, and
 * an optional trailing hint. Every surface that shows a recording renders
 * through here so the editor widget and the setup pane look the same.
 */
export function renderMeterLine(
  theme: UiTheme,
  options: {
    bands: readonly number[];
    elapsedMs: number;
    modelState: MeterModelState;
    /** The microphone failed; what it captured is kept. */
    microphoneStopped?: boolean;
    /** Pre-styled key hints, as built by pi's `rawKeyHint`. */
    hints?: string;
  },
): string {
  const parts = [
    theme.fg("accent", options.bands.map(blockForLevel).join("")),
    theme.fg("muted", formatElapsed(options.elapsedMs)),
  ];
  if (options.modelState === "loading") parts.push(theme.fg("dim", "loading model"));
  if (options.modelState === "failed") parts.push(theme.fg("warning", "model load failed"));
  if (options.microphoneStopped) parts.push(theme.fg("error", "microphone stopped"));
  if (options.hints) parts.push(options.hints);
  return parts.join("  ");
}

/** Left-to-right FFT meter shown above the editor while recording. */
export class RecordingMeter {
  private readonly analyzer = new SpectrumAnalyzer();
  private startedAt = 0;
  private nextPaintAt = 0;
  private lastLine: string | undefined;
  private ctx: ExtensionContext | undefined;
  private modelState: MeterModelState = "loading";
  private microphoneStopped = false;
  private hints: string | undefined;

  start(ctx: ExtensionContext, hints: string): void {
    if (!ctx.hasUI) return;
    this.ctx = ctx;
    this.hints = hints;
    this.startedAt = Date.now();
    this.analyzer.reset();
    this.nextPaintAt = 0;
    this.lastLine = undefined;
    this.modelState = "loading";
    this.microphoneStopped = false;
    this.paint();
  }

  update(state: { modelState: MeterModelState; microphoneStopped: boolean }): void {
    this.modelState = state.modelState;
    this.microphoneStopped = state.microphoneStopped;
    this.paint();
  }

  push(samples: Float32Array): void {
    if (!this.ctx) return;
    this.analyzer.push(samples);
    const now = Date.now();
    if (now < this.nextPaintAt) return;
    this.nextPaintAt = now + METER_UPDATE_MS;
    this.paint();
  }

  stop(options?: { clearWidget?: boolean }): void {
    // Callers transitioning to another status on the same slot pass
    // clearWidget: false so the widget area never collapses between states.
    if (options?.clearWidget !== false) this.ctx?.ui.setWidget(WIDGET_KEY, undefined);
    this.ctx = undefined;
    this.lastLine = undefined;
    this.hints = undefined;
  }

  private paint(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const line = renderMeterLine(ctx.ui.theme, {
      bands: this.analyzer.bands,
      elapsedMs: Date.now() - this.startedAt,
      modelState: this.modelState,
      microphoneStopped: this.microphoneStopped,
      hints: this.hints,
    });
    if (line === this.lastLine) return;
    this.lastLine = line;
    ctx.ui.setWidget(WIDGET_KEY, [line]);
  }
}
