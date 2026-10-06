import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { describeError, log, logStep, sinceKeyPress } from "./log.js";
import { PcmChunker } from "./pcm-chunker.js";
import type { MicrophoneSetting, TranscribeSettings } from "./settings.js";
import type { DictationReservation, TranscriptionService } from "./transcription-service.js";

/** What a recording captured. `interruption` is why it ended early, if it did. */
export type CapturedAudio = { pcm: Float32Array; interruption?: Error; droppedFrames?: number };
/** A running recording. `stop` ends it and releases the device. */
export type Capture = { stop(): Promise<CapturedAudio> };
/** Where a recording delivers audio, in order, until its `stop` resolves. */
export type CaptureSinks = {
  onAudio(chunk: Float32Array): void;
  onFailure(error: Error): void;
};
/** Opens a microphone and starts recording; resolves once audio is flowing. */
export type OpenCapture = (microphone: MicrophoneSetting, sinks: CaptureSinks) => Promise<Capture>;
export type DictationResult = {
  text: string;
  speechSeconds: number;
  transcribeSeconds: number;
  /** The microphone failed mid-recording; `text` covers the audio before it. */
  interruption?: Error;
  /** Audio lost inside the recording because it wasn't read in time. */
  droppedFrames?: number;
};
export type DictationState =
  | { phase: "idle" | "ready" | "starting" | "listening" | "transcribing" | "cancelling" | "disposed" }
  | { phase: "result"; result: DictationResult }
  | { phase: "error"; stage: "model" | "capture" | "transcription"; cause: unknown };
export type DictationControllerOptions = {
  openCapture: OpenCapture;
  now?: () => number;
  onChange?: (state: DictationState) => void;
  onAudio?: (chunk: Float32Array) => void;
};
type Take = {
  settings: TranscribeSettings;
  reservation: DictationReservation;
  abort: AbortController;
  chunker: PcmChunker;
  capture?: Capture;
  interruption?: Error;
  stopping?: Promise<CapturedAudio>;
  submission?: Promise<DictationResult | undefined>;
};

/** Owns one capture/reservation lifecycle, never the injected service itself. */
export class DictationController {
  private current: DictationState = { phase: "idle" };
  private take: Take | undefined;
  private disposed = false;
  private cleanup: Promise<void> = Promise.resolve();
  private starting: Promise<void> | undefined;
  /** Bumped by cancel, so a start still opening the microphone knows it lost. */
  private generation = 0;
  private opening = false;
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
  /** Set when the microphone failed during the current recording. */
  get interruption(): Error | undefined { return this.take?.interruption; }

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

  /** Reserves the model for a take; on failure the state says why. */
  private reserve(settings: TranscribeSettings): Take | undefined {
    this.readiness = "loading";
    logStep("reserving model", settings.model.id);
    const reservedAt = this.now();
    let reservation: DictationReservation;
    try {
      reservation = this.service.reserveDictation(settings);
    } catch (cause) {
      this.readiness = "failed";
      this.setState({ phase: "error", stage: "model", cause });
      return undefined;
    }
    const take: Take = {
      settings, reservation, abort: new AbortController(),
      chunker: new PcmChunker((chunk) => reservation.feed(chunk)),
    };
    this.take = take;
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
    return take;
  }

  /** Optional prewarming. Model preparation overlaps with reading or recording. */
  prepare(settings: TranscribeSettings): void {
    if (this.disposed || ["starting", "listening", "transcribing", "cancelling"].includes(this.current.phase)) return;
    if (this.take?.settings === settings && this.readiness !== "failed") return;
    this.take?.reservation.cancel();
    this.take = undefined;
    if (this.reserve(settings)) this.setState({ phase: "ready" });
  }

  /**
   * Starts recording. Without a prewarmed take, the model is reserved once
   * the microphone is listening: loading it runs synchronous native setup,
   * which must not hold up the start of the recording.
   */
  start(settings: TranscribeSettings): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.current.phase === "starting") return this.starting ?? Promise.resolve();
    if (["listening", "transcribing", "cancelling"].includes(this.current.phase)) return Promise.resolve();
    let take = this.take?.settings === settings && this.readiness !== "failed" ? this.take : undefined;
    if (!take) {
      this.take?.reservation.cancel();
      this.take = undefined;
    }
    const generation = this.generation;
    this.opening = true;
    this.setState({ phase: "starting" });
    const current = () => !this.disposed && this.generation === generation && (!take || this.take === take);
    const work = this.cleanup.then(async () => {
      if (!current()) return;
      const openedAt = this.now();
      logStep("opening microphone");
      // Audio that arrives before the take exists; delivered to it in order.
      const early: Float32Array[] = [];
      let earlyFailure: Error | undefined;
      let capture: Capture;
      try {
        capture = await this.options.openCapture(settings.microphone, {
          onAudio: (chunk) => {
            if (!current()) return;
            if (take) this.feed(take, chunk);
            else early.push(chunk);
            try { this.options.onAudio?.(chunk); } catch { /* Audio is already fed. */ }
          },
          onFailure: (error) => {
            if (!current()) return;
            if (take) take.interruption = error;
            else earlyFailure = error;
            this.notify();
          },
        });
      } catch (cause) {
        if (!current()) return; // Cancelled meanwhile; cancel() released the take.
        if (take) {
          this.take = undefined;
          take.chunker.discard();
          take.reservation.cancel();
        }
        this.setState({ phase: "error", stage: "capture", cause });
        return;
      }
      const opened = this.now() - openedAt;
      if (current() && !take) {
        take = this.reserve(settings);
        if (take) {
          for (const chunk of early) this.feed(take, chunk);
          take.interruption = earlyFailure;
        }
      }
      if (!take || !current()) {
        // Cancelled or disposed while opening (cancel() waits on this
        // release), or the model couldn't be reserved (a retry waits on it).
        log.debug(`microphone opened in ${Math.round(opened)} ms, then released`);
        const release = capture.stop().then(() => undefined, () => undefined);
        if (!take && current()) this.cleanup = this.cleanup.then(() => release);
        await release;
        return;
      }
      take.capture = capture;
      this.startedAt = this.now();
      const sincePress = sinceKeyPress();
      const press = sincePress === undefined ? "" : `, ${Math.round(sincePress)} ms after the key press`;
      log.info(`listening: microphone opened in ${Math.round(opened)} ms${press}; model ${this.readiness}`);
      logStep("listening");
      this.setState({ phase: "listening" });
    }).finally(() => {
      if (this.generation === generation) this.opening = false;
    });
    this.starting = work;
    return work;
  }

  private feed(take: Take, chunk: Float32Array): void {
    // A failed stream feed falls back to submitting the whole recording.
    try { take.chunker.push(chunk); } catch { /* The recording keeps the audio. */ }
  }

  private stopCapture(take: Take): Promise<CapturedAudio> {
    if (take.stopping) return take.stopping;
    const capture = take.capture;
    take.capture = undefined;
    if (!capture) return Promise.resolve({ pcm: new Float32Array() });
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
    take.submission = this.stopCapture(take).then(async (captured) => {
      // Cancellation while the native microphone is stopping must never submit.
      if (this.take !== take || take.abort.signal.aborted) return undefined;
      const { pcm } = captured;
      const interruption = captured.interruption ?? take.interruption;
      if (interruption && pcm.length === 0) throw interruption;
      take.chunker.flush();
      stage = "transcription";
      logStep("transcribing", `${(pcm.length / CAPTURE_SAMPLE_RATE).toFixed(1)} s of audio`);
      const text = await take.reservation.submit(pcm, take.abort.signal);
      if (this.disposed || this.take !== take || take.abort.signal.aborted) return undefined;
      const result = {
        text,
        speechSeconds: pcm.length / CAPTURE_SAMPLE_RATE,
        transcribeSeconds: Math.max(0, (this.now() - stoppedAt) / 1000),
        ...(interruption ? { interruption } : {}),
        ...(captured.droppedFrames ? { droppedFrames: captured.droppedFrames } : {}),
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
    this.generation++;
    const opening = this.opening;
    this.opening = false;
    if (!take && !opening) return this.cleanup;
    if (take) {
      take.abort.abort();
      take.chunker.discard();
      take.reservation.cancel();
    }
    if (opening) log.info("start cancelled");
    else if (take?.submission) log.info("transcription cancelled");
    else if (take?.capture) log.info("recording discarded");
    logStep("idle");
    if (!this.disposed) this.setState({ phase: "cancelling" });
    const cleanup = Promise.all([
      this.cleanup,
      take && this.stopCapture(take).catch(() => undefined),
      take?.submission,
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
