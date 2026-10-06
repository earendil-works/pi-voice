import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController, type DictationState } from "../src/dictation-controller.js";
import { Deferred } from "../src/deferred.js";
import { settingsForModel } from "../src/settings.js";
import { TranscriptionService } from "../src/transcription-service.js";
import { FakeMicrophone, fakeDictationService } from "./dictation-helper.js";
import { nextTurn } from "./helpers.js";

const settings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/test-model");

function harness() {
  const service = fakeDictationService();
  const mic = new FakeMicrophone();
  const states: DictationState[] = [];
  let now = 0;
  const controller = new DictationController(service, {
    openCapture: mic.open,
    now: () => now,
    onChange: (state) => states.push(state),
  });
  return { controller, service, mic, captures: mic.captures, states, time: (value: number) => { now = value; } };
}

test("prewarming, streaming chunks, final tail and timing have one lifecycle", async () => {
  const h = harness();
  h.controller.prepare(settings);
  const reservation = h.service.reservations[0]!;
  assert.equal(h.captures.length, 0);
  reservation.prepared.resolve();
  await nextTurn();
  assert.equal(h.controller.modelState, "ready");
  await h.controller.start(settings);
  assert.equal(h.service.reservations.length, 1);
  const capture = h.captures[0]!;
  capture.feed(new Float32Array(8000).fill(0.1));
  capture.feed(new Float32Array(512).fill(0.2));
  assert.equal(reservation.chunks.length, 1);
  h.time(60000); // Wall-clock recording time must not be reported as PCM duration.
  const submission = h.controller.stop();
  assert.equal(h.controller.stop(), submission);
  await nextTurn();
  assert.deepEqual(reservation.chunks.map((chunk) => chunk.length), [8000, 512]);
  assert.equal(reservation.pcm, capture.pcm);
  h.time(61500);
  reservation.result.resolve("hello");
  assert.deepEqual(await submission, { text: "hello", speechSeconds: 1, transcribeSeconds: 1.5 });
  assert.equal(capture.stops, 1);
  assert.equal(h.controller.state.phase, "result");
  await h.controller.dispose();
});

test("duplicate starts cannot open two microphones", async () => {
  const h = harness();
  await Promise.all([h.controller.start(settings), h.controller.start(settings)]);
  assert.equal(h.captures.length, 1);
  assert.equal(h.service.reservations.length, 1);
  await h.controller.dispose();
});

test("capture cancellation discards the tail and waits for native teardown", async () => {
  const h = harness();
  await h.controller.start(settings);
  const capture = h.captures[0]!;
  capture.stopGate = new Deferred();
  capture.feed(new Float32Array(512));
  const cancelling = h.controller.cancel();
  assert.equal(h.controller.state.phase, "cancelling");
  await h.controller.start(settings);
  assert.equal(h.captures.length, 1);
  capture.feed(new Float32Array(8000)); // Late audio from the stopping device.
  assert.equal(h.service.reservations[0]!.chunks.length, 0);
  capture.stopGate.resolve({ pcm: capture.pcm });
  await cancelling;
  assert.equal(h.controller.state.phase, "idle");
  await h.controller.start(settings);
  assert.equal(h.captures.length, 2);
  assert.equal(h.service.reservations[0]!.submissions, 0);
  await h.controller.dispose();
});

test("cancelling while stop is pending never submits the discarded recording", async () => {
  const h = harness();
  await h.controller.start(settings);
  h.captures[0]!.stopGate = new Deferred();
  const submission = h.controller.stop();
  const cancelling = h.controller.cancel();
  h.captures[0]!.stopGate.resolve({ pcm: new Float32Array(16000) });
  assert.equal(await submission, undefined);
  await cancelling;
  assert.equal(h.service.reservations[0]!.submissions, 0);
  assert.equal(h.captures[0]!.stops, 1);
  await h.controller.dispose();
});

test("a cancelled transcription cannot publish a late successful result", async () => {
  const h = harness();
  await h.controller.start(settings);
  const submission = h.controller.stop();
  await nextTurn();
  const reservation = h.service.reservations[0]!;
  const cancelling = h.controller.cancel();
  assert.equal(reservation.signal?.aborted, true);
  reservation.result.resolve("late text");
  assert.equal(await submission, undefined);
  await cancelling;
  assert.equal(h.states.some((state) => state.phase === "result"), false);
  await h.controller.dispose();
});

test("model preparation failure is retryable and stale readiness is ignored", async () => {
  const h = harness();
  h.controller.prepare(settings);
  h.service.reservations[0]!.prepared.reject(new Error("load failed"));
  await nextTurn();
  assert.equal(h.controller.state.phase, "error");
  await h.controller.start(settings);
  assert.equal(h.service.reservations[0]!.cancelled, 1);
  assert.equal(h.service.reservations.length, 2);
  assert.equal(h.controller.state.phase, "listening");
  await h.controller.cancel();
  const paints = h.states.length;
  h.service.reservations[1]!.prepared.resolve();
  await nextTurn();
  assert.equal(h.states.length, paints);
  await h.controller.dispose();
});

for (const failure of ["start", "stop"] as const) {
  test(`microphone ${failure} failure releases the reservation and allows retry`, async () => {
    const service = fakeDictationService();
    const mic = new FakeMicrophone();
    if (failure === "start") mic.openError = new Error("permission denied");
    const controller = new DictationController(service, { openCapture: mic.open });
    await controller.start(settings);
    if (failure === "stop") {
      mic.captures[0]!.stopError = new Error("device disconnected");
      await controller.stop();
    }
    assert.equal(controller.state.phase, "error");
    // A microphone that never opened never reserved the model.
    if (failure === "start") assert.equal(service.reservations.length, 0);
    else assert.equal(service.reservations[0]!.cancelled, 1);
    mic.openError = undefined;
    await controller.start(settings);
    assert.equal(controller.state.phase, "listening");
    await controller.dispose();
  });
}

test("disposal is idempotent and silences pending preparation and capture callbacks", async () => {
  const h = harness();
  await h.controller.start(settings);
  await Promise.all([h.controller.dispose(), h.controller.dispose()]);
  const before = h.states.length;
  h.service.reservations[0]!.prepared.resolve();
  h.captures[0]!.feed(new Float32Array(8000));
  await h.controller.start(settings);
  await nextTurn();
  assert.equal(h.controller.state.phase, "disposed");
  assert.equal(h.states.length, before);
  assert.equal(h.captures[0]!.stops, 1);
  assert.equal(h.service.reservations[0]!.chunks.length, 0);
});

test("disposal before microphone startup never opens a device", async () => {
  const h = harness();
  const starting = h.controller.start(settings);
  await h.controller.dispose();
  await starting;
  assert.equal(h.mic.opens, 0);
});

test("controller disposal resets streams and leaves the injected service usable", async () => {
  let resets = 0;
  const service = new TranscriptionService(() => ({
    async prepare() {},
    async startStream() {
      return { async feed() {}, async finalize() { return "streamed"; }, reset() { resets++; } };
    },
    async transcribe() { return "file text"; },
    async dispose() {},
  }));
  const controller = new DictationController(service, { openCapture: new FakeMicrophone().open });
  controller.prepare(settings);
  await nextTurn();
  await controller.start(settings);
  await controller.dispose();
  assert.ok(resets > 0);
  assert.equal(await service.transcribeFile(settings, Float32Array.of(1)), "file text");
  await service.shutdown();
});

test("display failures do not interrupt feeding, submission, or cleanup", async () => {
  const service = fakeDictationService();
  const mic = new FakeMicrophone();
  const controller = new DictationController(service, {
    openCapture: mic.open,
    onChange: () => { throw new Error("render failed"); },
    onAudio: () => { throw new Error("meter failed"); },
  });
  await controller.start(settings);
  mic.captures[0]!.feed(new Float32Array(8000));
  assert.equal(service.reservations[0]!.chunks.length, 1);
  const submission = controller.stop();
  service.reservations[0]!.result.resolve("still works");
  assert.equal((await submission)?.text, "still works");
  await controller.dispose();
});

test("audio delivered while the device stops still reaches the stream tail", async () => {
  const h = harness();
  await h.controller.start(settings);
  const capture = h.captures[0]!;
  capture.stopGate = new Deferred();
  const submission = h.controller.stop();
  capture.feed(new Float32Array(300));
  capture.stopGate.resolve({ pcm: capture.pcm });
  await nextTurn();
  assert.deepEqual(h.service.reservations[0]!.chunks.map((chunk) => chunk.length), [300]);
  h.service.reservations[0]!.result.resolve("tail");
  assert.equal((await submission)?.text, "tail");
  await h.controller.dispose();
});

for (const teardown of ["cancel", "dispose"] as const) {
  test(`${teardown} while the microphone opens releases it and never submits`, async () => {
    const h = harness();
    h.mic.openGate = new Deferred();
    const starting = h.controller.start(settings);
    await nextTurn();
    assert.equal(h.mic.opens, 1);
    const tearingDown = teardown === "cancel" ? h.controller.cancel() : h.controller.dispose();
    let settled = false;
    void tearingDown.then(() => { settled = true; });
    await nextTurn();
    assert.equal(settled, false, "teardown must wait for the opening device");
    h.mic.openGate.resolve();
    await Promise.all([starting, tearingDown]);
    assert.equal(h.captures[0]!.stops, 1);
    assert.equal(h.service.reservations.length, 0, "the model is reserved only once listening");
    assert.equal(h.controller.state.phase, teardown === "cancel" ? "idle" : "disposed");
    await h.controller.dispose();
  });
}

test("a microphone failure keeps the audio before it and reports the interruption", async () => {
  const h = harness();
  await h.controller.start(settings);
  const capture = h.captures[0]!;
  const lost = new Error("device lost");
  const paints = h.states.length;
  capture.fail(lost);
  assert.equal(h.controller.interruption, lost);
  assert.equal(h.states.length, paints + 1);
  assert.equal(h.controller.state.phase, "listening");
  capture.stopGate = new Deferred();
  const submission = h.controller.stop();
  capture.stopGate.resolve({ pcm: new Float32Array(8000), interruption: lost });
  await nextTurn();
  h.service.reservations[0]!.result.resolve("partial");
  assert.deepEqual(await submission, { text: "partial", speechSeconds: 0.5, transcribeSeconds: 0, interruption: lost });
  await h.controller.dispose();
});

test("a microphone that fails before capturing anything is a capture error", async () => {
  const h = harness();
  await h.controller.start(settings);
  const capture = h.captures[0]!;
  const lost = new Error("device lost");
  capture.stopGate = new Deferred();
  const submission = h.controller.stop();
  capture.stopGate.resolve({ pcm: new Float32Array(), interruption: lost });
  assert.equal(await submission, undefined);
  assert.deepEqual(h.controller.state, { phase: "error", stage: "capture", cause: lost });
  assert.equal(h.service.reservations[0]!.submissions, 0);
  assert.equal(h.service.reservations[0]!.cancelled, 1);
  await h.controller.dispose();
});

test("without prewarming, the model is reserved once the microphone is listening", async () => {
  const h = harness();
  h.mic.openGate = new Deferred();
  const starting = h.controller.start(settings);
  await nextTurn();
  assert.equal(h.mic.opens, 1);
  assert.equal(h.service.reservations.length, 0, "no model work while the microphone opens");
  h.mic.openGate.resolve();
  await starting;
  assert.equal(h.service.reservations.length, 1);
  assert.equal(h.controller.state.phase, "listening");
  await h.controller.dispose();
});

test("a prewarmed take keeps its reservation, and cancelling while opening releases both", async () => {
  const h = harness();
  h.controller.prepare(settings);
  h.mic.openGate = new Deferred();
  const starting = h.controller.start(settings);
  await nextTurn();
  assert.equal(h.service.reservations.length, 1);
  const cancelling = h.controller.cancel();
  h.mic.openGate.resolve();
  await Promise.all([starting, cancelling]);
  assert.equal(h.service.reservations[0]!.cancelled, 1);
  assert.equal(h.captures[0]!.stops, 1);
  assert.equal(h.controller.state.phase, "idle");
  await h.controller.dispose();
});

test("audio that arrives while the microphone opens reaches the stream first, in order", async () => {
  const h = harness();
  h.mic.audioDuringOpen = [new Float32Array(4000).fill(0.1), new Float32Array(4000).fill(0.2)];
  await h.controller.start(settings);
  h.captures[0]!.feed(new Float32Array(8000).fill(0.3));
  const chunks = h.service.reservations[0]!.chunks;
  assert.deepEqual(chunks.map((chunk) => [chunk.length, chunk[0], chunk[7999]]), [
    [8000, Float32Array.of(0.1)[0], Float32Array.of(0.2)[0]],
    [8000, Float32Array.of(0.3)[0], Float32Array.of(0.3)[0]],
  ]);
  await h.controller.dispose();
});

test("a model that can't be reserved after the microphone opened releases the microphone", async () => {
  const mic = new FakeMicrophone();
  const lane = new Error("A dictation reservation is already active");
  const controller = new DictationController(
    { reserveDictation: () => { throw lane; } },
    { openCapture: mic.open },
  );
  await controller.start(settings);
  assert.deepEqual(controller.state, { phase: "error", stage: "model", cause: lane });
  assert.equal(mic.captures[0]!.stops, 1);
  await controller.dispose();
});
