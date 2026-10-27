import assert from "node:assert/strict";
import test from "node:test";
import type { TranscribeSettings } from "../src/settings.js";
import { TranscriptionService } from "../src/transcription-service.js";
import type {
  DictationStream,
  TranscriptionOptions,
} from "../src/transcription.js";
import { deferred, nextTurn } from "./helpers.js";

const text = async (transcript: Promise<{ text: string }>) => (await transcript).text;

// A streaming catalog model with native detection: takes use the backend stream, not chunking.
function settings(modelPath: string, modelId = "nemotron-3.5-asr-streaming-0.6b"): TranscribeSettings {
  return {
    version: 1,
    backend: { type: "transcribe-cpp" },
    shortcut: "ctrl+alt+z",
    preferredLanguages: ["en"],
    transcriptionLanguage: "auto",
    chineseOutput: "simplified",
    microphone: { type: "system-default" },
    voiceActivityDetection: true,
    longformChunking: true,
    transcribeFileExposure: "direct",
    model: { source: "catalog", id: modelId, path: modelPath },
  };
}

function pcm(id: number): Float32Array {
  return Float32Array.of(id);
}

type TestBackend = {
  prepare(): Promise<void>;
  startStream?(
    options?: TranscriptionOptions,
  ): Promise<DictationStream | undefined>;
  transcribe(
    samples: Float32Array,
    options?: TranscriptionOptions,
  ): Promise<string>;
  dispose(): Promise<void>;
};

function createTestService(
  overrides: Partial<TestBackend> = {},
): TranscriptionService {
  return new TranscriptionService(() => ({
    async prepare() {},
    async transcribe(samples) {
      return String(samples[0] ?? -1);
    },
    async dispose() {},
    ...overrides,
  }));
}

function createTestStream(
  overrides: Partial<DictationStream> = {},
): DictationStream {
  return {
    async feed() {},
    async finalize() {
      return "streamed";
    },
    reset() {},
    ...overrides,
  };
}

function createHarness(blockedIds: readonly number[] = []): {
  service: TranscriptionService;
  events: string[];
  release(id: number): void;
} {
  const events: string[] = [];
  const blocks = new Map(blockedIds.map((id) => [id, deferred()]));
  const service = new TranscriptionService((modelPath) => {
    events.push(`load:${modelPath}`);
    return {
      async prepare() {
        events.push(`prepare:${modelPath}`);
      },
      async transcribe(samples: Float32Array, options: TranscriptionOptions = {}) {
        const id = samples[0] ?? -1;
        events.push(`run:${id}`);
        await blocks.get(id)?.promise;
        options.signal?.throwIfAborted();
        events.push(`done:${id}`);
        return String(id);
      },
      async dispose() {
        events.push(`unload:${modelPath}`);
      },
    };
  });
  return {
    service,
    events,
    release(id) {
      blocks.get(id)?.resolve();
    },
  };
}

test("queued jobs sharing a model load it once", async () => {
  const harness = createHarness([1]);
  const first = text(harness.service.transcribeFile(settings("model-a"), pcm(1)));
  await nextTurn();
  const second = text(harness.service.transcribeFile(settings("model-a"), pcm(2)));

  harness.release(1);
  assert.deepEqual(await Promise.all([first, second]), ["1", "2"]);
  await nextTurn();

  assert.equal(harness.events.filter((event) => event === "load:model-a").length, 1);
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("run:")),
    ["run:1", "run:2"],
  );
  assert.equal(harness.events.at(-1), "unload:model-a");
  await harness.service.shutdown();
});

test("dictation reservation runs before queued file jobs", async () => {
  const harness = createHarness([1]);
  const activeFile = text(harness.service.transcribeFile(settings("model-a"), pcm(1)));
  await nextTurn();
  const queuedFile = text(harness.service.transcribeFile(settings("model-a"), pcm(2)));
  const reservation = harness.service.reserveDictation(settings("model-a"));

  harness.release(1);
  await reservation.ready;
  const dictation = text(reservation.submit(pcm(9)));
  assert.deepEqual(
    await Promise.all([activeFile, dictation, queuedFile]),
    ["1", "9", "2"],
  );
  await nextTurn();

  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("run:")),
    ["run:1", "run:9", "run:2"],
  );
  assert.equal(harness.events.filter((event) => event === "load:model-a").length, 1);
  assert.equal(harness.events.at(-1), "unload:model-a");
  await harness.service.shutdown();
});

test("cancelling a dictation reservation releases file work", async () => {
  const harness = createHarness();
  const reservation = harness.service.reserveDictation(settings("model-a"));
  await reservation.ready;
  const file = text(harness.service.transcribeFile(settings("model-a"), pcm(3)));
  await nextTurn();

  assert.equal(harness.events.includes("run:3"), false);
  reservation.cancel();
  assert.equal(await file, "3");
  await harness.service.shutdown();
});

test("a new reservation can be made after cancelling during model preparation", async () => {
  const prepareGate = deferred();
  const service = createTestService({
    async prepare() {
      await prepareGate.promise;
    },
  });

  const first = service.reserveDictation(settings("model-a"));
  first.cancel();
  let second!: ReturnType<TranscriptionService["reserveDictation"]>;
  assert.doesNotThrow(() => {
    second = service.reserveDictation(settings("model-a"));
  });

  prepareGate.resolve();
  second.cancel();
  await service.shutdown();
});

test("aborting a submission during model preparation releases its slot", async () => {
  const prepareGate = deferred();
  const service = createTestService({
    async prepare() {
      await prepareGate.promise;
    },
  });

  const controller = new AbortController();
  const first = service.reserveDictation(settings("model-a"));
  const result = text(first.submit(pcm(1), controller.signal));
  controller.abort(new Error("cancelled while loading"));
  let second!: ReturnType<TranscriptionService["reserveDictation"]>;
  assert.doesNotThrow(() => {
    second = service.reserveDictation(settings("model-a"));
  });

  prepareGate.resolve();
  await assert.rejects(result, /cancelled while loading/);
  second.cancel();
  await service.shutdown();
});

test("aborting an unstarted queued submission rejects immediately", async () => {
  const harness = createHarness([1]);
  const activeFile = text(harness.service.transcribeFile(settings("model-a"), pcm(1)));
  await nextTurn();

  const controller = new AbortController();
  const reservation = harness.service.reserveDictation(settings("model-a"));
  const result = text(reservation.submit(pcm(9), controller.signal));
  controller.abort(new Error("cancelled while queued"));

  let timeout: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    result.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), 100);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  assert.equal(settled, "rejected");
  await assert.rejects(result, /cancelled while queued/);

  harness.release(1);
  assert.equal(await activeFile, "1");
  assert.equal(harness.events.includes("run:9"), false);
  await harness.service.shutdown();
});

test("a submitted reservation is queued when a replacement is admitted", async () => {
  const harness = createHarness([1]);
  const activeFile = text(harness.service.transcribeFile(settings("model-a"), pcm(1)));
  await nextTurn();

  const first = harness.service.reserveDictation(settings("model-a"));
  const firstResult = text(first.submit(pcm(9)));
  let second!: ReturnType<TranscriptionService["reserveDictation"]>;
  assert.doesNotThrow(() => {
    second = harness.service.reserveDictation(settings("model-a"));
  });
  second.cancel();

  harness.release(1);
  assert.deepEqual(await Promise.all([activeFile, firstResult]), ["1", "9"]);
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("run:")),
    ["run:1", "run:9"],
  );
  await harness.service.shutdown();
});

test("a different model is unloaded and loaded at the queue boundary", async () => {
  const harness = createHarness([4]);
  const first = text(harness.service.transcribeFile(settings("model-a"), pcm(4)));
  await nextTurn();
  const second = text(harness.service.transcribeFile(settings("model-b"), pcm(5)));

  harness.release(4);
  await Promise.all([first, second]);
  await nextTurn();

  assert.ok(
    harness.events.indexOf("unload:model-a") < harness.events.indexOf("load:model-b"),
  );
  assert.equal(harness.events.filter((event) => event === "load:model-a").length, 1);
  assert.equal(harness.events.filter((event) => event === "load:model-b").length, 1);
  await harness.service.shutdown();
});

test("a stream releases the model before the next batch run", async () => {
  const events: string[] = [];
  let streamActive = false;
  const service = createTestService({
    async startStream() {
      assert.equal(streamActive, false);
      streamActive = true;
      events.push("stream:start");
      return createTestStream({
        async feed(samples) {
          events.push(`feed:${samples[0] ?? -1}`);
        },
        async finalize() {
          events.push("stream:finalize");
          streamActive = false;
          return "streamed";
        },
        reset() {
          if (streamActive) events.push("stream:reset");
          streamActive = false;
        },
      });
    },
    async transcribe(samples) {
      assert.equal(streamActive, false, "batch transcription started with an active stream");
      events.push(`batch:${samples[0] ?? -1}`);
      return String(samples[0] ?? -1);
    },
  });

  const reservation = service.reserveDictation(settings("model-a"));
  await reservation.ready;
  reservation.feed(pcm(7));
  const file = text(service.transcribeFile(settings("model-a"), pcm(3)));
  const dictation = text(reservation.submit(pcm(9)));

  assert.equal(await dictation, "streamed");
  assert.equal(await file, "3");
  assert.ok(events.indexOf("stream:finalize") < events.indexOf("batch:3"));
  await service.shutdown();
});

for (const failurePoint of ["feed", "finalize"] as const) {
  test(`a ${failurePoint} failure resets the stream before batch fallback`, async () => {
    const events: string[] = [];
    let streamActive = false;
    const service = createTestService({
      async startStream() {
        streamActive = true;
        return createTestStream({
          async feed() {
            if (failurePoint !== "feed") return;
            events.push("stream:feed-failed");
            throw new Error("stream feed failed");
          },
          async finalize() {
            if (failurePoint === "feed") {
              throw new Error("failed stream must not be finalized");
            }
            events.push("stream:finalize-failed");
            throw new Error("stream finalize failed");
          },
          reset() {
            events.push("stream:reset");
            streamActive = false;
          },
        });
      },
      async transcribe(samples) {
        assert.equal(streamActive, false, "fallback started before stream reset");
        events.push("batch:fallback");
        return `fallback:${samples[0] ?? -1}`;
      },
    });

    const reservation = service.reserveDictation(settings("model-a"));
    await reservation.ready;
    if (failurePoint === "feed") {
      reservation.feed(pcm(7));
      await nextTurn();
    }
    const result = await text(reservation.submit(pcm(9)));

    assert.equal(result, "fallback:9");
    assert.ok(events.indexOf("stream:reset") < events.indexOf("batch:fallback"));
    await service.shutdown();
  });
}

test("dictation submitted before model preparation uses the batch path", async () => {
  const prepareGate = deferred();
  let streamStarts = 0;
  const service = createTestService({
    async prepare() {
      await prepareGate.promise;
    },
    async startStream() {
      streamStarts += 1;
      throw new Error("a late stream must not be opened");
    },
  });

  const reservation = service.reserveDictation(settings("model-a"));
  const result = text(reservation.submit(pcm(9)));
  prepareGate.resolve();

  assert.equal(await result, "9");
  assert.equal(streamStarts, 0);
  await service.shutdown();
});

test("cancelling with an in-flight feed discards queued chunks and releases file work", async () => {
  const feedGate = deferred();
  const events: string[] = [];
  let streamActive = false;
  const service = createTestService({
    async startStream() {
      streamActive = true;
      return createTestStream({
        async feed(samples) {
          events.push(`feed:${samples[0] ?? -1}`);
          await feedGate.promise;
        },
        async finalize() {
          throw new Error("cancelled stream must not be finalized");
        },
        reset() {
          events.push("stream:reset");
          streamActive = false;
        },
      });
    },
    async transcribe(samples) {
      assert.equal(streamActive, false, "file work started before stream reset");
      events.push(`batch:${samples[0] ?? -1}`);
      return String(samples[0] ?? -1);
    },
  });

  const reservation = service.reserveDictation(settings("model-a"));
  await reservation.ready;
  reservation.feed(pcm(1));
  reservation.feed(pcm(2));
  await nextTurn();
  const file = text(service.transcribeFile(settings("model-a"), pcm(3)));
  reservation.cancel();

  assert.equal(await file, "3");
  feedGate.resolve();
  await nextTurn();
  assert.deepEqual(events.filter((event) => event.startsWith("feed:")), ["feed:1"]);
  assert.ok(events.indexOf("stream:reset") < events.indexOf("batch:3"));
  await service.shutdown();
});

test("a submission that lands while the stream opens uses the batch path", async () => {
  const streamGate = deferred();
  const events: string[] = [];
  const service = createTestService({
    async startStream() {
      events.push("stream:start");
      await streamGate.promise;
      return createTestStream({
        async feed() {
          throw new Error("a late stream must not be fed");
        },
        async finalize() {
          throw new Error("a late stream must not be finalized");
        },
        reset() {
          events.push("stream:reset");
        },
      });
    },
    async transcribe(samples) {
      events.push(`batch:${samples[0] ?? -1}`);
      return String(samples[0] ?? -1);
    },
  });

  const reservation = service.reserveDictation(settings("model-a"));
  await nextTurn();
  assert.deepEqual(events, ["stream:start"]);
  reservation.feed(pcm(7));
  const result = text(reservation.submit(pcm(9)));
  streamGate.resolve();

  assert.equal(await result, "9");
  assert.deepEqual(events, ["stream:start", "stream:reset", "batch:9"]);
  await service.shutdown();
});

test("an empty recording never reaches stream finalize", async () => {
  const events: string[] = [];
  const service = createTestService({
    async startStream() {
      events.push("stream:start");
      return createTestStream({
        async finalize() {
          throw new Error("an unfed stream must not be finalized");
        },
        reset() {
          events.push("stream:reset");
        },
      });
    },
    async transcribe(samples) {
      events.push(`batch:${samples.length}`);
      if (samples.length === 0) throw new Error("No audio samples were provided");
      return "text";
    },
  });

  const reservation = service.reserveDictation(settings("model-a"));
  await reservation.ready;
  await assert.rejects(text(reservation.submit(new Float32Array(0))), /No audio samples/);
  assert.deepEqual(events, ["stream:start", "stream:reset", "batch:0"]);
  await service.shutdown();
});
