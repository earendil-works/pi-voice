import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  readSettings,
  settingsForModel,
  settingsWithPreferredLanguages,
  writeSettings,
} from "../src/settings.js";
import { defaultShortcut } from "../src/default-shortcut.js";
import { readRegistrationSettings } from "../src/startup-shortcut.js";

const MODEL = "parakeet-unified-en-0.6b";
const DEFAULTS = { shortcut: defaultShortcut(), transcribeFileExposure: "direct" };

async function isolatedSettings(t: TestContext): Promise<string> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-tool-exposure-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("a hand-edited opt-in survives a preference edit and a save", async (t) => {
  const directory = await isolatedSettings(t);
  const file = { ...settingsForModel(MODEL, "/tmp/model", { shortcut: "ctrl+alt+z" }), transcribeFileExposure: "deferred" };
  await writeFile(join(directory, "pi-voice.json"), JSON.stringify(file), "utf8");
  const { settings } = await readSettings();
  assert.ok(settings);
  await writeSettings(settingsWithPreferredLanguages(settings, ["en", "es"]));
  assert.equal((await readSettings()).settings?.transcribeFileExposure, "deferred");
});

test("a missing or invalid transcribeFileExposure reads as direct without invalidating the settings", async (t) => {
  const directory = await isolatedSettings(t);
  const { transcribeFileExposure: _, ...withoutKey } = settingsForModel(MODEL, "/tmp/model", { shortcut: "ctrl+alt+z" });
  for (const file of [withoutKey, { ...withoutKey, transcribeFileExposure: "codemode" }]) {
    await writeFile(join(directory, "pi-voice.json"), JSON.stringify(file), "utf8");
    const { settings, warning } = await readSettings();
    assert.equal(warning, undefined);
    assert.equal(settings?.transcribeFileExposure, "direct");
  }
});

test("new settings files write the direct default", async (t) => {
  const directory = await isolatedSettings(t);
  await writeSettings(settingsForModel(MODEL, "/tmp/model", { shortcut: "ctrl+alt+z" }));
  const onDisk = JSON.parse(await readFile(join(directory, "pi-voice.json"), "utf8"));
  assert.equal(onDisk.transcribeFileExposure, "direct");
});

test("the registration reader ignores the opt-in in an unconfigured file", async (t) => {
  const directory = await isolatedSettings(t);
  await writeFile(
    join(directory, "pi-voice.json"),
    JSON.stringify({ shortcut: "ctrl+alt+x", transcribeFileExposure: "deferred" }),
    "utf8",
  );
  assert.deepEqual(readRegistrationSettings(), DEFAULTS);
});

test("the registration reader falls back to defaults for a missing or malformed file", async (t) => {
  const directory = await isolatedSettings(t);
  assert.deepEqual(readRegistrationSettings(), DEFAULTS);
  await writeFile(join(directory, "pi-voice.json"), "{ not json", "utf8");
  assert.deepEqual(readRegistrationSettings(), DEFAULTS);
});
