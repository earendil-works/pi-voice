import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  parseKey,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { defaultShortcut } from "./default-shortcut.js";
import { displayShortcut, normalizeShortcut } from "./shortcut-core.js";
import { VoiceKeys } from "./keybindings.js";
import { panelBorder } from "./ui-components.js";

type UiTheme = ExtensionContext["ui"]["theme"];
type Conflict = { description: string };
type Phase =
  | { kind: "waiting" }
  | { kind: "preview"; normalized: string; conflicts: Conflict[] }
  | { kind: "error"; message: string };

// Pi exposes its resolved built-in bindings here, but not shortcuts owned by
// other extensions. Pi reports those collisions when it reloads.
function findConflicts(kb: KeybindingsManager, shortcut: string): Conflict[] {
  const resolved = kb.getResolvedBindings();
  const result: Conflict[] = [];
  for (const [id, keys] of Object.entries(resolved)) {
    if (keys === undefined) continue;
    const keyList: string[] = Array.isArray(keys) ? keys : [keys];
    if (keyList.includes(shortcut)) {
      const def = kb.getDefinition(id as never);
      if (def?.description) result.push({ description: def.description });
    }
  }
  return result;
}

export function createShortcutPicker(
  tui: TUI,
  theme: UiTheme,
  keybindings: KeybindingsManager,
  current: string,
  done: (shortcut: string | undefined) => void,
): Component {
  const keys = new VoiceKeys(keybindings);
  const defaultKey = defaultShortcut();
  let phase: Phase = { kind: "waiting" };
  const container = new Container();

  function rebuild(): void {
    container.clear();
    container.addChild(panelBorder(theme));
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Record keyboard shortcut")), 1, 0),
    );
    container.addChild(
      new Text(theme.fg("muted", `Current: ${displayShortcut(current)}`), 1, 0),
    );
    container.addChild(new Spacer(1));

    if (phase.kind === "preview") {
      container.addChild(
        new Text(theme.fg("accent", displayShortcut(phase.normalized)), 1, 0),
      );
      if (phase.conflicts.length > 0) {
        container.addChild(
          new Text(
            theme.fg(
              "warning",
              `Built-in conflict: ${phase.conflicts.map((conflict) => conflict.description).join(", ")}. Pi may override or reject this shortcut.`,
            ),
            1,
            0,
          ),
        );
      }
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          `${keys.hint("tui.select.confirm", "keep")}  ${keys.hint("voice.shortcut.useDefault", "default")}  ${theme.fg("dim", "press another shortcut to replace")}  ${keys.hint("tui.select.cancel", "back")}`,
          1,
          0,
        ),
      );
    } else {
      if (phase.kind === "error") {
        container.addChild(new Text(theme.fg("error", phase.message), 1, 0));
        container.addChild(new Spacer(1));
      }
      container.addChild(
        new Text(theme.fg("muted", "Press a key combination…"), 1, 0),
      );
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          `${keys.hint("voice.shortcut.useDefault", `default (${displayShortcut(defaultKey)})`)}  ${keys.hint("tui.select.cancel", "back")}`,
          1,
          0,
        ),
      );
    }

    container.addChild(new Spacer(1));
    container.addChild(panelBorder(theme));
  }

  rebuild();

  return {
    wantsKeyRelease: false,

    render(width: number): string[] {
      return container.render(width).map((line) => truncateToWidth(line, width, ""));
    },

    handleInput(data: string): void {
      if (keys.matches(data, "tui.select.cancel")) {
        done(undefined);
        return;
      }

      if (keys.matches(data, "tui.select.confirm")) {
        if (phase.kind === "preview") done(phase.normalized);
        return;
      }

      if (keys.matches(data, "voice.shortcut.useDefault")) {
        phase = {
          kind: "preview",
          normalized: defaultKey,
          conflicts: findConflicts(keybindings, defaultKey),
        };
        rebuild();
        tui.requestRender();
        return;
      }

      const parsed = parseKey(data);
      if (!parsed) return;

      const normalized = normalizeShortcut(parsed);
      if (!normalized) {
        phase = {
          kind: "error",
          message: `${displayShortcut(parsed)} is not valid. Use a modifier such as Ctrl or Alt, or a function key.`,
        };
      } else {
        phase = {
          kind: "preview",
          normalized,
          conflicts: findConflicts(keybindings, normalized),
        };
      }
      rebuild();
      tui.requestRender();
    },

    invalidate(): void {
      rebuild();
    },
  };
}
