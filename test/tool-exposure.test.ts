import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionExposure, parseToolExposure } from "../src/tool-exposure.js";

test("absent toolExposure is valid and unset", () => {
  assert.deepEqual(parseToolExposure(undefined), { invalid: false });
});

test("accepts direct and codemode for transcribe_file", () => {
  for (const value of ["direct", "codemode"] as const) {
    assert.deepEqual(parseToolExposure({ transcribe_file: value }), {
      setting: { transcribe_file: value },
      invalid: false,
    });
  }
});

test("rejects other values, keys and shapes", () => {
  for (const value of [
    { transcribe_file: "deferred" },
    { transcribe_file: "Codemode" },
    "codemode",
    [],
    null,
    {},
    { other: "codemode" },
    { transcribe_file: "codemode", other: "direct" },
  ]) {
    assert.deepEqual(parseToolExposure(value), { invalid: true }, JSON.stringify(value));
  }
});

test("codemode maps to the extension deferred exposure, like Pi's MCP support", () => {
  assert.equal(extensionExposure(undefined), "direct");
  assert.equal(extensionExposure({ transcribe_file: "direct" }), "direct");
  assert.equal(extensionExposure({ transcribe_file: "codemode" }), "deferred");
});
