import assert from "node:assert/strict";
import { test } from "node:test";
import { SpectrumAnalyzer } from "../src/visualizer.js";

test("analyzer levels rise on a tone and decay on silence", () => {
  const analyzer = new SpectrumAnalyzer();
  const tone = new Float32Array(512);
  for (let index = 0; index < tone.length; index += 1) {
    // 1 kHz at the 16 kHz capture rate.
    tone[index] = Math.sin((2 * Math.PI * index) / 16) * 0.5;
  }
  analyzer.push(tone);
  const peak = Math.max(...analyzer.bands);
  assert.ok(peak > 0);
  analyzer.push(new Float32Array(512));
  assert.ok(Math.max(...analyzer.bands) < peak);
  analyzer.reset();
  assert.ok(analyzer.bands.every((band) => band === 0));
});
