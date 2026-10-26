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

type HostMetadata = "deferred-capable" | "no-exposure" | "missing";

function fakeHost(t: TestContext, toolExposure: unknown, metadata: HostMetadata = "deferred-capable") {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-registration-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  if (toolExposure !== undefined) {
    const file = { ...settingsForModel("parakeet-unified-en-0.6b", "/tmp/model"), toolExposure };
    writeFileSync(join(directory, "pi-voice.json"), JSON.stringify(file), "utf8");
  }

  let tool: Record<string, unknown> | undefined;
  const commands: string[] = [];
  const startHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  let active = ["read", "transcribe_file", "bash"];
  let setCalls = 0;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (event === "session_start") startHandlers.push(handler);
    },
    registerTool(definition: Record<string, unknown>) { tool = definition; },
    registerShortcut() {},
    registerCommand(name: string) { commands.push(name); },
    getCommands: () => [],
    getAllTools() {
      if (metadata === "missing" || !tool) return [];
      // Pi 0.83 lists tools without their exposure; Pi >= 0.99 reports it.
      return [metadata === "no-exposure"
        ? { name: tool.name }
        : { name: tool.name, exposure: tool.exposure }];
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active = [...names]; setCalls++; },
  } as unknown as ExtensionAPI;

  piVoice(pi);
  const ctx = { mode: "print", ui: { notify() {} } };
  return {
    tool: () => tool!,
    commands,
    active: () => active,
    setCalls: () => setCalls,
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

test("transcribe_file exposure follows the toolExposure setting", (t) => {
  const cases: Array<[unknown, string]> = [
    [undefined, "direct"],
    [{ transcribe_file: "direct" }, "direct"],
    [{ transcribe_file: "codemode" }, "deferred"],
    [{ transcribe_file: "deferred" }, "direct"],
  ];
  const baseline = fakeHost(t, undefined).tool();
  for (const [setting, expected] of cases) {
    const host = fakeHost(t, setting);
    const tool = host.tool();
    assert.equal(tool.exposure, expected, JSON.stringify(setting));
    assert.equal(tool.promptSnippet, baseline.promptSnippet);
    assert.deepEqual(tool.promptGuidelines, baseline.promptGuidelines);
    assert.deepEqual(host.commands, ["voice", "voice-settings", "transcribe"]);
  }
});

test("an invalid toolExposure is logged at registration", (t) => {
  assert.equal(fakeHost(t, { transcribe_file: "deferred" }).warnings(), 1);
  assert.equal(fakeHost(t, { transcribe_file: "codemode" }).warnings(), 0);
});

test("opted in on a capable host, session start removes only transcribe_file", async (t) => {
  const host = fakeHost(t, { transcribe_file: "codemode" });
  await host.start();
  assert.deepEqual(host.active(), ["read", "bash"]);
  await host.start();
  assert.equal(host.setCalls(), 1, "already inactive: no second change");
  assert.equal(host.warnings(), 0);
});

test("opted in on a host without exposure support, activation stays and one warning is logged", async (t) => {
  const host = fakeHost(t, { transcribe_file: "codemode" }, "no-exposure");
  await host.start();
  await host.start();
  assert.deepEqual(host.active(), ["read", "transcribe_file", "bash"]);
  assert.equal(host.setCalls(), 0);
  assert.equal(host.warnings(), 1);
});

test("opted in but the tool is not registered with the host: nothing happens", async (t) => {
  const host = fakeHost(t, { transcribe_file: "codemode" }, "missing");
  await host.start();
  assert.equal(host.setCalls(), 0);
  assert.equal(host.warnings(), 0);
});

test("opted out, session start never changes the active tools", async (t) => {
  const host = fakeHost(t, undefined);
  await host.start();
  assert.equal(host.setCalls(), 0);
  assert.equal(host.warnings(), 0);
});
