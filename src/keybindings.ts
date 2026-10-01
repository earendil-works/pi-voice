import { rawKeyHint } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  KeybindingsManager,
  matchesKey,
  type Keybinding,
  type KeybindingDefinitions,
  type KeybindingsConfig,
  type KeyId,
} from "@earendil-works/pi-tui";

/**
 * Every key Pi Voice binds itself, in pi's definition shape. Users
 * override these with the same ids in pi's keybindings.json; pi keeps entries
 * it does not recognise and hands them back through `getUserBindings()`.
 *
 * Navigation, confirm, and cancel come from pi's `tui.*` ids. Tab is ours: it
 * continues the language step and browses from Your models. The model pickers
 * in between swallow the Continue key so the setup sequence never reads Tab as
 * "go back".
 */
export const VOICE_KEYBINDINGS = {
  "voice.languages.toggle": { defaultKeys: "space", description: "Toggle the highlighted language" },
  "voice.languages.continue": { defaultKeys: "tab", description: "Continue with the selected languages" },
  "voice.languages.change": { defaultKeys: "ctrl+l", description: "Change spoken languages" },
  "voice.recommendations.browseAll": { defaultKeys: "o", description: "Browse all models" },
  "voice.models.ratingsHelp": { defaultKeys: "?", description: "Open the rating guide" },
  "voice.ratingsHelp.close": { defaultKeys: "q", description: "Close the rating guide" },
  "voice.scroll.top": { defaultKeys: "home", description: "Scroll to the top" },
  "voice.scroll.bottom": { defaultKeys: "end", description: "Scroll to the bottom" },
  "voice.tryIt.shortcut": { defaultKeys: "s", description: "Change the dictation shortcut" },
  "voice.tryIt.microphone": { defaultKeys: "m", description: "Change the microphone" },
  "voice.tryIt.model": { defaultKeys: "c", description: "Change the model" },
  "voice.shortcut.useDefault": { defaultKeys: "d", description: "Use the default shortcut" },
  "voice.dictation.cancel": { defaultKeys: "escape", description: "Cancel recording or transcription" },
  "voice.dictation.stop": { defaultKeys: "space", description: "Stop recording and transcribe" },
} as const satisfies KeybindingDefinitions;

export type VoiceKeybinding = keyof typeof VOICE_KEYBINDINGS;
/** A pi `tui.*` id or one of ours; callers never need to know which. */
export type KeyAction = Keybinding | VoiceKeybinding;

export function isVoiceKeybinding(id: string): id is VoiceKeybinding {
  return Object.hasOwn(VOICE_KEYBINDINGS, id);
}

// Our ids are not declaration-merged into pi's `Keybindings`, so pi's manager
// would silently accept them and never match. Route by table membership instead.
const asTuiId = (id: VoiceKeybinding): Keybinding => id as unknown as Keybinding;

/**
 * Before the Pi Voice rename our ids were `transcribe.*`. A user binding under
 * the old id still applies unless the matching `voice.*` id is also set.
 */
function withLegacyBindings(user: KeybindingsConfig): KeybindingsConfig {
  const bindings = { ...user };
  for (const id of Object.keys(VOICE_KEYBINDINGS)) {
    const legacy = user[id.replace(/^voice\./, "transcribe.")];
    if (bindings[id] === undefined && legacy !== undefined) bindings[id] = legacy;
  }
  return bindings;
}

function matchesLocalKey(data: string, key: KeyId): boolean {
  if (matchesKey(data, key)) return true;
  // Single printable keys also accept the shifted or caps-lock form and Kitty's
  // CSI-u report of the typed character, such as `?` arriving as shift+/.
  if (key.length !== 1) return false;
  const typed = data.length === 1 ? data : decodeKittyPrintable(data);
  return typed?.toLowerCase() === key;
}

/** The user's dictation shortcut is a runtime setting, not a table entry. */
export function matchesShortcut(data: string, shortcut: string): boolean {
  return matchesKey(data, shortcut as KeyId);
}

/**
 * One matcher and one hint formatter over pi's manager and our table.
 * Built per pane from the manager pi injects, so the user's bindings for both
 * apply. Construct it fresh rather than caching: pi's /reload swaps the user
 * bindings on its manager and the local copy is a snapshot.
 */
export class VoiceKeys {
  private readonly local: KeybindingsManager;

  constructor(readonly host: KeybindingsManager) {
    this.local = new KeybindingsManager(VOICE_KEYBINDINGS, withLegacyBindings(host.getUserBindings()));
  }

  matches(data: string, id: KeyAction): boolean {
    if (!isVoiceKeybinding(id)) return this.host.matches(data, id);
    return this.local.getKeys(asTuiId(id)).some((key) => matchesLocalKey(data, key));
  }

  keys(id: KeyAction): KeyId[] {
    return isVoiceKeybinding(id) ? this.local.getKeys(asTuiId(id)) : this.host.getKeys(id);
  }

  keyText(id: KeyAction | readonly KeyAction[]): string {
    const ids = Array.isArray(id) ? (id as readonly KeyAction[]) : [id as KeyAction];
    return ids.flatMap((each) => this.keys(each)).join("/");
  }

  hint(id: KeyAction | readonly KeyAction[], description: string): string {
    return rawKeyHint(this.keyText(id), description);
  }

  navLabel(): string {
    const up = this.keys("tui.select.up");
    const down = this.keys("tui.select.down");
    const arrows = up.includes("up") && down.includes("down");
    return arrows ? "↑↓" : `${up.join("/")}/${down.join("/")}`;
  }

  navHint(description: string): string {
    return rawKeyHint(this.navLabel(), description);
  }
}
