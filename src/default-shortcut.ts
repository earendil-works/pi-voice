import { execFileSync } from "node:child_process";

/** The shortcut new users get when nothing on the system claims it. */
export const PREFERRED_SHORTCUT = "ctrl+space";
/** Used instead when Ctrl+Space would switch keyboard input sources. */
export const FALLBACK_SHORTCUT = "ctrl+alt+z";

const KEYBOARD_SOURCE =
  /InputSourceKind = "(?:Keyboard Layout|Keyboard Input Method|Input Mode)"/g;

/**
 * Whether `defaults read com.apple.HIToolbox AppleEnabledInputSources` lists
 * more than one keyboard source. macOS binds Ctrl+Space to switching sources,
 * which only takes the key once there is something to switch to. Input method
 * parent rows may count alongside their modes; that only errs toward the
 * fallback.
 */
export function hasMultipleInputSources(enabledSources: string): boolean {
  return (enabledSources.match(KEYBOARD_SOURCE)?.length ?? 0) > 1;
}

function macCtrlSpaceSwitchesInput(): boolean {
  try {
    const enabledSources = execFileSync(
      "/usr/bin/defaults",
      ["read", "com.apple.HIToolbox", "AppleEnabledInputSources"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 },
    );
    return hasMultipleInputSources(enabledSources);
  } catch {
    // Unknown is treated as taken: the fallback works everywhere.
    return true;
  }
}

/**
 * fcitx, the usual Linux input method framework for CJK, toggles on Ctrl+Space
 * by default; IBus and GNOME switch on Super+Space. The environment names the
 * running framework but not its configured trigger, so any fcitx session gets
 * the fallback.
 */
function linuxCtrlSpaceSwitchesInput(env: NodeJS.ProcessEnv): boolean {
  return [env.XMODIFIERS, env.GTK_IM_MODULE, env.QT_IM_MODULE].some((value) =>
    value?.includes("fcitx"),
  );
}

/**
 * The shortcut offered to users who have not chosen one. Saved settings always
 * carry an explicit shortcut, so this never changes a configured user's key.
 */
export function defaultShortcut(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin" && macCtrlSpaceSwitchesInput()) return FALLBACK_SHORTCUT;
  if (platform === "linux" && linuxCtrlSpaceSwitchesInput(env)) return FALLBACK_SHORTCUT;
  return PREFERRED_SHORTCUT;
}
