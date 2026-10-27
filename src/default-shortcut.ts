import { execFileSync } from "node:child_process";

/** The shortcut new users get when nothing on the system claims it. */
export const PREFERRED_SHORTCUT = "ctrl+space";
/** Used instead when Ctrl+Space would switch keyboard input sources. */
export const FALLBACK_SHORTCUT = "ctrl+alt+z";

const KEYBOARD_SOURCE =
  /InputSourceKind = "(?:Keyboard Layout|Keyboard Input Method|Input Mode)"/g;

/** macOS only claims Ctrl+Space once there are two keyboard sources to switch between. */
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
    // Unknown counts as taken; the fallback works everywhere.
    return true;
  }
}

/** fcitx toggles on Ctrl+Space by default; IBus and GNOME use Super+Space. */
function linuxCtrlSpaceSwitchesInput(env: NodeJS.ProcessEnv): boolean {
  return [env.XMODIFIERS, env.GTK_IM_MODULE, env.QT_IM_MODULE].some((value) =>
    value?.includes("fcitx"),
  );
}

/** Only for users without saved settings, which always store a shortcut. */
export function defaultShortcut(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin" && macCtrlSpaceSwitchesInput()) return FALLBACK_SHORTCUT;
  if (platform === "linux" && linuxCtrlSpaceSwitchesInput(env)) return FALLBACK_SHORTCUT;
  return PREFERRED_SHORTCUT;
}
