import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piVoice from "../src/index.js";
import { requestReadyAfterReload } from "../src/ready-handoff.js";
import { settingsForModel, writeSettings } from "../src/settings.js";
import { displayShortcut } from "../src/shortcut-core.js";
import { testTheme } from "./ui-helpers.js";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;

test("the instance a setup reload starts shows Ready once, with the shortcut it bound", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-ready-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  // What the finished setup saved before reloading.
  await writeSettings(settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", { shortcut: "ctrl+alt+x" }));

  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    registerTool() {},
    registerShortcut() {},
    registerCommand() {},
    getCommands: () => [],
  } as unknown as ExtensionAPI;
  const widgets: (string[] | undefined)[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme: testTheme(),
      setWidget: (_key: string, lines: string[] | undefined) => { widgets.push(lines); },
      notify: (message: string) => { assert.fail(`Unexpected notification: ${message}`); },
    },
  } as unknown as ExtensionContext;

  requestReadyAfterReload();
  piVoice(pi);
  try {
    await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
    assert.deepEqual(widgets, [[
      `✓ Pi Voice ready · ${displayShortcut("ctrl+alt+x")} to talk`,
      "/voice-settings to change settings and download new models",
    ]]);

    // The request is spent: a later reload shows nothing.
    await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
    assert.equal(widgets.length, 1);
  } finally {
    // Cancels the Ready hold timer.
    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
  }
});
