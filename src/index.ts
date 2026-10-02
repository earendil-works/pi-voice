import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { registerFileTranscriptionTool } from "./file-transcription.js";
import {
  claimLegacyGitNotice,
  findLegacyGitInstall,
  legacyGitMigrationMessage,
} from "./install-migration.js";
import type { PiVoiceRuntime } from "./runtime.js";
import { displayShortcut, STATUS_WIDGET_KEY } from "./shortcut-core.js";
import { initLog, log, logStep, markKeyPress, watchEventLoop } from "./log.js";
import { legacySettingsPath, logPath, settingsPath } from "./settings-path.js";
import { readShortcutForRegistration } from "./startup-shortcut.js";

// Pi awaits extension module evaluation before continuing startup. Keep this
// entry point registration-only and load feature implementations on first use.
export default function piVoice(pi: ExtensionAPI): void {
  // Opens nothing yet: the first line written creates the file.
  initLog({ path: logPath(), level: process.env.PI_VOICE_DEBUG === "1" ? "debug" : "info" });
  const registeredShortcut = readShortcutForRegistration();
  let runtimePromise: Promise<PiVoiceRuntime> | undefined;
  let shuttingDown = false;

  function loadRuntime(): Promise<PiVoiceRuntime> {
    if (shuttingDown) return Promise.reject(new Error("Pi Voice is shutting down"));
    if (runtimePromise) return runtimePromise;

    const loadStarted = performance.now();
    logStep("loading runtime");
    const loading = import("./runtime.js").then(({ createPiVoiceRuntime }) => {
      log.debug(`runtime loaded in ${Math.round(performance.now() - loadStarted)} ms`);
      return createPiVoiceRuntime(pi, registeredShortcut);
    });
    runtimePromise = loading;
    void loading.catch(() => {
      if (runtimePromise === loading) runtimePromise = undefined;
    });
    return loading;
  }

  pi.on("session_start", async (_event, ctx) => {
    let showedMigrationNotice = false;
    if (ctx.mode === "tui") {
      const legacyInstall = findLegacyGitInstall(pi.getCommands());
      if (legacyInstall && await claimLegacyGitNotice()) {
        ctx.ui.notify(legacyGitMigrationMessage(legacyInstall), "warning");
        showedMigrationNotice = true;
      }
    }

    if (
      !showedMigrationNotice &&
      !existsSync(settingsPath()) &&
      !existsSync(legacySettingsPath())
    ) {
      ctx.ui.notify(
        `Pi Voice installed · press ${displayShortcut(registeredShortcut)} or run /voice-settings to set up`,
        "info",
      );
    }
  });

  const fileTranscription = registerFileTranscriptionTool(pi, {
    getSettings: async () => (await loadRuntime()).requireConfiguredSettingsForTool(),
    getService: async () => (await loadRuntime()).service,
  });

  async function toggleCapture(ctx: ExtensionContext): Promise<void> {
    markKeyPress();
    const release = watchEventLoop();
    // The first press pays deferred module loading before the runtime can
    // show anything; paint feedback synchronously. Later presses reach the
    // memoized runtime in a microtask and it paints its own status.
    if (!runtimePromise && ctx.hasUI) {
      ctx.ui.setWidget(STATUS_WIDGET_KEY, [
        ctx.ui.theme.fg("muted", "Starting microphone…"),
      ]);
    }
    try {
      await (await loadRuntime()).toggleCapture(ctx);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined);
      throw error;
    } finally {
      release();
    }
  }

  pi.registerShortcut(
    registeredShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0],
    {
      description: "Toggle microphone transcription",
      handler: toggleCapture,
    },
  );

  pi.registerCommand("voice", {
    description: "Start or stop microphone transcription",
    handler: (_args, ctx) => toggleCapture(ctx),
  });

  const openSettings = async (
    _args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => (await loadRuntime()).showSettings(ctx);

  pi.registerCommand("voice-settings", {
    description: "Open Pi Voice settings",
    handler: openSettings,
  });
  pi.registerCommand("transcribe", {
    description: "Open Pi Voice settings (alias for /voice-settings)",
    handler: openSettings,
  });

  if (process.env.PI_VOICE_DEBUG === "1") {
    pi.registerCommand("voice-onboarding", {
      description: "Replay Pi Voice onboarding (debug)",
      handler: async (_args, ctx) => (await loadRuntime()).replayOnboarding(ctx),
    });
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    await fileTranscription.shutdown().catch(() => undefined);
    const loading = runtimePromise;
    if (!loading) return;
    const runtime = await loading.catch(() => undefined);
    await runtime?.shutdown(ctx).catch(() => undefined);
  });
}
