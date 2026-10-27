import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { CATALOG_MODELS } from "../src/catalog.js";
import {
  CatalogModelPicker,
  createTranscriptionLanguagePicker,
  LanguagePicker,
} from "../src/model-picker.js";
import { ModelRatingsHelp } from "../src/model-ratings-help.js";
import { VoiceKeys } from "../src/keybindings.js";
import { RecommendedModelPicker } from "../src/recommendation-picker.js";
import type { TranscribeSettings } from "../src/settings.js";
import { TryItPane } from "../src/try-it.js";
import { SingleSelectPicker } from "../src/ui-components.js";
import { isolatedModelCache } from "./model-cache-helper.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");
const DOWN = "\x1b[B";
const settings: TranscribeSettings = {
  version: 1,
  backend: { type: "transcribe-cpp" },
  shortcut: "ctrl+alt+z",
  preferredLanguages: ["en"],
  transcriptionLanguage: "en",
  chineseOutput: "simplified",
  microphone: { type: "system-default" },
  voiceActivityDetection: true,
  longformChunking: true,
  transcribeFileExposure: "direct",
  model: {
    source: "catalog",
    id: "parakeet-unified-en-0.6b",
    path: "/tmp/model.gguf",
  },
};

type TestPane = Component & {
  handleInput?: (data: string) => void;
  dispose?: () => unknown;
};

test("editor-mounted panes respect the shared 80x24 row and width budget", async (t) => {
  isolatedModelCache(t);
  const makeTui = () => testTui(24);
  const pendingActivation = () => new Promise<{ path: string }>(() => {});
  const pendingService = {
    reserveDictation: () => ({
      ready: new Promise<void>(() => {}),
      feed() {},
      submit: async () => "",
      cancel() {},
    }),
  };
  const recommended = [{
    model: CATALOG_MODELS[0]!,
    roles: ["best" as const],
    status: "eligible" as const,
  }];
  const choices = Array.from({ length: 30 }, (_, index) => ({
    value: `choice-${index}`,
    label: `Choice ${index}`,
    description: `Description for choice ${index}`,
  }));

  const factories: [string, () => TestPane][] = [
    ["catalog models", () => new CatalogModelPicker(
      makeTui(), testTheme(), keybindings(), ["en"], undefined, () => {}, pendingActivation,
    )],
    ["recommendations", () => new RecommendedModelPicker(
      makeTui(),
      testTheme(),
      keybindings(),
      ["en"],
      [
        recommended[0]!,
        { ...recommended[0]!, model: { ...recommended[0]!.model, id: "fast" }, roles: ["fast"] },
        { ...recommended[0]!, model: { ...recommended[0]!.model, id: "accurate" }, roles: ["accurate"] },
      ],
      pendingActivation,
      () => {},
      { expanded: true },
    )],
    ["languages", () => new LanguagePicker(
      makeTui(), testTheme(), keybindings(), ["en"], "back", () => {},
    )],
    ["transcription language", () => createTranscriptionLanguagePicker(
      makeTui(),
      testTheme(),
      keybindings(),
      CATALOG_MODELS.find((model) => model.capabilities.languageDetection && model.languages.length > 20)!,
      "auto",
      ["en"],
      () => {},
    )],
    ["single select", () => new SingleSelectPicker(
      makeTui(), testTheme(), keybindings(), choices, choices[0]!.value,
      { title: "Choose one", searchable: true }, () => {},
    )],
    ["Try It", () => new TryItPane(
      makeTui(), testTheme(), keybindings(), settings, pendingService as never, () => {},
    )],
    ["ratings help", () => {
      const help = new ModelRatingsHelp(makeTui(), testTheme(), new VoiceKeys(keybindings()), true);
      help.open();
      return help;
    }],
  ];

  for (const [name, factory] of factories) {
    const pane = factory();
    for (let step = 0; step < 40; step += 1) {
      const lines = pane.render(80);
      assert.ok(lines.length <= 22, `${name}: ${lines.length} rows at step ${step}`);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= 80),
        `${name}: line exceeds 80 columns`,
      );
      pane.handleInput?.(DOWN);
    }
    await pane.dispose?.();
  }
});
