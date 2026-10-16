import { LANGUAGE_DETECTION_MODEL, displayLanguage, getCatalogModel } from "./catalog.js";
import { isChineseLanguage } from "./chinese.js";
import {
  ChunkedDictationStream,
  ChunkedTranscriber,
  chunksTranscription,
  MAX_CHUNK_SAMPLES,
  type ChunkDecoder,
} from "./chunking.js";
import { Deferred } from "./deferred.js";
import {
  detectLanguage,
  missingDetectorWarning,
  settingsLanguagePolicy,
  undetectablePreferences,
  type AutoLanguagePolicy,
} from "./language-detection-policy.js";
import { describeError, log } from "./log.js";
import type { TranscribeSettings } from "./settings.js";
import type {
  DictationStream,
  TranscribeCppBackend,
  TranscriptionOptions,
} from "./transcription.js";

/** A transcript, plus any language identification fallback or limitation. */
export type Transcript = { text: string; warning?: string };

/** Silero's probability for each 512-sample frame of a whole clip. */
export type ClipScorer = (pcm: Float32Array, signal: AbortSignal) => Promise<readonly number[]>;

/** Audio fed during recording, with its Silero frame probabilities when it has them. */
type FedChunk = { pcm: Float32Array; probs?: readonly number[] };

/** Decodes a take's audio in the language chosen from its start, once. */
type TakeDecoder = { decode: ChunkDecoder; readonly warning: string | undefined };

type TranscriptionJob = {
  settings: TranscribeSettings;
  policy: AutoLanguagePolicy;
  pcm: Float32Array;
  signal?: AbortSignal;
  resolve: (transcript: Transcript) => void;
  reject: (error: unknown) => void;
  started: boolean;
  settled: boolean;
  removeAbortListener?: () => void;
};

type ReservationState = {
  settings: TranscribeSettings;
  policy: AutoLanguagePolicy;
  accepting: boolean;
  submitted: boolean;
  cancelled: boolean;
  started: boolean;
  /** Settles once the model (and stream, when available) is ready, or on failure. */
  ready: Deferred;
  /** Resolves when recording ends, whether by submit or cancel. */
  submission: Deferred;
  result: Deferred<Transcript>;
  fullPcm?: Float32Array;
  signal?: AbortSignal;
  removeAbortListener?: () => void;
  chunks: FedChunk[];
  stream?: DictationStream;
  /** The take's chunked stream, kept after reset until its decoding settles. */
  chunked?: { stream: ChunkedDictationStream; decoder: TakeDecoder };
  drain?: Promise<void>;
  streamUnavailable: boolean;
  streamError?: unknown;
};

export type DictationReservation = {
  readonly ready: Promise<void>;
  feed(chunk: Float32Array, probs?: readonly number[]): void;
  submit(pcm: Float32Array, signal?: AbortSignal): Promise<Transcript>;
  cancel(): void;
};

type ReusableBackend = Pick<
  TranscribeCppBackend,
  "prepare" | "transcribe" | "dispose"
> & {
  startStream?: (
    options?: TranscriptionOptions,
  ) => Promise<DictationStream | undefined>;
  identifyLanguage?: TranscribeCppBackend["identifyLanguage"];
};

type BackendFactory = (
  modelPath: string,
) => ReusableBackend | Promise<ReusableBackend>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Transcription cancelled");
}

function cancellationError(state: ReservationState): Error {
  return state.signal?.aborted ? abortError(state.signal) : new Error("Dictation cancelled");
}

function transcriptionOptions(
  settings: TranscribeSettings,
  language: string | undefined,
  signal?: AbortSignal,
): TranscriptionOptions {
  return {
    signal,
    language,
    chineseOutput: settings.chineseOutput,
    chineseEnabled: isChineseLanguage(settings.transcriptionLanguage) ||
      settings.preferredLanguages.some(isChineseLanguage),
  };
}

function fixedLanguage(policy: AutoLanguagePolicy): string | undefined {
  return policy.kind === "fixed" ? policy.language : undefined;
}

async function cachedDetectorPath(): Promise<string | undefined> {
  // Keeps Hugging Face modules off the path of every other take.
  const { findCachedCatalogModel } = await import("./models.js");
  return findCachedCatalogModel(LANGUAGE_DETECTION_MODEL)?.path;
}

/** Owns the loaded model and schedules dictation ahead of queued file jobs. */
export class TranscriptionService {
  private backend: ReusableBackend | undefined;
  private modelPath: string | undefined;
  private readonly dictationQueue: ReservationState[] = [];
  private readonly fileQueue: TranscriptionJob[] = [];
  private readonly reservationStates = new Set<ReservationState>();
  private reservation: ReservationState | undefined;
  private loop: Promise<void> | undefined;
  private shuttingDown = false;
  private readonly shutdownController = new AbortController();
  /** The language detector, loaded on demand like the transcription model. */
  private detector: ReusableBackend | undefined;
  private detectorLoading: Promise<ReusableBackend> | undefined;
  /** A missing detector warns on the first take only, not every take. */
  private missingDetectorWarned = false;

  constructor(
    private readonly createBackend: BackendFactory = async (modelPath) => {
      const { TranscribeCppBackend } = await import("./transcription.js");
      return new TranscribeCppBackend(modelPath);
    },
    /** Scores long clips for chunking; without it they decode in one piece. */
    private readonly scoreClip?: ClipScorer,
  ) {}

  reserveDictation(settings: TranscribeSettings): DictationReservation {
    if (this.shuttingDown) throw new Error("Pi Voice is shutting down");
    if (this.reservation) throw new Error("A dictation reservation is already active");

    const policy = settingsLanguagePolicy(settings);
    const state: ReservationState = {
      settings,
      policy,
      accepting: true,
      submitted: false,
      cancelled: false,
      started: false,
      ready: new Deferred(),
      submission: new Deferred(),
      result: new Deferred<Transcript>(),
      chunks: [],
      streamUnavailable: false,
    };
    // Cancellation can happen before callers attach handlers to either promise.
    void state.ready.promise.catch(() => undefined);
    void state.result.promise.catch(() => undefined);
    this.reservation = state;
    this.reservationStates.add(state);
    this.schedule();

    return {
      ready: state.ready.promise,
      feed: (chunk, probs) => {
        if (
          !state.accepting ||
          state.streamUnavailable ||
          state.streamError !== undefined ||
          chunk.length === 0
        ) return;
        state.chunks.push({ pcm: chunk, probs });
        this.startDrain(state);
      },
      submit: (pcm, signal) => {
        if (!state.accepting || state.submitted) {
          return Promise.reject(new Error("The dictation reservation is no longer active"));
        }
        state.accepting = false;
        state.submitted = true;
        state.fullPcm = pcm;
        if (this.reservation === state) this.reservation = undefined;
        if (!state.started) this.dictationQueue.push(state);
        state.signal = signal;
        if (signal) {
          const onAbort = (): void => this.abortReservation(state);
          signal.addEventListener("abort", onAbort, { once: true });
          state.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          if (signal.aborted) onAbort();
        }
        state.submission.resolve();
        this.schedule();
        return state.result.promise;
      },
      cancel: () => {
        if (!state.accepting || state.submitted) return;
        state.accepting = false;
        state.cancelled = true;
        state.chunks.length = 0;
        if (this.reservation === state) this.reservation = undefined;
        this.resetStream(state);
        state.ready.reject(cancellationError(state));
        state.submission.resolve();
        if (!state.started) this.reservationStates.delete(state);
        this.schedule();
      },
    };
  }

  transcribeFile(
    settings: TranscribeSettings,
    pcm: Float32Array,
    signal?: AbortSignal,
  ): Promise<Transcript> {
    if (this.shuttingDown) return Promise.reject(new Error("Pi Voice is shutting down"));
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const result = new Promise<Transcript>((resolve, reject) => {
      const job: TranscriptionJob = {
        settings,
        policy: settingsLanguagePolicy(settings),
        pcm,
        signal,
        resolve,
        reject,
        started: false,
        settled: false,
      };
      if (signal) {
        const onAbort = (): void => {
          if (job.started || job.settled) return;
          const index = this.fileQueue.indexOf(job);
          if (index >= 0) this.fileQueue.splice(index, 1);
          this.settleJob(job, () => reject(abortError(signal)));
          this.schedule();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        job.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      this.fileQueue.push(job);
    });
    this.schedule();
    return result;
  }

  private abortReservation(state: ReservationState): void {
    if (state.cancelled || state.result.settled) return;
    state.cancelled = true;
    state.accepting = false;
    state.chunks.length = 0;
    // Queue native reset before the scheduler can begin another model operation.
    this.resetStream(state);
    state.submission.resolve();

    // A submitted reservation waiting behind active work has no native state to
    // tear down, so preserve the old immediate-cancellation behavior.
    if (!state.started) {
      const index = this.dictationQueue.indexOf(state);
      if (index >= 0) this.dictationQueue.splice(index, 1);
      this.reservationStates.delete(state);
      state.removeAbortListener?.();
      const error = cancellationError(state);
      state.ready.reject(error);
      state.result.reject(error);
    }
  }

  private resetStream(state: ReservationState): void {
    const stream = state.stream;
    state.stream = undefined;
    stream?.reset();
  }

  private startDrain(state: ReservationState): void {
    if (
      !state.stream ||
      state.drain ||
      state.cancelled ||
      state.streamUnavailable ||
      state.streamError !== undefined ||
      state.chunks.length === 0
    ) {
      return;
    }

    const draining = this.drainStream(state).finally(() => {
      if (state.drain === draining) state.drain = undefined;
      this.startDrain(state);
    });
    state.drain = draining;
  }

  private async drainStream(state: ReservationState): Promise<void> {
    const stream = state.stream!;
    while (
      state.stream === stream &&
      !state.cancelled &&
      state.chunks.length > 0
    ) {
      const chunk = state.chunks.shift()!;
      try {
        await stream.feed(chunk.pcm, chunk.probs);
      } catch (error) {
        state.streamError = error;
        state.chunks.length = 0;
        // A batch fallback may only start after reset has been issued.
        this.resetStream(state);
        return;
      }
    }
  }

  private settleJob(job: TranscriptionJob, settle: () => void): void {
    if (job.settled) return;
    job.settled = true;
    job.removeAbortListener?.();
    settle();
  }

  private schedule(): void {
    if (this.loop) return;
    const loop = this.process().finally(() => {
      if (this.loop === loop) this.loop = undefined;
      if (this.hasRunnableWork()) this.schedule();
    });
    this.loop = loop;
  }

  private hasRunnableWork(): boolean {
    if (this.shuttingDown) return false;
    return (
      this.dictationQueue.length > 0 ||
      this.reservation !== undefined ||
      this.fileQueue.length > 0
    );
  }

  private async process(): Promise<void> {
    // Model work is non-preemptive. At each operation boundary, submitted
    // dictation and active recording reservations run before queued file jobs.
    // An active recording holds the model lane until submit or cancel.
    while (!this.shuttingDown) {
      const queuedDictation = this.dictationQueue.shift();
      if (queuedDictation) {
        queuedDictation.started = true;
        await this.runReservation(queuedDictation);
        continue;
      }

      const reservation = this.reservation;
      if (reservation) {
        reservation.started = true;
        await this.runReservation(reservation);
        if (this.reservation === reservation) this.reservation = undefined;
        continue;
      }

      const file = this.fileQueue.shift();
      if (file) {
        await this.runJob(file);
        continue;
      }

      await this.unloadAll();
      return;
    }
  }

  private async runReservation(state: ReservationState): Promise<void> {
    try {
      await this.runReservationWork(state);
    } finally {
      // A reset chunked stream may still be decoding: keep the model until it stops.
      await state.chunked?.stream.idle();
      state.removeAbortListener?.();
      this.reservationStates.delete(state);
    }
  }

  private settleCancelledReservation(state: ReservationState): void {
    this.resetStream(state);
    const error = cancellationError(state);
    state.ready.reject(error);
    if (state.submitted) state.result.reject(error);
  }

  private async runReservationWork(state: ReservationState): Promise<void> {
    if (state.cancelled) {
      this.settleCancelledReservation(state);
      return;
    }

    let backend: ReusableBackend;
    try {
      backend = await this.ensureModel(state.settings.model.path);
    } catch (error) {
      if (state.cancelled) {
        this.settleCancelledReservation(state);
        return;
      }
      state.streamUnavailable = true;
      state.chunks.length = 0;
      state.ready.reject(error);
      await state.submission.promise;
      if (state.submitted) state.result.reject(error);
      return;
    }

    if (state.cancelled) {
      this.settleCancelledReservation(state);
      return;
    }

    if (chunksTranscription(state.settings)) {
      // Only buffers until a chunk is due, so a take that already ended still uses it.
      const abort = new AbortController();
      const decoder = this.takeDecoder(backend, state.settings, state.policy, this.withShutdown(abort.signal));
      const stream = new ChunkedDictationStream(decoder.decode, () => abort.abort(cancellationError(state)));
      state.chunked = { stream, decoder };
      state.stream = stream;
    } else if (!state.submitted && !state.streamUnavailable && backend.startStream) {
      // If recording already ended while the model loaded (or while the stream
      // opened), avoid replaying the complete clip through a newly opened
      // stream and use the batch path.
      try {
        const stream = await backend.startStream(
          transcriptionOptions(state.settings, fixedLanguage(state.policy)),
        );
        if (stream && state.submitted) {
          stream.reset();
        } else {
          state.stream = stream;
        }
        if (!state.stream) {
          state.streamUnavailable = true;
          state.chunks.length = 0;
        }
      } catch (error) {
        // Stream setup is an optimization; preserve dictation via batch fallback.
        state.streamError = error;
        state.chunks.length = 0;
      }
    }

    if (state.cancelled) {
      this.settleCancelledReservation(state);
      return;
    }

    state.ready.resolve();
    this.startDrain(state);
    // Warm the detector while the user speaks; a failure resurfaces at detection.
    if (state.policy.kind === "detect") await this.ensureDetector().catch(() => undefined);
    await state.submission.promise;

    if (!state.submitted) {
      this.resetStream(state);
      return;
    }

    try {
      if (state.cancelled || state.signal?.aborted) throw cancellationError(state);

      this.startDrain(state);
      while (state.drain) await state.drain;

      if (state.cancelled || state.signal?.aborted) throw cancellationError(state);

      const pcm = state.fullPcm!;
      const stream = state.stream;
      // An empty clip takes the batch path so it fails exactly as it did before
      // streaming existed, instead of finalizing a stream that was never fed.
      if (stream && state.streamError === undefined && pcm.length > 0) {
        try {
          const text = await stream.finalize(pcm);
          state.signal?.throwIfAborted();
          const warning = state.chunked?.stream === stream ? state.chunked.decoder.warning : undefined;
          state.result.resolve(warning ? { text, warning } : { text });
          return;
        } catch (error) {
          if (state.signal?.aborted) throw abortError(state.signal);
          state.streamError = error;
        } finally {
          // Idempotent if finalize already released it. This must happen before
          // the reservation is released and file work is scheduled.
          if (state.stream === stream) state.stream = undefined;
          stream.reset();
        }
      }

      // Stream setup/feed/finalize failure: reset precedes the batch fallback,
      // and a live chunk still decoding must stop before the model is reused.
      await state.chunked?.stream.idle();
      this.resetStream(state);
      state.chunks.length = 0;
      state.result.resolve(await this.transcribeBatch(
        backend,
        state.settings,
        state.policy,
        pcm,
        this.withShutdown(state.signal),
      ));
    } catch (error) {
      this.resetStream(state);
      state.result.reject(
        state.signal?.aborted ? abortError(state.signal) : error,
      );
    }
  }

  private withShutdown(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
  }

  /** The single batch path shared by file jobs and the dictation fallback. */
  private async transcribeBatch(
    backend: ReusableBackend,
    settings: TranscribeSettings,
    policy: AutoLanguagePolicy,
    pcm: Float32Array,
    signal: AbortSignal,
  ): Promise<Transcript> {
    signal.throwIfAborted();
    const decoder = this.takeDecoder(backend, settings, policy, signal);
    let text: string;
    if (chunksTranscription(settings) && pcm.length > MAX_CHUNK_SAMPLES) {
      const transcriber = new ChunkedTranscriber(decoder.decode);
      transcriber.push(pcm, await this.scoreLongClip(pcm, signal));
      text = await transcriber.finish();
    } else {
      text = await decoder.decode(pcm, pcm);
    }
    const warning = decoder.warning;
    return warning ? { text, warning } : { text };
  }

  /** Scores for a clip too long for one chunk; undefined decodes it in one piece. */
  private async scoreLongClip(pcm: Float32Array, signal: AbortSignal): Promise<readonly number[] | undefined> {
    if (!this.scoreClip) {
      log.warn("no voice activity detection; decoding the clip in one piece");
      return undefined;
    }
    try {
      return await this.scoreClip(pcm, signal);
    } catch (error) {
      signal.throwIfAborted();
      log.warn(`voice activity detection failed, decoding the clip in one piece: ${describeError(error)}`);
      return undefined;
    }
  }

  /**
   * A decoder for one take or file: the first chunk chooses the language from
   * the start of the clip, and every chunk uses it.
   */
  private takeDecoder(
    backend: ReusableBackend,
    settings: TranscribeSettings,
    policy: AutoLanguagePolicy,
    signal: AbortSignal,
  ): TakeDecoder {
    let choice: Promise<{ language?: string; warning?: string }> | undefined;
    let warning: string | undefined;
    return {
      decode: async (chunk, clip) => {
        signal.throwIfAborted();
        const chosen = await (choice ??= this.chooseLanguage(settings, policy, clip, signal));
        warning = chosen.warning;
        signal.throwIfAborted();
        return backend.transcribe(chunk, transcriptionOptions(settings, chosen.language, signal));
      },
      get warning() { return warning; },
    };
  }

  private async chooseLanguage(
    settings: TranscribeSettings,
    policy: AutoLanguagePolicy,
    clip: Float32Array,
    signal: AbortSignal,
  ): Promise<{ language?: string; warning?: string }> {
    if (policy.kind === "detect" && !this.detector && !(await cachedDetectorPath())) {
      const language = policy.languages[0]!;
      const warning = this.missingDetectorWarned ? undefined : missingDetectorWarning(language);
      this.missingDetectorWarned = true;
      return { language, warning };
    }
    if (policy.kind === "detect") {
      return detectLanguage(policy, clip, async (head, allowed) =>
        (await this.ensureDetector()).identifyLanguage!(head, allowed, signal));
    }
    if (policy.kind === "unsupported") {
      // Settings normalization drops Auto first; this guards stale settings.
      const skipped = undetectablePreferences(getCatalogModel(settings.model.id)!, settings.preferredLanguages);
      const which = skipped.length ? ` (${skipped.map(displayLanguage).join(", ")})` : "";
      throw new Error(`Auto detect doesn't work with your current languages${which}. Choose a language in /voice-settings.`);
    }
    return { language: fixedLanguage(policy) };
  }

  private async runJob(job: TranscriptionJob): Promise<void> {
    if (job.settled) return;
    job.started = true;
    const signal = this.withShutdown(job.signal);

    try {
      signal.throwIfAborted();
      const backend = await this.ensureModel(job.settings.model.path);
      const transcript = await this.transcribeBatch(backend, job.settings, job.policy, job.pcm, signal);
      this.settleJob(job, () => job.resolve(transcript));
    } catch (error) {
      this.settleJob(job, () => job.reject(error));
    }
  }

  /** Concurrent callers (prewarm, a live chunk) share one load. */
  private ensureDetector(): Promise<ReusableBackend> {
    return (this.detectorLoading ??= (async () => {
      if (!this.detector) {
        const path = await cachedDetectorPath();
        if (!path) throw new Error("the language detector isn't downloaded");
        this.detector = await this.createBackend(path);
      }
      await this.detector.prepare();
      return this.detector;
    })().finally(() => { this.detectorLoading = undefined; }));
  }

  private async ensureModel(modelPath: string): Promise<ReusableBackend> {
    if (this.backend && this.modelPath === modelPath) {
      await this.backend.prepare();
      return this.backend;
    }

    await this.unloadModel();
    const backend = await this.createBackend(modelPath);
    this.backend = backend;
    this.modelPath = modelPath;
    try {
      await backend.prepare();
      return backend;
    } catch (error) {
      if (this.backend === backend) {
        this.backend = undefined;
        this.modelPath = undefined;
      }
      await backend.dispose().catch(() => undefined);
      // Keeps Hugging Face modules off the path until a load actually fails.
      const { explainLoadFailure } = await import("./models.js");
      throw explainLoadFailure(modelPath, error);
    }
  }

  private async unloadModel(): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    this.backend = undefined;
    this.modelPath = undefined;
    await backend.dispose();
  }

  /** Never rejects: a dispose failure would otherwise go unobserved. */
  private async unloadAll(): Promise<void> {
    const detector = this.detector;
    this.detector = undefined;
    await Promise.all([
      this.unloadModel().catch(() => undefined),
      detector?.dispose().catch(() => undefined),
    ]);
  }

  async shutdown(): Promise<void> {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.shutdownController.abort(new Error("Pi Voice is shutting down"));
      const shutdownError = new Error("Pi Voice is shutting down");
      this.reservation = undefined;
      this.dictationQueue.length = 0;
      for (const reservation of this.reservationStates) {
        reservation.accepting = false;
        reservation.cancelled = true;
        reservation.chunks.length = 0;
        this.resetStream(reservation);
        reservation.ready.reject(shutdownError);
        reservation.result.reject(shutdownError);
        reservation.submission.resolve();
      }
      for (const job of this.fileQueue) {
        this.settleJob(job, () => job.reject(shutdownError));
      }
      this.fileQueue.length = 0;
    }

    await this.loop?.catch(() => undefined);
    this.reservationStates.clear();
    await this.unloadAll();
  }
}
