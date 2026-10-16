import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalLanguage, languageIdentity, resolveModelLanguage } from "../src/catalog.js";

test("language identities normalize case, regions, and aliases", () => {
  assert.equal(canonicalLanguage(" TL-ph "), "tl");
  assert.equal(languageIdentity(" TL-ph "), "fil");
  assert.equal(languageIdentity("fil"), "fil");
  assert.equal(languageIdentity("no"), "nb");
  assert.equal(languageIdentity("nb"), "nb");
  assert.equal(languageIdentity("en-GB"), "en");
});

test("model resolution returns exact backend codes, preferring explicit regions", () => {
  const model = { languages: ["en-US", "en-GB", "no", "tl", "zh"] };
  assert.equal(resolveModelLanguage(model, "fil"), "tl");
  assert.equal(resolveModelLanguage(model, "nb"), "no");
  assert.equal(resolveModelLanguage(model, " EN-gb "), "en-GB");
  assert.equal(resolveModelLanguage(model, "en"), "en-US");
  assert.equal(resolveModelLanguage(model, "zh"), "zh");
  assert.equal(resolveModelLanguage(model, "unknown"), undefined);
});
