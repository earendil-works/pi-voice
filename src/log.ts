import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Pi Voice's diagnostic log (~/.pi/agent/pi-voice.log): always on at info, a
 * few lines per dictation; everything with PI_VOICE_DEBUG=1. It never holds
 * transcripts or audio.
 *
 * Lines are appended synchronously, so the ones before a freeze or a crash
 * are on disk. Nothing is written until `initLog`, so tests and tools that
 * import modules directly leave the log alone.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";
/** Who wrote the line: Pi Voice, or a native library through its log hook. */
export type LogSource = "voice" | "recorder" | "transcribe";

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
/** Past this the file moves to `.1`, replacing the previous one. */
const MAX_BYTES = 1024 * 1024;

type Sink = { path: string; level: LogLevel; bytes: number | undefined; failed: boolean };
let sink: Sink | undefined;

export function initLog(options: { path: string; level: LogLevel }): void {
  if (sink?.path === options.path) {
    sink.level = options.level;
    return;
  }
  sink = { path: options.path, level: options.level, bytes: undefined, failed: false };
}

/** Stops logging and the event-loop watch. */
export function closeLog(): void {
  sink = undefined;
  stopWatch();
  watchers = 0;
  step = "idle";
  keyPressedAt = undefined;
}

/** The level being written, or undefined when the log is off. */
export function logLevel(): LogLevel | undefined {
  return sink?.level;
}

export function logEnabled(level: LogLevel): boolean {
  return sink !== undefined && RANK[level] <= RANK[sink.level];
}

function append(sink: Sink, line: string): void {
  if (sink.bytes === undefined) {
    mkdirSync(dirname(sink.path), { recursive: true });
    try {
      sink.bytes = statSync(sink.path).size;
    } catch {
      sink.bytes = 0;
    }
    const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
    line = `${format("info", "voice", `pi-voice log opened (${runtime}, ${process.platform}-${process.arch}, level ${sink.level})`)}${line}`;
  }
  if (sink.bytes + line.length > MAX_BYTES && sink.bytes > 0) {
    renameSync(sink.path, `${sink.path}.1`);
    sink.bytes = 0;
  }
  appendFileSync(sink.path, line);
  sink.bytes += Buffer.byteLength(line);
}

function format(level: LogLevel, source: LogSource, message: string, timeMs = Date.now()): string {
  const time = new Date(timeMs).toISOString();
  return `${time} ${process.pid} ${level.padEnd(5)} ${source.padEnd(10)} ${message}\n`;
}

/** Writes one line. `timeMs` is when it happened, for native records that arrive late. */
export function writeLog(level: LogLevel, source: LogSource, message: string, timeMs?: number): void {
  if (!sink || sink.failed || !logEnabled(level)) return;
  try {
    append(sink, format(level, source, message.trimEnd().replaceAll("\n", " ⏎ "), timeMs));
  } catch {
    sink.failed = true; // A read-only or full disk must not break dictation.
  }
}

export const log = {
  error: (message: string) => writeLog("error", "voice", message),
  warn: (message: string) => writeLog("warn", "voice", message),
  info: (message: string) => writeLog("info", "voice", message),
  debug: (message: string) => writeLog("debug", "voice", message),
};

/** An error's message, with a `RecorderError`'s code when it has one. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { code } = error as Error & { code?: unknown };
  return typeof code === "string" ? `${code}: ${error.message}` : error.message;
}

// Steps: what Pi Voice is doing, so a blocked event loop can say where.

let step = "idle";

/** Marks what Pi Voice is doing now; logged at debug. */
export function logStep(name: string, detail?: string): void {
  step = name;
  if (timer) stepsSinceTick.push(name);
  log.debug(detail ? `${name}: ${detail}` : name);
}

let keyPressedAt: number | undefined;

/** The dictation shortcut was pressed; the next `sinceKeyPress` measures from here. */
export function markKeyPress(): void {
  keyPressedAt = performance.now();
}

/** Milliseconds since the last key press, once; undefined if none is pending. */
export function sinceKeyPress(): number | undefined {
  if (keyPressedAt === undefined) return undefined;
  const elapsed = performance.now() - keyPressedAt;
  keyPressedAt = undefined;
  return elapsed;
}

// The event-loop watch: a timer that notices when it ran late, while Pi Voice
// has work in flight. It can only report a block once the loop resumes, so it
// names every step entered since the last tick: the block is among them.

const TICK_MS = 50;
/** A frozen TUI starts to show at about this. */
const BLOCK_MS = 250;

let watchers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let lastTick = 0;
let stepsSinceTick = [step];

function tick(): void {
  const now = performance.now();
  const blocked = now - lastTick - TICK_MS;
  if (blocked >= BLOCK_MS) {
    const where = stepsSinceTick.length === 1
      ? `during "${step}"`
      : `across "${stepsSinceTick.join('" → "')}"`;
    const sleep = blocked >= 30_000 ? " (or the system slept)" : "";
    log.warn(`event loop blocked for ${(blocked / 1000).toFixed(1)} s ${where}${sleep}`);
  }
  lastTick = now;
  stepsSinceTick = [step];
}

function stopWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Watches the event loop until the returned release is called. Nested watches share one timer. */
export function watchEventLoop(): () => void {
  if (!sink) return () => {};
  if (watchers++ === 0) {
    lastTick = performance.now();
    stepsSinceTick = [step];
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
  }
  let released = false;
  return () => {
    if (released || watchers === 0) return;
    released = true;
    if (--watchers === 0) {
      tick(); // A block that ended just now, before the timer could run.
      stopWatch();
    }
  };
}
