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

const MODEL = "parakeet-unified-en-0.6b";
const CODEMODE = { transcribe_file: "codemode" } as const;

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

test("settingsForModel carries toolExposure only when set", () => {
  assert.deepEqual(
    settingsForModel(MODEL, "/tmp/model", { toolExposure: CODEMODE }).toolExposure,
    CODEMODE,
  );
  assert.equal("toolExposure" in settingsForModel(MODEL, "/tmp/model"), false);
});

test("a hand-edited opt-in is read back", async (t) => {
  const directory = await isolatedSettings(t);
  const file = { ...settingsForModel(MODEL, "/tmp/model"), toolExposure: CODEMODE };
  await writeFile(join(directory, "pi-voice.json"), JSON.stringify(file), "utf8");
  assert.deepEqual((await readSettings()).settings?.toolExposure, CODEMODE);
});

test("an invalid toolExposure is dropped without invalidating the settings", async (t) => {
  const directory = await isolatedSettings(t);
  const file = { ...settingsForModel(MODEL, "/tmp/model"), toolExposure: { transcribe_file: "deferred" } };
  await writeFile(join(directory, "pi-voice.json"), JSON.stringify(file), "utf8");
  const { settings, warning } = await readSettings();
  assert.equal(warning, undefined);
  assert.ok(settings);
  assert.equal("toolExposure" in settings, false);
});

test("the opt-in survives a preference edit and a save", async (t) => {
  const directory = await isolatedSettings(t);
  const current = settingsForModel(MODEL, "/tmp/model", { toolExposure: CODEMODE });
  const edited = settingsWithPreferredLanguages(current, ["en", "es"]);
  assert.deepEqual(edited.toolExposure, CODEMODE);
  await writeSettings(edited);
  assert.deepEqual((await readSettings()).settings?.toolExposure, CODEMODE);
  const onDisk = JSON.parse(await readFile(join(directory, "pi-voice.json"), "utf8")) as {
    toolExposure?: unknown;
  };
  assert.deepEqual(onDisk.toolExposure, CODEMODE);
});

test("default settings files do not gain a toolExposure key", async (t) => {
  const directory = await isolatedSettings(t);
  await writeSettings(settingsForModel(MODEL, "/tmp/model"));
  const onDisk = JSON.parse(await readFile(join(directory, "pi-voice.json"), "utf8")) as object;
  assert.equal("toolExposure" in onDisk, false);
});
