import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";
import { AsyncLimiter } from "./async-limiter.js";
import { log } from "./log.js";
import type { TranscribeSettings } from "./settings.js";
import type { TranscriptionService } from "./transcription-service.js";

const CONTEXT_LINE_LENGTH = 1_000;
const MAX_FILE_OPERATIONS = 2;
const MAX_FILE_DECODERS = 1;

type FileTranscriptionDetails = {
  inputPath: string;
  modelId: string;
  seconds: number;
  truncation?: TruncationResult;
  fullTranscriptPath?: string;
  warning?: string;
};

type FileTranscriptionOptions = {
  getSettings: () => Promise<TranscribeSettings>;
  getService: () => Promise<TranscriptionService>;
  /** "deferred" keeps the tool out of the model's declared tools, callable from codemode. */
  exposure?: "direct" | "deferred";
};

export type FileTranscriptionController = {
  shutdown(): Promise<void>;
};

function normalizeToolPath(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

/** Wrap long model output lines so Pi's line-aware truncation can retain useful text. */
function wrapLongLines(text: string): string {
  const output: string[] = [];
  for (const originalLine of text.split("\n")) {
    let line = originalLine;
    while (line.length > CONTEXT_LINE_LENGTH) {
      let split = line.lastIndexOf(" ", CONTEXT_LINE_LENGTH);
      if (split <= 0) split = CONTEXT_LINE_LENGTH;
      output.push(line.slice(0, split));
      line = line.slice(split).trimStart();
    }
    output.push(line);
  }
  return output.join("\n");
}

async function saveFullTranscript(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-"));
  const path = join(directory, "transcript.txt");
  await writeFile(path, `${text}\n`, "utf8");
  return path;
}

function deactivateOnSessionStart(pi: ExtensionAPI): void {
  let warnedUnsupportedHost = false;
  pi.on("session_start", () => {
    const tool = pi.getAllTools().find((candidate) => candidate.name === "transcribe_file");
    if (!tool) return; // Excluded by the host (--tools, --exclude-tools): leave it alone.
    if (!("exposure" in tool) || tool.exposure !== "deferred") {
      if (!warnedUnsupportedHost) {
        log.warn(
          "toolExposure.transcribe_file=codemode needs Pi >= 0.99.2; this Pi does not support deferred tools, so transcribe_file stays a direct tool.",
        );
        warnedUnsupportedHost = true;
      }
      return;
    }
    // Reload and resume restore previously active tools, including this one.
    const active = pi.getActiveTools();
    if (active.includes("transcribe_file")) {
      pi.setActiveTools(active.filter((name) => name !== "transcribe_file"));
    }
  });
}

export function registerFileTranscriptionTool(
  pi: ExtensionAPI,
  options: FileTranscriptionOptions,
): FileTranscriptionController {
  let shuttingDown = false;
  const operations = new Set<Promise<unknown>>();
  const fileOperations = new AsyncLimiter(MAX_FILE_OPERATIONS);
  const fileDecoders = new AsyncLimiter(MAX_FILE_DECODERS);
  const shutdownController = new AbortController();

  function track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      operations.delete(tracked);
    });
    operations.add(tracked);
    return tracked;
  }

  const exposure: "direct" | "deferred" = options.exposure ?? "direct";
  if (exposure === "deferred") deactivateOnSessionStart(pi);

  pi.registerTool({
    ...{ exposure }, // Pi 0.83 types predate `exposure`; the spread keeps parameter inference.
    name: "transcribe_file",
    label: "Transcribe File",
    description: `Transcribe speech from a local audio or video file using Pi Voice's configured local model. Requires the ffmpeg executable on PATH (or PI_VOICE_FFMPEG_PATH). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; a complete transcript is saved to a temporary file when needed.`,
    promptSnippet: "Transcribe speech from local audio or video files with a local model",
    promptGuidelines: [
      "Use transcribe_file when speech in a local audio or video file needs to be read, analyzed, or transcribed.",
      "transcribe_file automatically queues model work, with interactive dictation taking priority over queued files.",
      "If transcribe_file reports that FFmpeg is unavailable, explain the installation guidance and ask the user before running a system package-manager command.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Local media file path, absolute or relative to the current working directory",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (shuttingDown) throw new Error("Pi Voice is shutting down");
      const operationSignal = signal
        ? AbortSignal.any([signal, shutdownController.signal])
        : shutdownController.signal;

      return track(
        (async () => {
          operationSignal.throwIfAborted();
          const input = normalizeToolPath(params.path.trim());
          if (!input) throw new Error("A media file path is required");
          const inputPath = resolve(ctx.cwd, input);
          const inputStat = await stat(inputPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") throw new Error(`Media file not found: ${inputPath}`);
            throw error;
          });
          if (!inputStat.isFile()) throw new Error(`Media path is not a regular file: ${inputPath}`);
          operationSignal.throwIfAborted();

          const configured = await options.getSettings();
          const service = await options.getService();
          if (fileOperations.saturated) {
            onUpdate?.({
              content: [{ type: "text", text: "Waiting for file transcription capacity…" }],
              details: { inputPath, modelId: configured.model.id, seconds: 0 },
            });
          }

          return fileOperations.run(async () => {
            if (fileDecoders.saturated) {
              onUpdate?.({
                content: [{ type: "text", text: `Waiting to decode ${basename(inputPath)}…` }],
                details: { inputPath, modelId: configured.model.id, seconds: 0 },
              });
            }
            const audio = await fileDecoders.run(async () => {
              onUpdate?.({
                content: [{ type: "text", text: `Decoding ${basename(inputPath)} with FFmpeg…` }],
                details: { inputPath, modelId: configured.model.id, seconds: 0 },
              });
              const { decodeFileAudio } = await import("./file-audio.js");
              return decodeFileAudio(inputPath, operationSignal);
            }, operationSignal);

            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Queued ${audio.seconds.toFixed(1)}s from ${basename(inputPath)} for local transcription…`,
                },
              ],
              details: {
                inputPath,
                modelId: configured.model.id,
                seconds: audio.seconds,
              },
            });
            const { text: transcript, warning } = await service.transcribeFile(
              configured,
              audio.pcm,
              operationSignal,
            );
            const details: FileTranscriptionDetails = {
              inputPath,
              modelId: configured.model.id,
              seconds: audio.seconds,
              ...(warning ? { warning } : {}),
            };
            const warningText = warning ? `\n\n[Language detection: ${warning}]` : "";

            if (!transcript) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `No speech detected in ${audio.seconds.toFixed(1)}s of audio from ${inputPath}${warningText}`,
                  },
                ],
                details,
              };
            }

            const contextTranscript =
              Buffer.byteLength(transcript, "utf8") > DEFAULT_MAX_BYTES
                ? wrapLongLines(transcript)
                : transcript;
            const truncation = truncateHead(contextTranscript, {
              maxLines: DEFAULT_MAX_LINES,
              maxBytes: DEFAULT_MAX_BYTES,
            });
            let resultText = truncation.content;
            if (truncation.truncated) {
              const fullTranscriptPath = await saveFullTranscript(transcript);
              details.truncation = truncation;
              details.fullTranscriptPath = fullTranscriptPath;
              resultText += `\n\n[Transcript truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full transcript saved to: ${fullTranscriptPath}]`;
            }

            return {
              content: [{ type: "text" as const, text: resultText + warningText }],
              details,
            };
          }, operationSignal);
        })(),
      );
    },
  });

  return {
    async shutdown() {
      shuttingDown = true;
      shutdownController.abort(new Error("Pi Voice is shutting down"));
      await Promise.allSettled([...operations]);
    },
  };
}
