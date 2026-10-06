import { Deferred } from "../src/deferred.js";
import type { Capture, CapturedAudio, CaptureSinks, OpenCapture } from "../src/dictation-controller.js";
import type { DictationReservation } from "../src/transcription-service.js";

/** One recording on a FakeMicrophone. */
export class FakeCapture implements Capture {
  stops = 0;
  stopError: Error | undefined;
  stopGate: Deferred<CapturedAudio> | undefined;
  pcm = new Float32Array(16000);
  constructor(private readonly sinks: CaptureSinks) {}
  feed(chunk: Float32Array): void { this.sinks.onAudio(chunk); }
  fail(error: Error): void { this.sinks.onFailure(error); }
  stop(): Promise<CapturedAudio> {
    this.stops++;
    if (this.stopError) return Promise.reject(this.stopError);
    return this.stopGate?.promise ?? Promise.resolve({ pcm: this.pcm });
  }
}

export class FakeMicrophone {
  readonly captures: FakeCapture[] = [];
  opens = 0;
  openError: Error | undefined;
  openGate: Deferred<void> | undefined;
  /** Delivered while opening, before open resolves, as a device may. */
  audioDuringOpen: Float32Array[] = [];
  readonly open: OpenCapture = async (_microphone, sinks) => {
    this.opens++;
    await this.openGate?.promise;
    if (this.openError) throw this.openError;
    for (const chunk of this.audioDuringOpen) sinks.onAudio(chunk);
    const capture = new FakeCapture(sinks);
    this.captures.push(capture);
    return capture;
  };
}

export class FakeReservation implements DictationReservation {
  readonly prepared = new Deferred();
  readonly ready = this.prepared.promise;
  readonly result = new Deferred<string>();
  readonly chunks: Float32Array[] = [];
  cancelled = 0;
  submissions = 0;
  pcm: Float32Array | undefined;
  signal: AbortSignal | undefined;
  feed(chunk: Float32Array): void { this.chunks.push(chunk); }
  submit(pcm: Float32Array, signal?: AbortSignal): Promise<string> {
    this.submissions++;
    this.pcm = pcm;
    this.signal = signal;
    return this.result.promise;
  }
  cancel(): void { if (!this.submissions) this.cancelled++; }
}

export function fakeDictationService() {
  const reservations: FakeReservation[] = [];
  return {
    reservations,
    reserveDictation() {
      const reservation = new FakeReservation();
      reservations.push(reservation);
      return reservation;
    },
  };
}
