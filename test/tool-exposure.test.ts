import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToolExposure } from "../src/tool-exposure.js";

test("absent toolExposure is valid and unset", () => {
  assert.deepEqual(parseToolExposure(undefined), { invalid: false });
});

test("rejects other values, keys and shapes", () => {
  for (const value of [
    { transcribe_file: "codemode" },
    { transcribe_file: "Deferred" },
    "deferred",
    [],
    null,
    {},
    { other: "deferred" },
    { transcribe_file: "deferred", other: "direct" },
  ]) {
    assert.deepEqual(parseToolExposure(value), { invalid: true }, JSON.stringify(value));
  }
});
