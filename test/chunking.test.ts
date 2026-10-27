import assert from "node:assert/strict";
import test from "node:test";
import {
  ChunkedTranscriber,
  chunksTranscription,
  cutCandidates,
  joinTranscripts,
  planCuts,
  speechSegments,
} from "../src/chunking.js";
import { settingsForModel } from "../src/settings.js";
import type { TranscriptionOptions } from "../src/transcription.js";
import { TranscriptionService } from "../src/transcription-service.js";
import { deferred, nextTurn } from "./helpers.js";

const RATE = 16_000;
const FRAME = 512;
const s = (seconds: number) => Math.round(seconds * RATE);

/** Frame probabilities: speech everywhere except the given pauses, in seconds. */
function probsWithPauses(seconds: number, pauses: Array<[start: number, end: number]>): number[] {
  return Array.from({ length: Math.floor(s(seconds) / FRAME) }, (_, i) => {
    const at = (i * FRAME) / RATE;
    return pauses.some(([start, end]) => at >= start && at < end) ? 0 : 1;
  });
}

function plan(seconds: number, pauses: Array<[number, number]>): number[] {
  const samples = s(seconds);
  return planCuts(cutCandidates(speechSegments(probsWithPauses(seconds, pauses), samples), samples), samples)
    .map((cut) => Math.round((cut / RATE) * 10) / 10);
}

test("chunking skips models that handle long audio and streaming models", () => {
  const chunks = (id: string, longformChunking = true) => chunksTranscription({ model: { id }, longformChunking });
  assert.equal(chunks("parakeet-tdt-0.6b-v3"), true);
  assert.equal(chunks("parakeet-ultra"), false);
  assert.equal(chunks("whisper-large-v3-turbo"), false);
  assert.equal(chunks("parakeet-unified-en-0.6b"), false);
  assert.equal(chunks("not-in-the-catalog"), true);
  assert.equal(chunks("parakeet-tdt-0.6b-v3", false), false, "the hidden setting turns it off");
});

test("segments follow Silero: short blips dropped, short dips bridged, edges padded", () => {
  const probs = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
  const segments = speechSegments(probs, probs.length * FRAME);
  // Frames 2-19 are one segment (a 2-frame dip is under 100 ms); the lone frame 25 is under 250 ms.
  assert.deepEqual(segments, [{ start: 2 * FRAME - 480, end: 20 * FRAME + 480 }]);
});

test("cuts prefer long pauses near 30 s", () => {
  assert.deepEqual(plan(40, [[20, 21]]), [], "40 s or less is never cut");
  // A 1 s pause at 28-29 s beats a short one right at 30 s; 41.5 s remain, so cut again.
  assert.deepEqual(plan(70, [[28, 29], [30, 30.2], [55, 56]]), [28.5, 55.5]);
  // Without any pause, cuts are hard 40 s ones.
  assert.deepEqual(plan(100, []), [40, 80]);
  // A pause under 5 s in is never used.
  assert.deepEqual(plan(60, [[2, 3]]), [40]);
});

test("cuts avoid leaving a short last chunk", () => {
  // The pause at 38 s would leave 4 s, so the weaker one at 10 s wins.
  assert.deepEqual(plan(42, [[9.8, 10.2], [37.5, 38.5]]), [10]);
  // Without a pause, a short rest is split evenly instead of cut at 40 s.
  assert.deepEqual(plan(84, []), [40, 62]);
  // A pause that leaves a short rest still beats cutting mid-speech.
  assert.deepEqual(plan(40.5, [[38.8, 39.2]]), [39]);
});

test("joins put spaces only between spaced scripts", () => {
  assert.equal(joinTranscripts([" Hello there. ", "", "General Kenobi."]), "Hello there. General Kenobi.");
  assert.equal(joinTranscripts(["今天天气很好。", "我们去公园吧。"]), "今天天气很好。我们去公园吧。");
  assert.equal(joinTranscripts(["I said", "你好"]), "I said你好");
  assert.equal(joinTranscripts(["안녕하세요.", "반갑습니다."]), "안녕하세요. 반갑습니다.");
  // CJK Extension B is a surrogate pair.
  assert.equal(joinTranscripts(["你好𠀀", "我们"]), "你好𠀀我们");
});

/** 100 s of audio, with pauses at 29-30 s and 58-59 s. */
const LONG = { seconds: 100, pauses: [[29, 30], [58, 59]] as Array<[number, number]> };

function longClip(): { pcm: Float32Array; probs: number[] } {
  const probs = probsWithPauses(LONG.seconds, LONG.pauses);
  return { pcm: new Float32Array(probs.length * FRAME), probs };
}

test("live chunks decode before the take ends, at the same cuts as one push", async () => {
  const { pcm, probs } = longClip();
  const offline: number[] = [];
  const once = new ChunkedTranscriber(async (chunk) => { offline.push(chunk.length); return `${offline.length}`; });
  once.push(pcm, probs);
  assert.equal(await once.finish(), "1 2 3 4");

  const live: number[] = [];
  const transcriber = new ChunkedTranscriber(async (chunk, clip) => {
    assert.ok(clip.length >= chunk.length);
    live.push(chunk.length);
    return "";
  });
  for (let frame = 0; frame < probs.length; frame++) {
    transcriber.push(pcm.subarray(frame * FRAME, (frame + 1) * FRAME), [probs[frame]!]);
  }
  await transcriber.idle();
  // A cut is made whenever more than 45 s is waiting: 2 of the 4 chunks before the end.
  assert.equal(live.length, 2, "chunks are decoded while audio still arrives");
  await transcriber.finish();
  assert.deepEqual(live, offline);
});

test("live cuts wait for a pause to end, so a long pause cuts as it does offline", async () => {
  // At 45 s the pause so far is 34-45 s, a cut at 39.5 s; the whole pause's
  // midpoint, 42 s, is out of reach, so the offline plan cuts at 40 s.
  const probs = probsWithPauses(90, [[34, 50]]);
  const pcm = new Float32Array(probs.length * FRAME);
  const cuts = async (feed: (transcriber: ChunkedTranscriber) => void): Promise<number[]> => {
    const sizes: number[] = [];
    const transcriber = new ChunkedTranscriber(async (chunk) => { sizes.push(chunk.length); return ""; });
    feed(transcriber);
    await transcriber.finish();
    return sizes;
  };
  const offline = await cuts((transcriber) => transcriber.push(pcm, probs));
  const live = await cuts((transcriber) => {
    for (let frame = 0; frame < probs.length; frame += 16) {
      transcriber.push(pcm.subarray(frame * FRAME, (frame + 16) * FRAME), probs.slice(frame, frame + 16));
    }
  });
  assert.deepEqual(offline, [s(40), s(40), pcm.length - s(80)]);
  assert.deepEqual(live, offline);
});

test("audio without probabilities is decoded in one piece after the last cut", async () => {
  const { pcm, probs } = longClip();
  const sizes: number[] = [];
  const transcriber = new ChunkedTranscriber(async (chunk) => { sizes.push(chunk.length); return "x"; });
  transcriber.push(pcm.subarray(0, s(50) - (s(50) % FRAME)), probs.slice(0, Math.floor(s(50) / FRAME)));
  transcriber.push(pcm.subarray(s(50) - (s(50) % FRAME)));
  assert.equal(await transcriber.finish(), "x x");
  assert.equal(sizes[0]! + sizes[1]!, pcm.length);
  assert.ok(sizes[1]! > s(40), "the unscored rest is one piece");
});

test("a failed chunk fails the whole transcript", async () => {
  const { pcm, probs } = longClip();
  const transcriber = new ChunkedTranscriber(async () => { throw new Error("decode failed"); });
  transcriber.push(pcm, probs);
  await assert.rejects(transcriber.finish(), /decode failed/);
});

const canary = settingsForModel("canary-1b-v2", "/mock/canary.gguf", {
  shortcut: "ctrl+alt+z",
  preferredLanguages: ["en"],
  transcriptionLanguage: "en",
});

function chunkedService(score?: (pcm: Float32Array) => Promise<number[]>) {
  const decoded: number[] = [];
  const service = new TranscriptionService(() => ({
    async prepare() {},
    async startStream() { throw new Error("chunked models never open a native stream"); },
    async transcribe(pcm: Float32Array, options: TranscriptionOptions = {}) {
      assert.equal(options.language, "en");
      decoded.push(pcm.length);
      return `part${decoded.length}`;
    },
    async dispose() {},
  }), score && ((pcm) => score(pcm)));
  return { service, decoded };
}

test("long files are scored once and decoded in chunks", async (t) => {
  const { pcm, probs } = longClip();
  let scored = 0;
  const h = chunkedService(async () => { scored++; return probs; });
  t.after(() => h.service.shutdown());
  assert.deepEqual(await h.service.transcribeFile(canary, pcm), { text: "part1 part2 part3 part4" });
  assert.equal(scored, 1);
  assert.equal(h.decoded.length, 4);

  // Short files are never scored.
  await h.service.transcribeFile(canary, new Float32Array(s(10)));
  assert.equal(scored, 1);
});

test("a long file whose scoring fails is decoded in one piece", async (t) => {
  const h = chunkedService(async () => { throw new Error("no silero"); });
  t.after(() => h.service.shutdown());
  const { pcm } = longClip();
  assert.deepEqual(await h.service.transcribeFile(canary, pcm), { text: "part1" });
  assert.deepEqual(h.decoded, [pcm.length]);
});

test("live dictation decodes chunks while recording, using the gate's probabilities", async (t) => {
  const h = chunkedService(async () => { throw new Error("dictation is never scored again"); });
  t.after(() => h.service.shutdown());
  const { pcm, probs } = longClip();
  const reservation = h.service.reserveDictation(canary);
  await reservation.ready;
  for (let at = 0; at < pcm.length; at += 8 * FRAME) {
    const piece = pcm.subarray(at, at + 8 * FRAME);
    reservation.feed(piece, probs.slice(at / FRAME, at / FRAME + piece.length / FRAME));
  }
  while (h.decoded.length < 2) await nextTurn();
  assert.deepEqual(await reservation.submit(pcm), { text: "part1 part2 part3 part4" });
});

test("a stream fallback waits for a live chunk still decoding before reusing the model", async (t) => {
  const release = deferred();
  const decoded: number[] = [];
  const service = new TranscriptionService(() => ({
    async prepare() {},
    async startStream() { throw new Error("chunked models never open a native stream"); },
    async transcribe(pcm: Float32Array) {
      decoded.push(pcm.length);
      // Like a native decode, the first one runs on past its abort.
      if (decoded.length === 1) await release.promise;
      return `part${decoded.length}`;
    },
    async dispose() {},
  }));
  t.after(() => service.shutdown());
  const { pcm, probs } = longClip();
  const reservation = service.reserveDictation(canary);
  await reservation.ready;
  // 60 s with speech at the end: one live chunk starts decoding.
  const fed = Math.floor(s(60) / FRAME) * FRAME;
  reservation.feed(pcm.subarray(0, fed), probs.slice(0, fed / FRAME));
  while (decoded.length < 1) await nextTurn();

  // The submitted take differs from what was fed, so the batch path takes over.
  const short = new Float32Array(s(10));
  const result = reservation.submit(short);
  for (let i = 0; i < 10; i++) await nextTurn();
  assert.equal(decoded.length, 1, "the batch decode waits for the live chunk");
  release.resolve();
  assert.deepEqual(await result, { text: "part2" });
  assert.deepEqual(decoded.slice(1), [short.length]);
});
