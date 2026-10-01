import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  chooseCatalogModel,
  chooseLanguages,
  defaultSpokenLanguages,
  type CatalogModelPostActivation,
} from "./model-picker.js";
import { createModelActivation } from "./model-activation.js";
import { microphonePermission } from "./audio.js";
import { chooseMicrophone, microphonesEqual } from "./microphone-picker.js";
import {
  chooseRecommendedModel,
  hasRecommendedAlternatives,
} from "./recommendation-picker.js";
import { CATALOG_MODELS } from "./catalog.js";
import { recommendModels } from "./recommendations.js";
import { createShortcutPicker } from "./shortcuts.js";
import { tryVoice } from "./try-it.js";
import {
  DEFAULT_MICROPHONE,
  settingsForModel,
  writeSettings,
  type ChineseOutput,
  type MicrophoneSetting,
  type TranscribeSettings,
  type TranscriptionLanguage,
} from "./settings.js";
import { DEFAULT_SHORTCUT } from "./shortcut-core.js";

function requireTui(ctx: ExtensionContext): boolean {
  if (ctx.mode === "tui") return true;
  ctx.ui.notify("Pi Voice configuration requires the interactive TUI", "error");
  return false;
}

type SettingsOptions = NonNullable<Parameters<typeof settingsForModel>[2]>;

/** Build the shared download-and-save pipeline from the flow's live settings. */
function createSettingsActivation(
  options: () => SettingsOptions,
  onCommitted: (settings: TranscribeSettings) => void,
) {
  return createModelActivation({
    buildSettings: (model, path) => settingsForModel(model.id, path, options()),
    onCommitted,
  });
}

type ModelSelectionOptions = {
  shortcut?: string;
  preferredLanguages?: readonly string[];
  transcriptionLanguage?: TranscriptionLanguage;
  chineseOutput?: ChineseOutput;
  currentModelId?: string;
  microphone?: MicrophoneSetting;
  /** Persists language changes made before this flow activates a model. */
  onPreferredLanguagesChange?: (languages: string[]) => Promise<void>;
  postActivation?: CatalogModelPostActivation;
};

export async function runModelSelection(
  ctx: ExtensionContext,
  options: ModelSelectionOptions = {},
): Promise<TranscribeSettings | undefined> {
  if (!requireTui(ctx)) return undefined;

  let preferredLanguages = [
    ...(options.preferredLanguages ?? defaultSpokenLanguages()),
  ];
  let currentModelId = options.currentModelId;
  let configured: TranscribeSettings | undefined;
  const { activate, waitForCommits } = createSettingsActivation(
    () => ({
      shortcut: configured?.shortcut ?? options.shortcut ?? DEFAULT_SHORTCUT,
      preferredLanguages,
      transcriptionLanguage:
        configured?.transcriptionLanguage ?? options.transcriptionLanguage,
      chineseOutput: configured?.chineseOutput ?? options.chineseOutput,
      microphone: configured?.microphone ?? options.microphone ?? DEFAULT_MICROPHONE,
    }),
    (settings) => {
      configured = settings;
      currentModelId = settings.model.id;
    },
  );

  // One pane switches between the models on disk and downloads new ones.
  while (true) {
    const selection = await chooseCatalogModel(ctx, preferredLanguages, currentModelId, {
      postActivation: options.postActivation,
      // Keep the post-selection state when the picker reopens after a
      // round-trip through the language step.
      activatedInFlow: configured !== undefined,
      onActivate: activate,
      cancelLabel: "close",
    });
    // The picker can close while its last commit is still in flight; wait so
    // configured reflects every selection that will land on disk.
    await waitForCommits();

    if (!selection || selection.type === "complete") return configured;

    // Esc and Continue both keep the selection here; the picker edits live
    // state rather than gating it behind a confirm.
    const changed = await chooseLanguages(ctx, preferredLanguages);
    if (changed) {
      try {
        if (configured) {
          const updated = { ...configured, preferredLanguages: changed.languages };
          await writeSettings(updated);
          configured = updated;
        } else {
          await options.onPreferredLanguagesChange?.(changed.languages);
        }
        preferredLanguages = changed.languages;
      } catch (error) {
        ctx.ui.notify(
          `Could not save preferred languages: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }

    // Reaching the language pane after a commit takes a Tab that landed while
    // the save was in flight. Esc there closes the flow instead of bouncing
    // back to a model pane that no longer offers the language step.
    if (!changed?.confirmed && configured) return configured;
  }
}

async function chooseOnboardingShortcut(
  ctx: ExtensionContext,
  current: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    createShortcutPicker(tui, theme, keybindings, current, done),
  );
}

async function saveOnboardingSettings(
  ctx: ExtensionContext,
  settings: TranscribeSettings,
): Promise<boolean> {
  try {
    await writeSettings(settings);
    return true;
  } catch (error) {
    ctx.ui.notify(
      `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return false;
  }
}

/** The Try it step, with its shortcut, microphone, and model adjustments looping back into it. */
async function finishOnboarding(
  ctx: ExtensionContext,
  initial: TranscribeSettings,
  changeModel: (current: TranscribeSettings) => Promise<TranscribeSettings | undefined>,
): Promise<TranscribeSettings> {
  let configured = initial;
  while (true) {
    const result = await tryVoice(ctx, configured);
    if (result?.action === "model") {
      configured = (await changeModel(configured)) ?? configured;
      continue;
    }
    if (result?.action === "shortcut") {
      const shortcut = await chooseOnboardingShortcut(ctx, configured.shortcut);
      if (!shortcut || shortcut === configured.shortcut) continue;
      const updated = { ...configured, shortcut };
      if (await saveOnboardingSettings(ctx, updated)) configured = updated;
      continue;
    }
    if (result?.action === "microphone") {
      const permission = microphonePermission();
      const microphone = await chooseMicrophone(ctx, configured.microphone, permission);
      if (!microphone || microphonesEqual(microphone, configured.microphone)) continue;
      const updated = { ...configured, microphone };
      if (await saveOnboardingSettings(ctx, updated)) configured = updated;
      continue;
    }
    return configured;
  }
}

/** Change the model from Try it, including a round trip through languages. */
export async function changeOnboardingModel(
  ctx: ExtensionContext,
  current: TranscribeSettings,
): Promise<TranscribeSettings | undefined> {
  let languages = [...current.preferredLanguages];
  let picks = recommendModels(CATALOG_MODELS, languages);
  // With nothing to recommend besides the current model, the catalog is the
  // whole flow. Otherwise the recommendation pane fronts it, and Esc from
  // the catalog returns there rather than to Try it.
  let recommending = hasRecommendedAlternatives(picks);
  let pane: "recommended" | "browse" = recommending ? "recommended" : "browse";
  let chosen: TranscribeSettings | undefined;
  const activation = createSettingsActivation(
    () => ({
      shortcut: current.shortcut,
      preferredLanguages: languages,
      microphone: current.microphone,
      chineseOutput: current.chineseOutput,
    }),
    (settings) => {
      chosen = settings;
    },
  );

  while (true) {
    const result = pane === "recommended"
      ? await chooseRecommendedModel(ctx, languages, picks, activation.activate, {
          title: "Change model",
          expanded: true,
          onboardingStep: 3,
        })
      : await chooseCatalogModel(ctx, languages, chosen?.model.id ?? current.model.id, {
          postActivation: "advance",
          onActivate: activation.activate,
          cancelLabel: "back",
          onboardingStep: 3,
          title: "Browse all models",
        });
    await activation.waitForCommits();
    if (!result && pane === "browse" && recommending) {
      pane = "recommended";
      continue;
    }
    if (!result || result.type === "complete" || result.type === "back") return chosen;
    if (result.type === "other-models") {
      pane = "browse";
      continue;
    }

    const changed = await chooseLanguages(ctx, languages, {
      cancelLabel: "back",
      onboardingStep: 3,
    });
    if (!changed?.confirmed) continue;
    // Language edits remain a draft until a model is selected. Esc back to
    // Try it must not silently alter the settings it is about to test.
    languages = changed.languages;
    picks = recommendModels(CATALOG_MODELS, languages);
    // Even a single pick deserves its recommendation after languages change.
    recommending = true;
    pane = "recommended";
  }
}

export async function runOnboarding(
  ctx: ExtensionContext,
  shortcut = DEFAULT_SHORTCUT,
): Promise<TranscribeSettings | undefined> {
  if (!requireTui(ctx)) return undefined;

  let languages = defaultSpokenLanguages();
  // Navigation cannot undo a completed settings commit. Keep it across a
  // return to languages, even if the user then exits without another choice.
  let configured: TranscribeSettings | undefined;
  while (true) {
    const chosen = await chooseLanguages(ctx, languages, {
      cancelLabel: "exit",
      onboardingStep: 1,
    });
    if (!chosen?.confirmed) return configured;
    languages = chosen.languages;
    // The picks are judged on the benchmark rig; the Try it step measures
    // the real wait on this machine.
    const picks = recommendModels(CATALOG_MODELS, languages);
    const { activate, waitForCommits } = createSettingsActivation(
      () => ({ shortcut, preferredLanguages: languages }),
      (settings) => {
        configured = settings;
      },
    );

    let changeLanguages = false;
    while (!changeLanguages) {
      const recommendation = await chooseRecommendedModel(
        ctx,
        languages,
        picks,
        activate,
        { onboardingStep: 2 },
      );
      await waitForCommits();
      if (!recommendation) return configured;
      if (recommendation.type === "complete" && configured) {
        return finishOnboarding(ctx, configured, (current) => changeOnboardingModel(ctx, current));
      }
      if (recommendation.type === "change-languages" || recommendation.type === "back") {
        changeLanguages = true;
        continue;
      }

      const selection = await chooseCatalogModel(ctx, languages, configured?.model.id, {
        postActivation: "advance",
        onActivate: activate,
        cancelLabel: "back",
        onboardingStep: 2,
        title: "Browse all models",
      });
      await waitForCommits();
      if (selection?.type === "complete" && configured) {
        return finishOnboarding(ctx, configured, (current) => changeOnboardingModel(ctx, current));
      }
      if (selection?.type === "change-languages") changeLanguages = true;
      // Esc from the complete selector returns to the recommendation pane.
    }
  }
}
