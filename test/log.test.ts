import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { closeLog, initLog, log, logStep, watchEventLoop, writeLog } from "../src/log.js";

const dirs: string[] = [];
function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-voice-log-"));
  dirs.push(dir);
  return join(dir, "nested", "pi-voice.log");
}
const lines = (path: string) => readFileSync(path, "utf8").trimEnd().split("\n");

function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* Blocks the event loop. */ }
}

afterEach(() => {
  closeLog();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("lines carry time, pid, level, and source on one line; the level filters", () => {
  const path = logFile();
  initLog({ path, level: "info" });
  log.info("listening");
  log.debug("hidden at info");
  writeLog("warn", "recorder", "ring dropped 10 frames", Date.UTC(2026, 0, 2, 3, 4, 5, 6));
  log.error("failed:\nsecond line\n");
  initLog({ path, level: "debug" });
  logStep("opening microphone");
  const [header, info, native, error, step, ...rest] = lines(path);
  assert.match(header!, /pi-voice log opened \(.+, level info\)$/);
  assert.match(info!, new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z ${process.pid} info  voice      listening$`));
  assert.equal(native, `2026-01-02T03:04:05.006Z ${process.pid} warn  recorder   ring dropped 10 frames`);
  assert.match(error!, /error voice      failed: ⏎ second line$/);
  assert.match(step!, /debug voice      opening microphone$/);
  assert.deepEqual(rest, []);
});

test("the file rotates past 1 MiB, keeping one previous file", () => {
  const path = logFile();
  initLog({ path, level: "info" });
  const line = "x".repeat(1000);
  for (let i = 0; i < 1100; i++) log.info(line);
  assert.ok(existsSync(`${path}.1`));
  assert.ok(statSync(path).size < 1024 * 1024);
  assert.ok(statSync(`${path}.1`).size <= 1024 * 1024);
});

test("a log that can't be written is dropped quietly", () => {
  const path = logFile();
  mkdirSync(path, { recursive: true }); // A directory where the file should be.
  initLog({ path, level: "info" });
  assert.doesNotThrow(() => log.info("nowhere to go"));
  assert.doesNotThrow(() => log.info("still nowhere"));
});

test("a blocked event loop is reported with the steps around it, only while watched", async () => {
  const path = logFile();
  initLog({ path, level: "info" });
  busy(300); // Not watched.
  const release = watchEventLoop();
  logStep("reserving model");
  busy(400);
  logStep("opening microphone");
  await new Promise((resolve) => setTimeout(resolve, 80));
  logStep("transcribing");
  busy(400);
  release(); // Reports the block that ended just now, before the timer could run.
  const blocked = lines(path).filter((line) => line.includes("event loop blocked"));
  assert.equal(blocked.length, 2, lines(path).join("\n"));
  assert.match(blocked[0]!, /warn  voice      event loop blocked for \d+\.\d s across "idle" → "reserving model" → "opening microphone"$/);
  assert.match(blocked[1]!, /across "opening microphone" → "transcribing"$/);
});
