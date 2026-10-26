import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const UPSTREAM_PROMPT_SNIPPET = "Transcribe speech from local audio or video files with a local model";
const UPSTREAM_PROMPT_GUIDELINES = [
  "Use transcribe_file when speech in a local audio or video file needs to be read, analyzed, or transcribed.",
  "transcribe_file automatically queues model work, with interactive dictation taking priority over queued files.",
  "If transcribe_file reports that FFmpeg is unavailable, explain the installation guidance and ask the user before running a system package-manager command.",
];

function fakeHost(t: TestContext, toolExposure: unknown) {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousDebug = process.env.PI_VOICE_DEBUG;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-registration-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.PI_VOICE_DEBUG;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousDebug !== undefined) process.env.PI_VOICE_DEBUG = previousDebug;
    rmSync(directory, { recursive: true, force: true });
  });
  if (toolExposure !== undefined) {
    const file = {
      ...settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", { shortcut: "ctrl+alt+x" }),
      toolExposure,
    };
    writeFileSync(join(directory, "pi-voice.json"), JSON.stringify(file), "utf8");
  }

  let tool: Record<string, unknown> | undefined;
  let shortcut: unknown;
  const commands: string[] = [];
  const startHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  let setActiveToolsCalls = 0;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (event === "session_start") startHandlers.push(handler);
    },
    registerTool(definition: Record<string, unknown>) { tool = definition; },
    registerShortcut(key: unknown) { shortcut = key; },
    registerCommand(name: string) { commands.push(name); },
    getCommands: () => [],
    getActiveTools: () => ["read", "transcribe_file"],
    setActiveTools() { setActiveToolsCalls++; },
  } as unknown as ExtensionAPI;

  piVoice(pi);
  const ctx = { mode: "print", ui: { notify() {} } };
  return {
    tool: () => tool!,
    shortcut: () => shortcut,
    commands,
    setActiveToolsCalls: () => setActiveToolsCalls,
    start: async () => { for (const handler of startHandlers) await handler({}, ctx); },
    warnings: () => {
      try {
        return readFileSync(join(directory, "pi-voice.log"), "utf8")
          .split("\n")
          .filter((line) => line.includes("toolExposure")).length;
      } catch {
        return 0;
      }
    },
  };
}

test("registration uses the configured exposure and keeps the upstream prompt text", async (t) => {
  const cases: Array<[unknown, string, number]> = [
    [undefined, "direct", 0],
    [{ transcribe_file: "direct" }, "direct", 0],
    [{ transcribe_file: "deferred" }, "deferred", 0],
    [{ transcribe_file: "codemode" }, "direct", 1],
  ];
  for (const [setting, exposure, warnings] of cases) {
    await t.test(JSON.stringify(setting) ?? "no settings file", (t) => {
      const host = fakeHost(t, setting);
      const tool = host.tool();
      assert.equal(tool.exposure, exposure);
      assert.equal(host.warnings(), warnings);
      assert.equal(host.shortcut(), setting === undefined ? "ctrl+alt+z" : "ctrl+alt+x");
      assert.deepEqual(host.commands, ["voice", "voice-settings", "transcribe"]);
      assert.equal(tool.promptSnippet, UPSTREAM_PROMPT_SNIPPET);
      assert.deepEqual(tool.promptGuidelines, UPSTREAM_PROMPT_GUIDELINES);
    });
  }
});

test("opted in, session start leaves the active tools to Pi so pending restored tools survive", async (t) => {
  const host = fakeHost(t, { transcribe_file: "deferred" });
  await host.start();
  assert.equal(host.setActiveToolsCalls(), 0);
});
