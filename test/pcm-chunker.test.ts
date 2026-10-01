import assert from "node:assert/strict";
import test from "node:test";
import { PcmChunker } from "../src/pcm-chunker.js";

test("coalesces chunks in order and flushes the tail", () => {
  const chunks: Float32Array[] = [];
  const chunker = new PcmChunker((chunk) => chunks.push(chunk), 4);

  chunker.push(Float32Array.of(1, 2));
  chunker.push(Float32Array.of(3, 4, 5));
  chunker.push(Float32Array.of(6));

  assert.equal(chunks.length, 1);
  assert.deepEqual(
    [...chunks[0]!],
    [1, 2, 3, 4, 5],
  );

  chunker.flush();
  assert.equal(chunks.length, 2);
  assert.deepEqual([...chunks[1]!], [6]);
});

test("discard removes a partial chunk", () => {
  const chunks: Float32Array[] = [];
  const chunker = new PcmChunker((chunk) => chunks.push(chunk), 4);
  chunker.push(Float32Array.of(1, 2));
  chunker.discard();
  chunker.flush();
  assert.deepEqual(chunks, []);
});
