import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { mock, test, type TestContext } from "node:test";
import {
  CustomEditor, getSelectListTheme, initTheme,
  type ExtensionAPI, type ExtensionContext, type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { Deferred } from "../src/deferred.js";
import type { OpenCapture } from "../src/dictation-controller.js";
import { matchesShortcut } from "../src/keybindings.js";
import { createPiVoiceRuntime } from "../src/runtime.js";
import { settingsForModel, writeSettings } from "../src/settings.js";
import { FakeMicrophone, FakeReservation } from "./dictation-helper.js";
import { testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");
let microphone: FakeMicrophone;
mock.module(new URL("../src/audio.js", import.meta.url).href, {
  namedExports: {
    microphonePermission: () => "granted",
    openMicrophone: ((device, sinks) => microphone.open(device, sinks)) satisfies OpenCapture,
  },
});

async function recording(t: TestContext, bindings: KeybindingsConfig = { "voice.dictation.stopAndSend": "ctrl+space" }) {
  const previousKeys = getKeybindings();
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-runtime-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, bindings));
  await writeSettings(settingsForModel("parakeet-unified-en-0.6b", directory, {
    shortcut: "ctrl+space", voiceActivityDetection: false, longformChunking: false,
  }));
  microphone = new FakeMicrophone();
  const reservation = new FakeReservation();
  reservation.prepared.resolve();
  const runtime = createPiVoiceRuntime({} as ExtensionAPI, "ctrl+space");
  t.mock.method(runtime.service, "reserveDictation", () => reservation);
  const theme = { borderColor: (text: string) => text, selectList: getSelectListTheme() };
  const editor = new CustomEditor(testTui(), theme, getKeybindings() as ConstructorParameters<typeof CustomEditor>[2]);
  const messages: string[] = [];
  editor.onSubmit = (text) => { messages.push(text); editor.addToHistory(text); };
  let overlay = false;
  const tui = Object.assign(testTui(), { getFocusedComponent: () => editor, hasOverlay: () => overlay });
  let listener: TerminalInputHandler | undefined;
  const finished = new Deferred();
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      theme: testTheme(), setWidget() {}, notify() {},
      onTerminalInput: (handler: TerminalInputHandler) => {
        listener = handler;
        return () => { listener = undefined; finished.resolve(); };
      },
      pasteToEditor: (text: string) => editor.handleInput(`\x1b[200~${text}\x1b[201~`),
      getEditorText: () => editor.getExpandedText(),
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0], options: unknown) => {
        assert.deepEqual(options, { overlay: true });
        let closed = false;
        let result: unknown;
        await factory(tui, testTheme(), getKeybindings() as Parameters<typeof factory>[2], (value) => { closed = true; result = value; });
        assert.ok(closed, "submission must close before a pane mounts");
        return result;
      },
    },
  } as unknown as ExtensionContext;
  t.after(async () => {
    reservation.result.resolve("discarded");
    await runtime.shutdown(ctx);
    setKeybindings(previousKeys);
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  });
  await runtime.toggleCapture(ctx);
  assert.ok(listener);
  function press(data: string): Promise<void> {
    if (listener?.(data)?.consume) return finished.promise;
    assert.ok(matchesShortcut(data, "ctrl+space"));
    return runtime.toggleCapture(ctx);
  }
  return { editor, messages, reservation, press, capture: microphone.captures[0]!, showOverlay: () => { overlay = true; } };
}

test("opted-in Ctrl+Space waits for transcription and submits the composed draft through the editor", async (t) => {
  const voice = await recording(t);
  voice.editor.setText("before after");
  voice.editor.handleInput("\x01");
  for (let index = 0; index < "before ".length; index++) voice.editor.handleInput("\x1b[C");
  const finished = voice.press("\x00");
  await setImmediate();
  assert.deepEqual(voice.messages, []);
  voice.reservation.result.resolve("dictated ");
  await finished;
  assert.deepEqual(voice.messages, ["before dictated after"]);
  assert.equal(voice.editor.getExpandedText(), "");
  voice.editor.handleInput("\x1b[A");
  assert.equal(voice.editor.getExpandedText(), "before dictated after");
});

for (const action of ["Space", "unbound Ctrl+Space"] as const) {
  test(`${action} keeps the transcription as a draft`, async (t) => {
    const voice = await recording(t, action === "Space" ? { "voice.dictation.stopAndSend": "ctrl+space" } : {});
    voice.editor.setText("prefix ");
    voice.reservation.result.resolve("dictated");
    await voice.press(action === "Space" ? " " : "\x00");
    assert.deepEqual(voice.messages, []);
    assert.equal(voice.editor.getExpandedText(), "prefix dictated");
  });
}

for (const outcome of ["empty", "error", "cancel", "interruption", "dropped frames", "overlay"] as const) {
  test(`stop-and-send does not submit with ${outcome}`, async (t) => {
    const voice = await recording(t);
    voice.editor.setText("existing draft ");
    if (outcome === "interruption") voice.capture.fail(new Error("microphone disconnected"));
    if (outcome === "dropped frames") t.mock.method(voice.capture, "stop", async () => ({ pcm: voice.capture.pcm, droppedFrames: 160 }));
    if (outcome === "overlay") voice.showOverlay();
    const finished = voice.press("\x00");
    await setImmediate();
    if (outcome === "error") voice.reservation.result.reject(new Error("decoder failed"));
    else {
      if (outcome === "cancel") void voice.press("\x1b");
      voice.reservation.result.resolve(outcome === "empty" ? "   " : "partial transcript");
    }
    await finished;
    assert.deepEqual(voice.messages, []);
    const partial = outcome === "interruption" || outcome === "dropped frames" || outcome === "overlay";
    assert.equal(voice.editor.getExpandedText(), partial ? "existing draft partial transcript" : "existing draft ");
  });
}
