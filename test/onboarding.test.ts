import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Deferred } from "../src/deferred.js";
import { CatalogModelPicker, LanguagePicker } from "../src/model-picker.js";
import { changeOnboardingModel, runModelSelection, runOnboarding } from "../src/onboarding.js";
import { RecommendedModelPicker } from "../src/recommendation-picker.js";
import { CATALOG_MODELS, LANGUAGE_DETECTION_MODEL } from "../src/catalog.js";
import { recommendModels } from "../src/recommendations.js";
import { readSettings, settingsForModel, writeSettings } from "../src/settings.js";
import { cacheCatalogModel, isolatedModelCache } from "./model-cache-helper.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

type Step = (pane: Component, done: (value: unknown) => void) => void | Promise<void>;

function scriptedContext(steps: Step[]) {
  let index = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const result = new Deferred<unknown>();
        const pane = await factory(
          testTui(24), testTheme(), keybindings() as Parameters<typeof factory>[2],
          (value) => result.resolve(value),
        );
        try {
          const step = steps[index++];
          assert.ok(step, `Unexpected pane: ${pane.constructor.name}`);
          await step(pane, (value) => result.resolve(value));
          return await result.promise;
        } finally {
          pane.dispose?.();
        }
      },
      notify: (message: string) => { assert.fail(`Unexpected notification: ${message}`); },
    },
  } as unknown as ExtensionContext;
  return { ctx, assertFinished: () => assert.equal(index, steps.length) };
}

function isolatedSettings(t: TestContext) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-onboarding-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

function initialSettings(languages = ["en"]) {
  return settingsForModel("parakeet-unified-en-0.6b", "/tmp/current-model", {
    preferredLanguages: languages,
    shortcut: "ctrl+alt+z",
    microphone: { type: "device", name: "Test microphone", occurrence: 1 },
    chineseOutput: "traditional-taiwan",
    longformChunking: false,
  });
}

/** Choose the primary pick from an expanded recommendation pane. */
function selectRecommended(): Step {
  return (pane) => {
    assert.ok(pane instanceof RecommendedModelPicker);
    pane.handleInput("\x1b[A"); // Expanded pane starts on the first alternative.
    pane.handleInput("\r");
  };
}

for (const entry of ["recommended", "other-models", "single-pick"] as const) {
  test(`Try it changes languages from ${entry}, recomputes picks, and saves them with the model`, async (t) => {
    isolatedSettings(t);
    const cache = isolatedModelCache(t);
    cacheCatalogModel(cache, LANGUAGE_DETECTION_MODEL);
    const current = initialSettings(entry === "single-pick" ? ["en", "bs"] : ["en"]);
    await writeSettings(current);
    const picks = recommendModels(CATALOG_MODELS, ["en", "zh"]);
    for (const pick of picks) cacheCatalogModel(cache, pick.model);
    const expectedModelId = picks.find((pick) => pick.roles.includes("best"))!.model.id;
    const steps: Step[] = [];
    if (entry === "other-models") {
      steps.push((pane) => {
        assert.ok(pane instanceof RecommendedModelPicker);
        pane.handleInput("o");
      });
    }
    steps.push(
      (pane) => {
        assert.ok(entry === "recommended"
          ? pane instanceof RecommendedModelPicker
          : pane instanceof CatalogModelPicker);
        pane.handleInput?.("\x0c");
      },
      (pane, done) => {
        assert.ok(pane instanceof LanguagePicker);
        done({ languages: ["en", "zh"], confirmed: true });
      },
      selectRecommended(),
    );
    const script = scriptedContext(steps);
    const result = await changeOnboardingModel(script.ctx, current);
    script.assertFinished();
    assert.ok(result);
    assert.deepEqual(result.preferredLanguages, ["en", "zh"]);
    assert.equal(result.model.id, expectedModelId);
    assert.equal(result.shortcut, current.shortcut);
    assert.deepEqual(result.microphone, current.microphone);
    assert.equal(result.chineseOutput, current.chineseOutput);
    assert.equal(result.longformChunking, false, "the hidden setting survives a model change");
    assert.deepEqual((await readSettings()).settings, result);

    // A later visit uses the newly saved languages, not the first-run closure.
    const revisit = scriptedContext([(pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      pane.handleInput("\x1b");
    }]);
    assert.equal(await changeOnboardingModel(revisit.ctx, result), undefined);
    revisit.assertFinished();
  });
}

test("a root catalog stays root when another cached model appears while it is open", async (t) => {
  isolatedSettings(t);
  const cache = isolatedModelCache(t);
  cacheCatalogModel(cache, LANGUAGE_DETECTION_MODEL);
  const current = CATALOG_MODELS.find((model) => model.id === "parakeet-unified-en-0.6b")!;
  const second = CATALOG_MODELS.find((model) => model.id !== current.id)!;
  cacheCatalogModel(cache, current);
  const script = scriptedContext([
    (pane) => {
      assert.ok(pane instanceof CatalogModelPicker);
      // Simulate finishing a download without closing this catalog. Routing
      // must still reflect the cache state from when the pane opened.
      cacheCatalogModel(cache, second);
      pane.handleInput("\x1b");
    },
  ]);
  assert.equal(await runModelSelection(script.ctx, {
    preferredLanguages: ["en"],
    currentModelId: current.id,
    postActivation: "stay",
  }), undefined);
  script.assertFinished();
});

test("Escape from all models returns to the recommendation that opened it", async (t) => {
  isolatedSettings(t);
  const current = initialSettings();
  await writeSettings(current);
  const script = scriptedContext([
    (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      pane.handleInput("o");
    },
    (pane) => {
      assert.ok(pane instanceof CatalogModelPicker);
      pane.handleInput("\x1b");
    },
    (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      pane.handleInput("\x1b");
    },
  ]);
  assert.equal(await changeOnboardingModel(script.ctx, current), undefined);
  script.assertFinished();
});

test("cancelling the language picker returns to its model pane without applying edits", async (t) => {
  isolatedSettings(t);
  const current = initialSettings();
  await writeSettings(current);
  const script = scriptedContext([
    (pane) => pane.handleInput?.("\x0c"),
    (pane, done) => {
      assert.ok(pane instanceof LanguagePicker);
      done({ languages: ["en", "zh"], confirmed: false });
    },
    (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      pane.handleInput("\x1b");
    },
  ]);
  assert.equal(await changeOnboardingModel(script.ctx, current), undefined);
  script.assertFinished();
  assert.deepEqual((await readSettings()).settings, current);
});

test("back after confirming new languages leaves settings unchanged until a model is selected", async (t) => {
  isolatedSettings(t);
  const current = initialSettings();
  await writeSettings(current);
  const script = scriptedContext([
    (pane) => pane.handleInput?.("\x0c"),
    (_pane, done) => done({ languages: ["en", "zh"], confirmed: true }),
    (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      pane.handleInput("\x1b");
    },
  ]);
  assert.equal(await changeOnboardingModel(script.ctx, current), undefined);
  script.assertFinished();
  assert.deepEqual((await readSettings()).settings, current);
});

test("exiting first-run languages after a committed selection preserves saved settings", async (t) => {
  isolatedSettings(t);
  const cache = isolatedModelCache(t);
  cacheCatalogModel(cache, LANGUAGE_DETECTION_MODEL);
  for (const pick of recommendModels(CATALOG_MODELS, ["en"])) {
    cacheCatalogModel(cache, pick.model);
  }
  const script = scriptedContext([
    (_pane, done) => done({ languages: ["en"], confirmed: true }),
    (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      // Back waits for the cached model's settings commit instead of losing it.
      pane.handleInput("\r");
      pane.handleInput("\x1b");
    },
    (_pane, done) => done(undefined),
  ]);
  const configured = await runOnboarding(script.ctx);
  script.assertFinished();
  assert.ok(configured);
  assert.deepEqual((await readSettings()).settings, configured);
});

test("Escape from the initial recommendation still goes back to languages", async () => {
  const script = scriptedContext([
    (_pane, done) => done({ languages: ["en"], confirmed: true }),
    (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      pane.handleInput("\x1b");
    },
    (pane, done) => {
      assert.ok(pane instanceof LanguagePicker);
      done(undefined);
    },
  ]);
  assert.equal(await runOnboarding(script.ctx), undefined);
  script.assertFinished();
});

// Klingon: a language no catalog model speaks, so there are no picks.
const UNSPOKEN = "tlh";

test("no model speaks the language: the catalog stands in for the recommendation", async (t) => {
  assert.deepEqual(recommendModels(CATALOG_MODELS, [UNSPOKEN]), []);
  isolatedSettings(t);
  const script = scriptedContext([
    (_pane, done) => done({ languages: [UNSPOKEN], confirmed: true }),
    (pane) => {
      assert.ok(pane instanceof CatalogModelPicker);
      pane.handleInput("\x1b");
    },
    (pane, done) => {
      assert.ok(pane instanceof LanguagePicker, "Escape goes back to languages");
      done(undefined);
    },
  ]);
  assert.equal(await runOnboarding(script.ctx), undefined);
  script.assertFinished();
});

test("changing to languages no model speaks browses every model", async (t) => {
  isolatedSettings(t);
  const current = initialSettings();
  await writeSettings(current);
  const script = scriptedContext([
    (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      pane.handleInput("\x0c");
    },
    (_pane, done) => done({ languages: [UNSPOKEN], confirmed: true }),
    (pane) => {
      assert.ok(pane instanceof CatalogModelPicker);
      pane.handleInput("\x1b");
    },
  ]);
  assert.equal(await changeOnboardingModel(script.ctx, current), undefined);
  script.assertFinished();

  // Saved languages that lost their models open the catalog directly.
  const saved = scriptedContext([(pane) => {
    assert.ok(pane instanceof CatalogModelPicker);
    pane.handleInput("\x1b");
  }]);
  assert.equal(await changeOnboardingModel(saved.ctx, initialSettings([UNSPOKEN])), undefined);
  saved.assertFinished();
});

test("Tab keeps forward actions while Ctrl+L changes languages across model panes", () => {
  let languageResult: unknown;
  const languages = new LanguagePicker(
    testTui(24), testTheme(), keybindings(), ["en"], "exit",
    (result) => { languageResult = result; }, 1,
  );
  languages.handleInput("\t");
  assert.deepEqual(languageResult, { languages: ["en"], confirmed: true });

  const results: unknown[] = [];
  const activate = async () => ({ path: "/tmp/model" });
  const picks = recommendModels(CATALOG_MODELS, ["en"]);
  const recommended = new RecommendedModelPicker(
    testTui(24), testTheme(), keybindings(), ["en"], picks, activate,
    (result) => results.push(result), { onboardingStep: 2 },
  );
  recommended.handleInput("\t");
  assert.deepEqual(results, []);
  recommended.handleInput("\x0c");
  assert.deepEqual(results, [{ type: "change-languages" }]);
  recommended.dispose();

  const catalogResults: unknown[] = [];
  const catalog = new CatalogModelPicker(
    testTui(24), testTheme(), keybindings(), ["en"], undefined,
    (result) => catalogResults.push(result), activate,
  );
  catalog.handleInput("\t");
  assert.deepEqual(catalogResults, []);
  catalog.handleInput("\x0c");
  assert.deepEqual(catalogResults, [{ type: "change-languages" }]);
  catalog.dispose();
});
