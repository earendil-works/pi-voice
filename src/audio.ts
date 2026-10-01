import type { PvRecorder } from "@picovoice/pvrecorder-node";
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import type { DictationCapture } from "./dictation-controller.js";
import { convertFrames } from "./pcm.js";
import type { MicrophoneSetting } from "./settings.js";

export { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";

const FRAME_LENGTH = 512;

const execFileAsync = promisify(execFile);
const requireModule = createRequire(import.meta.url);

// PvRecorder's native binding throws at load time on unsupported platforms
// (e.g. Android), so load it on first use rather than at import.
function loadPvRecorder(): typeof PvRecorder {
  return (requireModule("@picovoice/pvrecorder-node") as typeof import("@picovoice/pvrecorder-node")).PvRecorder;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CapturedAudio {
  pcm: Float32Array;
}

type SelectedMicrophone = {
  name: string;
  occurrence: number;
};

export class MicrophoneUnavailableError extends Error {
  constructor(name: string) {
    super(`Selected microphone is unavailable: ${name}. Open /voice-settings and choose another microphone.`);
    this.name = "MicrophoneUnavailableError";
  }
}

export function getAvailableMicrophones(): string[] {
  return loadPvRecorder().getAvailableDevices();
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

type MicPermissionResult =
  | { status: "granted" }
  | { status: "denied"; message: string }
  | { status: "not-determined"; message: string }
  | { status: "error"; message: string };

const JXA_PERMISSION_SCRIPT = [
  "-l",
  "JavaScript",
  "-e",
  [
    "ObjC.import('Foundation');",
    "ObjC.import('AVFoundation');",
    "var captureDevice = $.NSClassFromString('AVCaptureDevice');",
    "if (!captureDevice) throw new Error('AVCaptureDevice is unavailable');",
    "var status = captureDevice.authorizationStatusForMediaType($.AVMediaTypeAudio);",
    "status.toString();",
  ].join("\n"),
];

const MACOS_PERMISSION_STATUS = {
  NOT_DETERMINED: 0,
  RESTRICTED: 1,
  DENIED: 2,
  AUTHORIZED: 3,
} as const;

export async function testMicrophonePermission(): Promise<MicPermissionResult> {
  if (process.platform !== "darwin") return { status: "granted" };

  try {
    const { stdout } = await execFileAsync("osascript", JXA_PERMISSION_SCRIPT, {
      timeout: 5000,
    });
    const code = parseInt(stdout.trim(), 10);

    switch (code) {
      case MACOS_PERMISSION_STATUS.AUTHORIZED:
        return { status: "granted" };
      case MACOS_PERMISSION_STATUS.DENIED:
        return { status: "denied", message: "Microphone access denied in System Settings" };
      case MACOS_PERMISSION_STATUS.RESTRICTED:
        return { status: "denied", message: "Microphone access restricted by system policy" };
      case MACOS_PERMISSION_STATUS.NOT_DETERMINED:
        return { status: "not-determined", message: "Microphone access not yet requested" };
      default:
        return { status: "error", message: `Unknown mic permission status code: ${code}` };
    }
  } catch (error) {
    return {
      status: "error",
      message: `Could not check mic permission: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function findDeviceIndex(devices: readonly string[], selected: SelectedMicrophone): number {
  let occurrence = 0;
  for (let index = 0; index < devices.length; index += 1) {
    if (devices[index] !== selected.name) continue;
    if (occurrence === selected.occurrence) return index;
    occurrence += 1;
  }
  return -1;
}

export function createMicrophoneCapture(microphone: MicrophoneSetting): DictationCapture {
  if (process.platform === "android") {
    return hasCommand("parecord") ? new PulseAudioCapture() : new TermuxApiCapture();
  }
  return new MicrophoneCapture(microphone.type === "device" ? microphone : undefined);
}

function hasCommand(command: string): boolean {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => dir !== "" && fs.existsSync(path.join(dir, command)));
}

function hasPulseAudioSource(): boolean {
  try {
    return execFileSync("pactl", ["list", "sources", "short"], { encoding: "utf8", timeout: 5000 }).includes("_source");
  } catch {
    return false;
  }
}

function ensurePulseAudioSource(): void {
  try {
    execFileSync("pactl", ["info"], { stdio: "ignore", timeout: 3000 });
  } catch {
    try {
      execFileSync("pulseaudio", ["--start"], { stdio: "ignore", timeout: 10_000 });
    } catch (error) {
      throw new Error(`Could not start PulseAudio: ${toError(error).message}`);
    }
  }

  // module-sles-source exposes the Android microphone. Loading it again while a
  // source exists adds a competing instance, so only load it when none exists.
  if (!hasPulseAudioSource()) {
    try {
      execFileSync("pactl", ["load-module", "module-sles-source"], { stdio: "ignore", timeout: 5000 });
    } catch {
      // Reported below.
    }
  }
  if (!hasPulseAudioSource()) {
    throw new Error(
      "No PulseAudio microphone source. Check that module-sles-source loads and Termux has microphone permission.",
    );
  }
}

/** Android capture streamed from Termux PulseAudio via parecord. */
class PulseAudioCapture implements DictationCapture {
  private child: ChildProcess | undefined;
  private frames: Int16Array[] = [];
  private pending: Buffer = Buffer.alloc(0);
  private exitError: Error | undefined;
  onFrame?: (frame: Int16Array) => void;

  start(): void {
    if (this.child) throw new Error("Microphone capture is already active");
    ensurePulseAudioSource();

    const child = spawn(
      "parecord",
      ["--raw", "--format=s16le", `--rate=${CAPTURE_SAMPLE_RATE}`, "--channels=1"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.child = child;
    this.frames = [];
    this.pending = Buffer.alloc(0);
    this.exitError = undefined;

    child.stdout?.on("data", (chunk: Buffer) => this.handleData(chunk));
    child.on("error", (error) => {
      this.exitError ??= error;
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.exitError ??= new Error(`parecord exited unexpectedly (${signal ?? `code ${code}`})`);
      }
    });
  }

  async stop(): Promise<CapturedAudio> {
    const child = this.child;
    if (!child) throw new Error("Microphone capture is not active");
    this.child = undefined;

    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([closed, sleep(300)]);
    }
    child.stdout?.destroy();

    if (this.exitError) throw this.exitError;
    const tailSamples = Math.floor(this.pending.length / 2);
    if (tailSamples > 0) this.frames.push(toInt16(this.pending, 0, tailSamples));
    this.pending = Buffer.alloc(0);
    return { pcm: convertFrames(this.frames) };
  }

  private handleData(chunk: Buffer): void {
    const data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    const frameBytes = FRAME_LENGTH * 2;
    let offset = 0;
    for (; offset + frameBytes <= data.length; offset += frameBytes) {
      const frame = toInt16(data, offset, FRAME_LENGTH);
      this.frames.push(frame);
      try {
        this.onFrame?.(frame);
      } catch {
        // Visualizer updates must not fail the recording.
      }
    }
    this.pending = data.subarray(offset);
  }
}

function toInt16(data: Buffer, offset: number, samples: number): Int16Array {
  const frame = new Int16Array(samples);
  for (let index = 0; index < samples; index += 1) {
    frame[index] = data.readInt16LE(offset + index * 2);
  }
  return frame;
}

/**
 * Android fallback when PulseAudio is not installed: records to a file with
 * Termux:API and decodes it with ffmpeg on stop. Emits no live frames.
 */
class TermuxApiCapture implements DictationCapture {
  private filePath: string | undefined;
  onFrame?: (frame: Int16Array) => void;

  start(): void {
    if (this.filePath) throw new Error("Microphone capture is already active");
    const filePath = path.join(os.tmpdir(), `pi-voice-${process.pid}-${Date.now()}.wav`);
    try {
      execFileSync(
        "termux-microphone-record",
        ["-f", filePath, "-r", String(CAPTURE_SAMPLE_RATE), "-c", "1"],
        { timeout: 10_000 },
      );
    } catch (error) {
      throw new Error(`Could not start Termux:API microphone recording: ${toError(error).message}`);
    }
    this.filePath = filePath;
  }

  async stop(): Promise<CapturedAudio> {
    const filePath = this.filePath;
    if (!filePath) throw new Error("Microphone capture is not active");
    this.filePath = undefined;

    try {
      try {
        execFileSync("termux-microphone-record", ["-q"], { timeout: 10_000 });
      } catch {
        // The recording may already have ended on its own.
      }
      for (let attempt = 0; attempt < 20 && !fs.existsSync(filePath); attempt += 1) {
        await sleep(50);
      }
      if (!fs.existsSync(filePath)) throw new Error("Termux:API recording file was not created");

      const { stdout } = await execFileAsync(
        "ffmpeg",
        ["-loglevel", "error", "-i", filePath, "-f", "f32le", "-ar", String(CAPTURE_SAMPLE_RATE), "-ac", "1", "pipe:1"],
        { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
      );
      // Copy out of the Buffer pool, whose offset may not be 4-byte aligned.
      const bytes = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength);
      return { pcm: new Float32Array(bytes) };
    } finally {
      await fs.promises.rm(filePath, { force: true });
    }
  }
}

export class MicrophoneCapture {
  private recorder: PvRecorder | undefined;
  private frames: Int16Array[] = [];
  private readLoop: Promise<void> | undefined;
  private stopping = false;
  private readError: Error | undefined;
  onFrame?: (frame: Int16Array) => void;

  constructor(private readonly selectedDevice?: SelectedMicrophone) {}

  start(): void {
    if (this.recorder) throw new Error("Microphone capture is already active");

    const deviceIndex = this.selectedDevice
      ? findDeviceIndex(getAvailableMicrophones(), this.selectedDevice)
      : -1;
    if (this.selectedDevice && deviceIndex < 0) {
      throw new MicrophoneUnavailableError(this.selectedDevice.name);
    }

    // PvRecorder asks the native device for 16 kHz mono Int16 PCM. Its miniaudio
    // layer performs any device-rate resampling and channel conversion.
    const recorder = new (loadPvRecorder())(FRAME_LENGTH, deviceIndex);

    try {
      if (recorder.sampleRate !== CAPTURE_SAMPLE_RATE) {
        throw new Error(
          `PvRecorder reported ${recorder.sampleRate} Hz; expected ${CAPTURE_SAMPLE_RATE} Hz`,
        );
      }

      this.frames = [];
      this.stopping = false;
      this.readError = undefined;
      recorder.start();
      this.recorder = recorder;
      this.readLoop = this.readFrames(recorder);
    } catch (error) {
      recorder.release();
      throw error;
    }
  }

  async stop(): Promise<CapturedAudio> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("Microphone capture is not active");

    this.stopping = true;
    let stopError: Error | undefined;

    try {
      if (recorder.isRecording) recorder.stop();
    } catch (error) {
      stopError = toError(error);
    }

    try {
      await this.readLoop;
    } finally {
      recorder.release();
      this.recorder = undefined;
      this.readLoop = undefined;
    }

    if (stopError) throw stopError;
    if (this.readError) throw this.readError;
    return { pcm: convertFrames(this.frames) };
  }

  private async readFrames(recorder: PvRecorder): Promise<void> {
    try {
      while (!this.stopping && recorder.isRecording) {
        const frame = await recorder.read();
        if (this.stopping) continue;
        this.frames.push(frame);
        try {
          this.onFrame?.(frame);
        } catch {
          // Visualizer updates must not fail the recording.
        }
      }
    } catch (error) {
      if (!this.stopping) this.readError = toError(error);
    }
  }
}
