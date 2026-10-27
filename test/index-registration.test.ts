import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piVoice from "../src/index.js";
import { settingsForModel } from "../src/settings.js";

function registeredCommands(debug: string | undefined): string[] {
  const previous = process.env.PI_VOICE_DEBUG;
  if (debug === undefined) delete process.env.PI_VOICE_DEBUG;
  else process.env.PI_VOICE_DEBUG = debug;

  const commands: string[] = [];
  const pi = {
    on() {},
    registerTool() {},
    registerShortcut() {},
    registerCommand(name: string) { commands.push(name); },
  } as unknown as ExtensionAPI;

  try {
    piVoice(pi);
  } finally {
    if (previous === undefined) delete process.env.PI_VOICE_DEBUG;
    else process.env.PI_VOICE_DEBUG = previous;
  }
  return commands;
}

test("registers the voice command and voice settings", () => {
  assert.deepEqual(registeredCommands(undefined), ["voice", "voice-settings", "transcribe"]);
});

test("the renamed debug flag registers only the renamed onboarding command", () => {
  assert.deepEqual(registeredCommands("1"), [
    "voice",
    "voice-settings",
    "transcribe",
    "voice-onboarding",
  ]);
});

test("the old debug flag is not a compatibility alias", () => {
  const previous = process.env.PI_TRANSCRIBE_DEBUG;
  process.env.PI_TRANSCRIBE_DEBUG = "1";
  try {
    assert.deepEqual(registeredCommands(undefined), ["voice", "voice-settings", "transcribe"]);
  } finally {
    if (previous === undefined) delete process.env.PI_TRANSCRIBE_DEBUG;
    else process.env.PI_TRANSCRIBE_DEBUG = previous;
  }
});

function registeredExposure(t: TestContext, transcribeFileExposure: unknown): unknown {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-registration-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  if (transcribeFileExposure !== undefined) {
    const file = { ...settingsForModel("parakeet-unified-en-0.6b", "/tmp/model"), transcribeFileExposure };
    writeFileSync(join(directory, "pi-voice.json"), JSON.stringify(file), "utf8");
  }

  let exposure: unknown;
  const pi = {
    on() {},
    registerTool(definition: { exposure?: unknown }) { exposure = definition.exposure; },
    registerShortcut() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;
  piVoice(pi);
  return exposure;
}

test("transcribe_file exposure comes from settings and defaults to direct", async (t) => {
  const cases: Array<[unknown, string]> = [
    [undefined, "direct"],
    ["direct", "direct"],
    ["deferred", "deferred"],
    ["codemode", "direct"],
  ];
  for (const [setting, expected] of cases) {
    await t.test(String(setting), (t) => {
      assert.equal(registeredExposure(t, setting), expected);
    });
  }
});
