import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { LangIdResult } from "transcribe-cpp";
import { CATALOG_MODELS, LANGUAGE_DETECTION_MODEL } from "../src/catalog.js";
import { Deferred } from "../src/deferred.js";
import { settingsForModel, settingsWithPreferredLanguages } from "../src/settings.js";
import type { TranscriptionOptions } from "../src/transcription.js";
import { TranscriptionService } from "../src/transcription-service.js";
import { nextTurn } from "./helpers.js";
import { cacheCatalogModel, isolatedModelCache } from "./model-cache-helper.js";

// Multilingual without native detection, so Auto relies on the shared detector.
const settings = settingsForModel("canary-180m-flash", "/mock/canary.gguf", {
  shortcut: "ctrl+alt+z",
  preferredLanguages: ["en", "de"],
  transcriptionLanguage: "auto",
});
const SPEECH = new Float32Array(16000);

function prediction(code: string): LangIdResult {
  return {
    code, allowedMass: 0.9,
    candidates: [
      { index: 0, code, name: code, p: 0.9, logit: 2 },
      { index: 1, code: code === "en" ? "de" : "en", name: "runner-up", p: 0.1, logit: 0 },
    ],
  };
}

function harness(
  t: TestContext,
  { detectorCached = true, identify = async () => prediction("de") }: {
    detectorCached?: boolean;
    identify?: () => Promise<LangIdResult>;
  } = {},
) {
  const cache = isolatedModelCache(t);
  if (detectorCached) cacheCatalogModel(cache, LANGUAGE_DETECTION_MODEL);
  const streams: TranscriptionOptions[] = [];
  const asrCalls: TranscriptionOptions[] = [];
  const allowed: (readonly string[])[] = [];
  const service = new TranscriptionService((path) => path.endsWith(LANGUAGE_DETECTION_MODEL.filename)
    ? {
      async prepare() {},
      async transcribe() { throw new Error("the detector never transcribes"); },
      async identifyLanguage(_pcm, labels) { allowed.push(labels); return identify(); },
      async dispose() {},
    }
    : {
      async prepare() {},
      async startStream(options = {}) { streams.push(options); return undefined; },
      async transcribe(_pcm, options = {}) { asrCalls.push(options); return "transcript"; },
      async dispose() {},
    });
  t.after(() => service.shutdown());
  return { service, streams, asrCalls, allowed };
}

test("Auto on a model without native detection transcribes in the detected language", async (t) => {
  const h = harness(t);
  const reservation = h.service.reserveDictation(settings);
  await reservation.ready;
  reservation.feed(SPEECH);

  assert.deepEqual(await reservation.submit(SPEECH), { text: "transcript" });
  assert.equal(h.streams.length, 0, "a chunked model never opens a native stream");
  assert.deepEqual(h.allowed, [["en", "de"]]);
  assert.equal(h.asrCalls[0]!.language, "de");
});

test("a missing detector still transcribes, in the first preferred language, warning once", async (t) => {
  const h = harness(t, { detectorCached: false });
  const { text, warning } = await h.service.transcribeFile(settings, SPEECH);

  assert.equal(text, "transcript");
  assert.match(warning ?? "", /language detector isn't downloaded/);
  assert.equal(h.asrCalls[0]!.language, "en");
  assert.deepEqual(await h.service.transcribeFile(settings, SPEECH), { text: "transcript" });
});

test("cancelling dictation during detection never falls back to transcribing", async (t) => {
  const identified = new Deferred<LangIdResult>();
  const h = harness(t, { identify: () => identified.promise });
  const controller = new AbortController();
  const reservation = h.service.reserveDictation(settings);
  await reservation.ready;
  const result = assert.rejects(reservation.submit(SPEECH, controller.signal), /cancelled/);
  while (h.allowed.length === 0) await nextTurn();

  controller.abort(new Error("cancelled"));
  // A detector that finishes anyway must not let the take reach ASR.
  identified.resolve(prediction("de"));
  await result;
  await h.service.shutdown();
  assert.equal(h.asrCalls.length, 0);
});

test("Auto gives way to a fixed language once the preferences can't support it", () => {
  assert.equal(settings.transcriptionLanguage, "auto", "two detectable preferences default to Auto");
  assert.equal(settingsWithPreferredLanguages(settings, ["en"]).transcriptionLanguage, "en");

  // Fun-ASR supports Irish, but the detector can't identify it.
  const fun = CATALOG_MODELS.find((model) => model.id === "Fun-ASR-MLT-Nano-2512")!;
  assert.equal(fun.capabilities.languageDetection, false);
  const funAuto = settingsForModel(fun.id, "/mock/fun.gguf", {
    shortcut: "ctrl+alt+z",
    preferredLanguages: ["zh", "en"],
    transcriptionLanguage: "auto",
  });
  assert.equal(funAuto.transcriptionLanguage, "auto");
  assert.equal(settingsWithPreferredLanguages(funAuto, ["zh", "en", "ga"]).transcriptionLanguage, "zh");
});
