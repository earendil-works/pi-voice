import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { logStep, watchEventLoop } from "./log.js";
import { DictationController } from "./dictation-controller.js";
import { VoiceKeys } from "./keybindings.js";
import type { TranscribeSettings } from "./settings.js";
import { displayShortcut } from "./shortcut-core.js";
import { TranscriptionService } from "./transcription-service.js";
import type { RecordingMeter } from "./visualizer.js";

type ActiveRecording = {
  dictation: DictationController;
  meter: RecordingMeter;
  /** Ends the event-loop watch held for the whole recording. */
  unwatch: () => void;
};

const COMPLETION_WIDGET_MS = 5_000;
/** Setup confirmation stays long enough to read the shortcut and follow-up command. */
const READY_WIDGET_MS = 20_000;

export type PiVoiceRuntime = {
  readonly service: TranscriptionService;
  requireConfiguredSettingsForTool(): Promise<TranscribeSettings>;
  toggleCapture(ctx: ExtensionContext): Promise<void>;
  showSettings(ctx: ExtensionCommandContext): Promise<void>;
  replayOnboarding(ctx: ExtensionCommandContext): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
};

function isMicrophoneUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.name === "MicrophoneUnavailableError";
}

function captureErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const permissionHelp =
    process.platform === "darwin" && !isMicrophoneUnavailableError(error)
      ? " Check System Settings → Privacy & Security → Microphone for your terminal app."
      : "";
  return `Microphone capture failed: ${message}${permissionHelp}`;
}

function transcriptionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Local transcription failed: ${message}`;
}

export function createPiVoiceRuntime(
  pi: ExtensionAPI,
  registeredShortcut: string,
): PiVoiceRuntime {
  let recording: ActiveRecording | undefined;
  let operation: Promise<void> | undefined;
  let dictation: DictationController | undefined;
  let shuttingDown = false;
  let stopListening: (() => void) | undefined;
  let completionWidgetTimer: ReturnType<typeof setTimeout> | undefined;
  let settings: TranscribeSettings | undefined;
  let settingsLoaded = false;
  let settingsReadWarning: string | undefined;
  let settingsWarningShown = false;
  let audioModulePromise: Promise<typeof import("./audio.js")> | undefined;
  let visualizerModulePromise: Promise<typeof import("./visualizer.js")> | undefined;
  const transcriptionService = new TranscriptionService();

  function loadAudio(): Promise<typeof import("./audio.js")> {
    return (audioModulePromise ??= import("./audio.js"));
  }

  function loadVisualizer(): Promise<typeof import("./visualizer.js")> {
    return (visualizerModulePromise ??= import("./visualizer.js"));
  }

  async function reportCaptureError(ctx: ExtensionContext, error: unknown): Promise<void> {
    ctx.ui.notify(captureErrorMessage(error), "error");
    if (!isMicrophoneUnavailableError(error)) {
      const { offerMacOSPermissionHelp } = await import("./settings-menu.js");
      await offerMacOSPermissionHelp(pi, ctx);
    }
  }

  function rememberSettings(configured: TranscribeSettings): void {
    settings = configured;
    settingsLoaded = true;
    settingsReadWarning = undefined;
  }

  async function notifyReady(ctx: ExtensionContext, configured: TranscribeSettings): Promise<void> {
    // Pi binds shortcuts at extension load. The command path reloads on its
    // own; the shortcut path cannot, so say what it takes to use a new one.
    const reloadNeeded = configured.shortcut !== registeredShortcut;
    const talk = reloadNeeded
      ? `run /reload, then ${displayShortcut(configured.shortcut)} to talk`
      : `${displayShortcut(configured.shortcut)} to talk`;
    const command = "/voice-settings";
    const commandDescription = "to change settings and download new models";
    const summary = `${command} ${commandDescription}`;

    // The TUI renders a success-colored widget in the meter slot so the user
    // sees where Pi Voice talks to them. RPC and print keep the plain
    // notification: RPC forwards widget lines verbatim, so theme escapes leak.
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`✓ Pi Voice ready · ${talk}\n${summary}`, "info");
      return;
    }
    const { clearTranscribeWidget, showReadyStatus } = await loadVisualizer();
    showReadyStatus(ctx, {
      talk,
      help: { command, description: commandDescription },
    });
    holdCompletionWidget(ctx, clearTranscribeWidget, READY_WIDGET_MS);
  }

  async function loadSettingsOnce(): Promise<void> {
    if (settingsLoaded) return;
    const { readSettings } = await import("./settings.js");
    const result = await readSettings();
    settingsLoaded = true;
    settings = result.settings;
    settingsReadWarning = result.warning;
  }

  async function configureFirstRun(
    ctx: ExtensionContext,
  ): Promise<TranscribeSettings | undefined> {
    const { runOnboarding } = await import("./onboarding.js");
    const configured = await runOnboarding(ctx, registeredShortcut);
    if (configured) rememberSettings(configured);
    return configured;
  }

  async function configureModel(
    ctx: ExtensionContext,
    previous: TranscribeSettings,
  ): Promise<TranscribeSettings | undefined> {
    const { runModelSelection } = await import("./onboarding.js");
    const configured = await runModelSelection(ctx, {
      shortcut: previous.shortcut,
      preferredLanguages: previous.preferredLanguages,
      transcriptionLanguage: previous.transcriptionLanguage,
      chineseOutput: previous.chineseOutput,
      currentModelId: previous.model.id,
      microphone: previous.microphone,
      postActivation: "advance",
    });
    if (configured) rememberSettings(configured);
    return configured;
  }

  async function ensureSettings(
    ctx: ExtensionContext,
  ): Promise<{ configured?: TranscribeSettings; completedFirstRun: boolean }> {
    await loadSettingsOnce();
    if (settingsReadWarning && !settingsWarningShown) {
      settingsWarningShown = true;
      ctx.ui.notify(settingsReadWarning, "warning");
    }

    if (settings && existsSync(settings.model.path)) {
      return { configured: settings, completedFirstRun: false };
    }

    const previous = settings;
    if (settings) {
      ctx.ui.notify(
        `Configured model file is missing: ${settings.model.path}. Choose a model again; nothing will be downloaded without confirmation.`,
        "warning",
      );
      settings = undefined;
    }

    const configured = previous
      ? await configureModel(ctx, previous)
      : await configureFirstRun(ctx);
    if (configured) await notifyReady(ctx, configured);
    return { configured, completedFirstRun: previous === undefined && configured !== undefined };
  }

  async function requireConfiguredSettingsForTool(): Promise<TranscribeSettings> {
    await loadSettingsOnce();
    if (settingsReadWarning && !settings) {
      throw new Error(
        `${settingsReadWarning} Ask the user to run /voice-settings in Pi's interactive TUI to configure a local model, then retry transcribe_file.`,
      );
    }
    if (!settings) {
      throw new Error(
        "Pi Voice is not configured. Ask the user to run /voice-settings in Pi's interactive TUI once to choose and download a local model, then retry transcribe_file.",
      );
    }
    if (!existsSync(settings.model.path)) {
      throw new Error(
        `The configured transcription model is missing: ${settings.model.path}. Ask the user to run /voice-settings and choose a model again, then retry transcribe_file.`,
      );
    }
    return settings;
  }

  function listenForCancel(ctx: ExtensionContext): void {
    stopListening?.();
    if (!ctx.hasUI) return;
    // No pane here to receive an injected manager; pi's global is the same one.
    const keys = new VoiceKeys(getKeybindings());
    stopListening = ctx.ui.onTerminalInput((data) => {
      if (!keys.matches(data, "voice.dictation.cancel")) return;
      if (recording) {
        void runExclusive(ctx, () => cancelRecording(ctx));
        return { consume: true };
      }
      if (dictation?.state.phase === "transcribing") {
        void dictation.cancel();
        ctx.ui.notify("Transcription cancelled", "info");
        return { consume: true };
      }
      if (dictation?.state.phase === "cancelling") return { consume: true };
    });
  }

  function clearCancelListener(): void {
    stopListening?.();
    stopListening = undefined;
  }

  function cancelCompletionWidgetTimer(): void {
    if (completionWidgetTimer) clearTimeout(completionWidgetTimer);
    completionWidgetTimer = undefined;
  }

  async function dismissCompletionWidget(ctx: ExtensionContext): Promise<void> {
    if (!completionWidgetTimer) return;
    cancelCompletionWidgetTimer();
    const { clearTranscribeWidget } = await loadVisualizer();
    clearTranscribeWidget(ctx);
  }

  function holdCompletionWidget(
    ctx: ExtensionContext,
    clearTranscribeWidget: (ctx: ExtensionContext) => void,
    durationMs = COMPLETION_WIDGET_MS,
  ): void {
    cancelCompletionWidgetTimer();
    const timer = setTimeout(() => {
      if (completionWidgetTimer !== timer) return;
      completionWidgetTimer = undefined;
      clearTranscribeWidget(ctx);
    }, durationMs);
    completionWidgetTimer = timer;
  }

  async function cancelRecording(ctx: ExtensionContext): Promise<void> {
    const active = recording;
    if (!active) return;
    recording = undefined;
    active.meter.stop();
    active.unwatch();
    await active.dictation.dispose();
    if (dictation === active.dictation) dictation = undefined;
    clearCancelListener();
    if (!shuttingDown) ctx.ui.notify("Recording discarded", "info");
  }

  async function reportDictationError(ctx: ExtensionContext, controller: DictationController): Promise<void> {
    const state = controller.state;
    if (state.phase !== "error" || shuttingDown) return;
    if (state.stage === "capture") await reportCaptureError(ctx, state.cause);
    else ctx.ui.notify(transcriptionErrorMessage(state.cause), "error");
  }

  async function stopAndTranscribe(ctx: ExtensionContext): Promise<void> {
    const {
      clearTranscribeWidget,
      formatTranscriptionSummary,
      showTranscribeStatus,
    } = await loadVisualizer();
    const active = recording!;
    recording = undefined;
    active.meter.stop({ clearWidget: false });
    const cancelKeys = new VoiceKeys(getKeybindings()).keyText("voice.dictation.cancel");
    showTranscribeStatus(ctx, "Transcribing…", { cancelKeys });
    let keepCompletionVisible = false;
    try {
      const result = await active.dictation.stop();
      if (shuttingDown) return;
      if (!result) {
        await reportDictationError(ctx, active.dictation);
      } else if (result.text) {
        ctx.ui.pasteToEditor(result.text);
        showTranscribeStatus(
          ctx,
          formatTranscriptionSummary(result.speechSeconds, result.transcribeSeconds),
        );
        keepCompletionVisible = true;
      } else {
        ctx.ui.notify(`No speech detected in ${result.speechSeconds.toFixed(1)}s of audio`, "warning");
      }
    } finally {
      active.unwatch();
      await active.dictation.dispose();
      if (dictation === active.dictation) dictation = undefined;
      clearCancelListener();
      if (keepCompletionVisible) holdCompletionWidget(ctx, clearTranscribeWidget);
      else clearTranscribeWidget(ctx);
    }
  }

  async function startRecording(
    ctx: ExtensionContext,
    configured: TranscribeSettings,
  ): Promise<void> {
    logStep("loading audio module");
    const { createMicrophoneCapture, testMicrophonePermission } = await loadAudio();
    if (process.platform === "darwin") {
      const micStatus = await testMicrophonePermission();
      if (micStatus.status === "denied") {
        const openSettings = await ctx.ui.confirm(
          "Microphone access",
          "Microphone access is denied in System Settings. Open Privacy & Security → Microphone settings?",
        );
        if (openSettings) {
          const { openMacOSMicrophoneSettings } = await import("./settings-menu.js");
          await openMacOSMicrophoneSettings(pi, ctx);
        }
        return;
      }
    }
    const { RecordingMeter } = await loadVisualizer();
    if (shuttingDown) return;
    const meter = new RecordingMeter();
    const controller = new DictationController(transcriptionService, {
      createCapture: createMicrophoneCapture,
      onFrame: (frame) => meter.push(frame),
      onChange: () => meter.setModelState(controller.modelState),
    });
    dictation = controller;
    try {
      // Paint startup feedback before opening the native device blocks the loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (shuttingDown) return;
      await controller.start(configured);
      if (controller.state.phase !== "listening") {
        await reportDictationError(ctx, controller);
        return;
      }
      // Key text via the same formatter as the Try It pane so the meter
      // reads exactly like the hint the user learned during setup.
      const cancelKeys = new VoiceKeys(getKeybindings()).keyText("voice.dictation.cancel");
      meter.start(ctx, {
        action: `${displayShortcut(registeredShortcut)} to transcribe`,
        discard: `${cancelKeys} to discard`,
      });
      meter.setModelState(controller.modelState);
      recording = { dictation: controller, meter, unwatch: watchEventLoop() };
      listenForCancel(ctx);
    } catch (error) {
      recording?.unwatch();
      recording = undefined;
      meter.stop();
      clearCancelListener();
      ctx.ui.notify(`Recording failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      if (recording?.dictation !== controller) {
        await controller.dispose();
        if (dictation === controller) dictation = undefined;
      }
    }
  }

  async function toggleCaptureTask(ctx: ExtensionContext): Promise<void> {
    if (shuttingDown) return;
    // A fresh action replaces the transient completion in the shared meter slot.
    cancelCompletionWidgetTimer();
    if (recording) {
      await stopAndTranscribe(ctx);
      return;
    }

    // First-press module loading and microphone initialization take a
    // noticeable moment; show feedback until the recording meter takes over.
    // Static text on the shared widget slot: an animated spinner repaints every
    // frame, and the meter replaces plain lines without a component swap.
    const { clearTranscribeWidget, showTranscribeStatus } = await loadVisualizer();
    logStep("loading settings");
    await loadSettingsOnce();
    if (settings && existsSync(settings.model.path)) {
      showTranscribeStatus(ctx, "Starting microphone…");
    } else {
      // Setup panes replace only the editor, so a status line set here or by
      // the first-press handler in index.ts would sit above every setup step.
      clearTranscribeWidget(ctx);
    }

    const { configured, completedFirstRun } = await ensureSettings(ctx);
    if (configured && !completedFirstRun) await startRecording(ctx, configured);
    // The meter shares the widget slot and has replaced the spinner when
    // recording began; clear the spinner only when recording never started.
    // A finished first-run setup leaves the Ready widget in that slot with a
    // hold timer armed, so leave that one alone.
    if (!recording && !completionWidgetTimer) clearTranscribeWidget(ctx);
  }

  function runExclusive(
    ctx: ExtensionContext,
    task: () => Promise<void>,
  ): Promise<void> {
    if (operation) {
      ctx.ui.notify("A Pi Voice operation is already in progress", "warning");
      return operation;
    }

    const nextOperation = task().finally(() => {
      if (operation === nextOperation) operation = undefined;
    });
    operation = nextOperation;
    return nextOperation;
  }

  async function toggleCapture(ctx: ExtensionContext): Promise<void> {
    await runExclusive(ctx, () => toggleCaptureTask(ctx));
  }

  async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
    await dismissCompletionWidget(ctx);
    if (recording) {
      ctx.ui.notify(
        `Stop recording with ${displayShortcut(registeredShortcut)} before opening settings`,
        "warning",
      );
      return;
    }

    let reload = false;
    await runExclusive(ctx, async () => {
      await loadSettingsOnce();
      const hadConfiguration = Boolean(settings && existsSync(settings.model.path));
      const { configured } = await ensureSettings(ctx);
      if (!configured) return;
      if (!hadConfiguration) {
        // First-run setup ends on its Ready message rather than falling
        // straight through into the regular settings menu.
        reload = configured.shortcut !== registeredShortcut;
        return;
      }
      const { showSettingsMenu } = await import("./settings-menu.js");
      reload = await showSettingsMenu(pi, ctx, configured, registeredShortcut);
    });
    if (reload) {
      await ctx.reload();
    }
  }

  async function replayOnboarding(ctx: ExtensionCommandContext): Promise<void> {
    await dismissCompletionWidget(ctx);
    if (recording) {
      ctx.ui.notify(
        `Stop recording with ${displayShortcut(registeredShortcut)} before replaying onboarding`,
        "warning",
      );
      return;
    }

    await runExclusive(ctx, async () => {
      await loadSettingsOnce();
      const { runOnboarding } = await import("./onboarding.js");
      const configured = await runOnboarding(
        ctx,
        settings?.shortcut ?? registeredShortcut,
      );
      if (!configured) return;
      rememberSettings(configured);
      // End on the same Ready state as first-run setup. A replay should expose
      // the complete user flow rather than a debug-only completion message.
      await notifyReady(ctx, configured);
    });
  }

  async function shutdown(ctx: ExtensionContext): Promise<void> {
    shuttingDown = true;
    cancelCompletionWidgetTimer();
    const disposal = dictation?.dispose();
    recording?.meter.stop();
    recording?.unwatch();
    clearCancelListener();
    await Promise.all([
      disposal,
      operation?.catch(() => undefined),
      transcriptionService.shutdown().catch(() => undefined),
    ]);
    recording = undefined;
    dictation = undefined;
    if (visualizerModulePromise) {
      const visualizer = await visualizerModulePromise.catch(() => undefined);
      visualizer?.clearTranscribeWidget(ctx);
    }
  }

  return {
    service: transcriptionService,
    requireConfiguredSettingsForTool,
    toggleCapture,
    showSettings,
    replayOnboarding,
    shutdown,
  };
}
