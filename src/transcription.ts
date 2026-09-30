import type {
  Capabilities,
  Session,
  Stream,
  TranscribeModel,
} from "transcribe-cpp";
import { convertChineseOutput, isChineseLanguage } from "./chinese.js";
import { logLevel, writeLog, type LogLevel } from "./log.js";
import type { ChineseOutput } from "./settings.js";

export type TranscriptionOptions = {
  signal?: AbortSignal;
  language?: string;
  chineseOutput?: ChineseOutput;
};

export type DictationStream = {
  feed(chunk: Float32Array): Promise<void>;
  finalize(): Promise<string>;
  reset(): void;
};

function validateLanguage(
  capabilities: Pick<Capabilities, "languages">,
  language: string | undefined,
): void {
  if (language && !capabilities.languages.includes(language)) {
    throw new Error(
      `Configured language ${language} is not supported by this model. Open /voice-settings and choose another language.`,
    );
  }
}

/**
 * Shared final step for batch and streaming output: trim, then apply the
 * Chinese script preference when the detected (or configured) language is
 * Chinese. Keeping this in one place keeps the two paths from drifting.
 */
async function finishTranscript(
  text: string,
  detectedLanguage: string,
  configuredLanguage: string | undefined,
  chineseOutput: ChineseOutput,
): Promise<string> {
  const trimmed = text.trim();
  return isChineseLanguage(detectedLanguage || configuredLanguage || "")
    ? convertChineseOutput(trimmed, chineseOutput)
    : trimmed;
}

class TranscribeCppDictationStream implements DictationStream {
  private closed = false;

  constructor(
    private readonly session: Session,
    private readonly stream: Stream,
    private readonly language: string | undefined,
    private readonly chineseOutput: ChineseOutput,
  ) {}

  async feed(chunk: Float32Array): Promise<void> {
    if (this.closed) throw new Error("Dictation stream is closed");
    await this.stream.feed(chunk);
  }

  async finalize(): Promise<string> {
    if (this.closed) throw new Error("Dictation stream is closed");

    let text: string;
    let detectedLanguage: string;
    try {
      await this.stream.finalize();
      if (this.closed) {
        throw new Error("Dictation stream was reset while finalizing");
      }
      const snapshot = this.stream.snapshot;
      text = snapshot.text;
      detectedLanguage = snapshot.language;
    } finally {
      this.close();
    }

    return finishTranscript(text, detectedLanguage, this.language, this.chineseOutput);
  }

  reset(): void {
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    // reset() is synchronous at the binding boundary and queues native teardown
    // behind any in-flight feed/finalize before the session is freed.
    this.stream.reset();
    this.session.dispose();
  }
}

// transcribe-cpp's levels (TRANSCRIBE_LOG_LEVEL_*). Its info is a screenful
// of GPU setup on every model load, so it goes to debug.
const TRANSCRIBE_LEVELS: Record<number, LogLevel> = { 1: "debug", 2: "warn", 3: "error", 4: "debug" };
const TRANSCRIBE_CONTINUATION = 5;
let lastTranscribeLevel: LogLevel = "debug";

function routeTranscribeLog(setLogHandler: typeof import("transcribe-cpp").setLogHandler): void {
  if (!logLevel()) return;
  setLogHandler((level, message) => {
    if (level !== TRANSCRIBE_CONTINUATION) lastTranscribeLevel = TRANSCRIBE_LEVELS[level] ?? "debug";
    writeLog(lastTranscribeLevel, "transcribe", message);
  });
}

/** A reusable loaded transcribe.cpp model. Calls must be scheduled sequentially. */
export class TranscribeCppBackend {
  private model: TranscribeModel | undefined;
  private loading: Promise<TranscribeModel> | undefined;
  private disposed = false;

  constructor(private readonly modelPath: string) {}

  async prepare(): Promise<void> {
    if (this.model) return;
    if (this.disposed) throw new Error("Transcription backend has been disposed");

    if (!this.loading) {
      this.loading = import("transcribe-cpp")
        .then(({ TranscribeModel, setLogHandler }) => {
          routeTranscribeLog(setLogHandler);
          return TranscribeModel.load(this.modelPath);
        })
        .then((model) => {
          if (this.disposed) {
            model.dispose();
            throw new Error("Transcription backend was disposed while loading");
          }
          this.model = model;
          return model;
        });
    }

    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  async startStream(
    options: TranscriptionOptions = {},
  ): Promise<DictationStream | undefined> {
    await this.prepare();
    const model = this.model!;
    const capabilities = model.capabilities;
    validateLanguage(capabilities, options.language);
    if (!capabilities.supportsStreaming) return undefined;

    const session = model.createSession();
    try {
      const stream = await session.stream({
        timestamps: "none",
        ...(options.language ? { language: options.language } : {}),
      });
      return new TranscribeCppDictationStream(
        session,
        stream,
        options.language,
        options.chineseOutput ?? "simplified",
      );
    } catch (error) {
      session.dispose();
      throw error;
    }
  }

  async transcribe(
    pcm: Float32Array,
    options: TranscriptionOptions = {},
  ): Promise<string> {
    if (pcm.length === 0) throw new Error("No audio samples were provided");
    await this.prepare();
    const model = this.model!;
    validateLanguage(model.capabilities, options.language);

    const result = await model.transcribe(pcm, {
      signal: options.signal,
      timestamps: "none",
      ...(options.language ? { language: options.language } : {}),
    });
    return finishTranscript(
      result.text,
      result.language,
      options.language,
      options.chineseOutput ?? "simplified",
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.loading?.catch(() => undefined);
    this.model?.dispose();
    this.model = undefined;
  }
}
