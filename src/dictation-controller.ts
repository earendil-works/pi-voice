import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { describeError, log, logStep, sinceKeyPress } from "./log.js";
import { PcmChunker } from "./pcm-chunker.js";
import type { MicrophoneSetting, TranscribeSettings } from "./settings.js";
import type { DictationReservation, TranscriptionService } from "./transcription-service.js";

export type DictationCapture = {
  onFrame?: (frame: Int16Array) => void;
  start(): void;
  stop(): Promise<{ pcm: Float32Array }>;
};
export type DictationResult = { text: string; speechSeconds: number; transcribeSeconds: number };
export type DictationState =
  | { phase: "idle" | "ready" | "starting" | "listening" | "transcribing" | "cancelling" | "disposed" }
  | { phase: "result"; result: DictationResult }
  | { phase: "error"; stage: "model" | "capture" | "transcription"; cause: unknown };
export type DictationControllerOptions = {
  createCapture: (microphone: MicrophoneSetting) => DictationCapture;
  now?: () => number;
  onChange?: (state: DictationState) => void;
  onFrame?: (frame: Int16Array) => void;
};
type Take = {
  settings: TranscribeSettings;
  reservation: DictationReservation;
  abort: AbortController;
  chunker: PcmChunker;
  capture?: DictationCapture;
  stopping?: Promise<{ pcm: Float32Array }>;
  submission?: Promise<DictationResult | undefined>;
};

/** Owns one capture/reservation lifecycle, never the injected service itself. */
export class DictationController {
  private current: DictationState = { phase: "idle" };
  private take: Take | undefined;
  private disposed = false;
  private cleanup: Promise<void> = Promise.resolve();
  private starting: Promise<void> | undefined;
  private startedAt = 0;
  private readonly now: () => number;
  private readiness: "loading" | "ready" | "failed" = "loading";

  constructor(
    private readonly service: Pick<TranscriptionService, "reserveDictation">,
    private readonly options: DictationControllerOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  get state(): DictationState { return this.current; }
  get modelState(): "loading" | "ready" | "failed" { return this.readiness; }
  get elapsedMs(): number { return Math.max(0, this.now() - this.startedAt); }

  private notify(): void {
    if (this.disposed) return;
    // Presentation must not strand the reservation or drop recorded audio.
    try { this.options.onChange?.(this.current); } catch { /* UI owns rendering errors. */ }
  }
  private setState(state: DictationState): void {
    if (this.disposed) return;
    this.current = state;
    if (state.phase === "error") {
      log.error(`${state.stage} failed: ${describeError(state.cause)}`);
      logStep("idle");
    }
    this.notify();
  }

  /** Optional prewarming. Model preparation overlaps with reading or recording. */
  prepare(settings: TranscribeSettings): void {
    if (this.disposed || ["starting", "listening", "transcribing", "cancelling"].includes(this.current.phase)) return;
    if (this.take?.settings === settings && this.readiness !== "failed") return;
    this.take?.reservation.cancel();
    this.take = undefined;
    this.readiness = "loading";
    logStep("reserving model", settings.model.id);
    const reservedAt = this.now();
    let reservation: DictationReservation;
    try {
      reservation = this.service.reserveDictation(settings);
    } catch (cause) {
      this.readiness = "failed";
      this.setState({ phase: "error", stage: "model", cause });
      return;
    }
    const take: Take = {
      settings, reservation, abort: new AbortController(),
      chunker: new PcmChunker((chunk) => reservation.feed(chunk)),
    };
    this.take = take;
    this.setState({ phase: "ready" });
    void reservation.ready.then(
      () => {
        if (this.disposed || this.take !== take) return;
        log.debug(`model ready ${Math.round(this.now() - reservedAt)} ms after reserving`);
        this.readiness = "ready";
        this.notify();
      },
      (cause: unknown) => {
        if (this.disposed || this.take !== take) return;
        this.readiness = "failed";
        if (this.current.phase === "ready") this.setState({ phase: "error", stage: "model", cause });
        else {
          log.error(`model failed to load: ${describeError(cause)}`);
          this.notify(); // Keep capturing; submission will report the error.
        }
      },
    );
  }

  start(settings: TranscribeSettings): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.current.phase === "starting") return this.starting ?? Promise.resolve();
    if (["listening", "transcribing", "cancelling"].includes(this.current.phase)) return Promise.resolve();
    this.prepare(settings);
    const take = this.take;
    if (!take) return Promise.resolve();
    this.setState({ phase: "starting" });
    const work = this.cleanup.then(() => {
      if (this.disposed || this.take !== take) return;
      const openedAt = this.now();
      logStep("opening microphone");
      try {
        const capture = this.options.createCapture(settings.microphone);
        capture.onFrame = (frame) => {
          if (this.disposed || this.take !== take || take.abort.signal.aborted) return;
          take.chunker.push(frame);
          try { this.options.onFrame?.(frame); } catch { /* Audio is already fed. */ }
        };
        capture.start();
        take.capture = capture;
        this.startedAt = this.now();
        const sincePress = sinceKeyPress();
        const press = sincePress === undefined ? "" : `, ${Math.round(sincePress)} ms after the key press`;
        log.info(`listening: microphone opened in ${Math.round(this.startedAt - openedAt)} ms${press}; model ${this.readiness}`);
        logStep("listening");
        this.setState({ phase: "listening" });
      } catch (cause) {
        this.take = undefined;
        take.chunker.discard();
        take.reservation.cancel();
        this.setState({ phase: "error", stage: "capture", cause });
      }
    });
    this.starting = work;
    return work;
  }

  private stopCapture(take: Take): Promise<{ pcm: Float32Array }> {
    if (take.stopping) return take.stopping;
    const capture = take.capture;
    take.capture = undefined;
    if (!capture) return Promise.resolve({ pcm: new Float32Array() });
    capture.onFrame = undefined;
    // Normalize synchronous failures too; native implementations normally reject.
    try { take.stopping = capture.stop(); }
    catch (error) { take.stopping = Promise.reject(error); }
    return take.stopping;
  }

  stop(): Promise<DictationResult | undefined> {
    const take = this.take;
    if (!take || this.disposed) return Promise.resolve(undefined);
    if (take.submission) return take.submission;
    if (this.current.phase !== "listening") return Promise.resolve(undefined);
    const stoppedAt = this.now();
    logStep("stopping microphone");
    this.setState({ phase: "transcribing" });
    let stage: "capture" | "transcription" = "capture";
    take.submission = this.stopCapture(take).then(async ({ pcm }) => {
      // Cancellation while the native microphone is stopping must never submit.
      if (this.take !== take || take.abort.signal.aborted) return undefined;
      take.chunker.flush();
      stage = "transcription";
      logStep("transcribing", `${(pcm.length / CAPTURE_SAMPLE_RATE).toFixed(1)} s of audio`);
      const text = await take.reservation.submit(pcm, take.abort.signal);
      if (this.disposed || this.take !== take || take.abort.signal.aborted) return undefined;
      const result = {
        text,
        speechSeconds: pcm.length / CAPTURE_SAMPLE_RATE,
        transcribeSeconds: Math.max(0, (this.now() - stoppedAt) / 1000),
      };
      this.take = undefined;
      const empty = text ? "" : "; no speech detected";
      log.info(
        `transcribed ${result.speechSeconds.toFixed(1)} s of audio in ${result.transcribeSeconds.toFixed(1)} s${empty}`,
      );
      logStep("idle");
      this.setState({ phase: "result", result });
      return result;
    }).catch((cause: unknown) => {
      take.reservation.cancel(); // Releases the lane if stop failed before submit.
      if (this.disposed || this.take !== take || take.abort.signal.aborted) return undefined;
      this.take = undefined;
      this.setState({ phase: "error", stage, cause });
      return undefined;
    });
    return take.submission;
  }

  /** Cancel is serialized with capture teardown, so retries never overlap devices. */
  cancel(): Promise<void> {
    const take = this.take;
    this.take = undefined; // Invalidate callbacks before touching native resources.
    if (!take) return this.cleanup;
    take.abort.abort();
    take.chunker.discard();
    take.reservation.cancel();
    if (take.submission) log.info("transcription cancelled");
    else if (take.capture) log.info("recording discarded");
    logStep("idle");
    this.setState({ phase: "cancelling" });
    const cleanup = Promise.all([
      this.cleanup,
      this.stopCapture(take).catch(() => undefined),
      take.submission,
      this.starting,
    ]).then(() => {
      if (this.cleanup === cleanup) this.setState({ phase: "idle" });
    });
    this.cleanup = cleanup;
    return cleanup;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.current = { phase: "disposed" };
    return this.cancel();
  }
}
