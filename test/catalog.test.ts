import assert from "node:assert/strict";
import { chmod, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ALL_MODELS, modelsForEngine } from "@handy-computer/models";
import { CATALOG_MODELS, getCatalogModel, LANGUAGE_DETECTION_MODEL, modelFile } from "../src/catalog.js";
import { readSettings, settingsForModel, writeSettings } from "../src/settings.js";
import { readShortcutForRegistration } from "../src/startup-shortcut.js";

test("the pickers offer curated transcription models this engine can load", async () => {
  // transcribe-cpp exports no package.json; the tests run from the repo root.
  const engine = JSON.parse(await readFile("node_modules/transcribe-cpp/package.json", "utf8")) as { version: string };
  assert.ok(CATALOG_MODELS.length > 0);
  assert.equal(new Set(CATALOG_MODELS.map((model) => model.id)).size, CATALOG_MODELS.length);
  for (const model of [...CATALOG_MODELS, LANGUAGE_DETECTION_MODEL]) {
    assert.ok(modelFile(model).size > 0, model.id);
  }
  assert.ok(CATALOG_MODELS.every((model) => model.curated && model.role === "asr"));
  assert.deepEqual(modelsForEngine(CATALOG_MODELS, engine.version), [...CATALOG_MODELS]);
  assert.equal(LANGUAGE_DETECTION_MODEL.role, "langid");
});

test("saved settings resolve any published transcription model, never another role", () => {
  const uncurated = ALL_MODELS.find((model) => model.role === "asr" && !model.curated);
  assert.ok(uncurated, "the catalog publishes uncurated transcription models");
  assert.equal(getCatalogModel(uncurated.id), uncurated);
  for (const model of ALL_MODELS.filter((entry) => entry.role !== "asr")) {
    assert.equal(getCatalogModel(model.id), undefined, model.id);
  }
});

test("an unknown saved model requests reconfiguration without rewriting settings", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-retired-model-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const current = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model");
  const saved = { ...current, model: { ...current.model, id: "retired-model" } };
  await writeSettings(saved);

  const result = await readSettings();
  assert.equal(result.settings, undefined);
  assert.match(result.warning ?? "", /configuration is required/);
  const onDisk = JSON.parse(
    await readFile(join(directory, "pi-voice.json"), "utf8"),
  ) as unknown;
  assert.deepEqual(onDisk, saved);
});

test("legacy settings provide the startup shortcut and migrate on full read", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-settings-migration-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const legacy = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", {
    shortcut: "ctrl+alt+x",
  });
  await writeFile(
    join(directory, "pi-transcribe.json"),
    `${JSON.stringify(legacy, null, 2)}\n`,
    "utf8",
  );

  assert.equal(readShortcutForRegistration(), "ctrl+alt+x");
  assert.deepEqual((await readSettings()).settings, legacy);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "pi-voice.json"), "utf8")),
    legacy,
  );
  await assert.rejects(readFile(join(directory, "pi-transcribe.json"), "utf8"), {
    code: "ENOENT",
  });
});

// Permissions do not block root or Windows, so the write would succeed there.
const cannotRevokeWrite = process.platform === "win32" || process.getuid?.() === 0;

test("legacy settings still load when migration cannot write", { skip: cannotRevokeWrite }, async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-settings-migration-failure-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  });

  const legacy = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model");
  const legacyPath = join(directory, "pi-transcribe.json");
  await writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  await chmod(directory, 0o500);

  const result = await readSettings();
  assert.deepEqual(result.settings, legacy);
  assert.match(result.warning ?? "", /could not migrate/);
  assert.deepEqual(JSON.parse(await readFile(legacyPath, "utf8")), legacy);
  await assert.rejects(readFile(join(directory, "pi-voice.json"), "utf8"), { code: "ENOENT" });
});
