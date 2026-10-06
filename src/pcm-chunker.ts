import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";

const STREAM_CHUNK_SAMPLES = CAPTURE_SAMPLE_RATE / 2;

/** Coalesces recorder chunks into fresh Float32 PCM chunks without timers. */
export class PcmChunker {
  private pieces: Float32Array[] = [];
  private sampleCount = 0;

  constructor(
    private readonly onChunk: (chunk: Float32Array) => void,
    private readonly targetSamples = STREAM_CHUNK_SAMPLES,
  ) {
    if (!Number.isInteger(targetSamples) || targetSamples <= 0) {
      throw new Error("PCM chunk size must be a positive integer");
    }
  }

  push(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.pieces.push(samples);
    this.sampleCount += samples.length;
    if (this.sampleCount >= this.targetSamples) this.emit();
  }

  flush(): void {
    if (this.sampleCount > 0) this.emit();
  }

  discard(): void {
    this.pieces = [];
    this.sampleCount = 0;
  }

  private emit(): void {
    const pcm = new Float32Array(this.sampleCount);
    let offset = 0;
    for (const piece of this.pieces) {
      pcm.set(piece, offset);
      offset += piece.length;
    }
    this.pieces = [];
    this.sampleCount = 0;
    this.onChunk(pcm);
  }
}
