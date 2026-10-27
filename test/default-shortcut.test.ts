import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultShortcut,
  FALLBACK_SHORTCUT,
  hasMultipleInputSources,
  PREFERRED_SHORTCUT,
} from "../src/default-shortcut.js";

// Captured from `defaults read com.apple.HIToolbox AppleEnabledInputSources`.
const usLayout = `
    {
        InputSourceKind = "Keyboard Layout";
        "KeyboardLayout ID" = 0;
        "KeyboardLayout Name" = "U.S.";
    },`;
const nonKeyboard = `
    {
        "Bundle ID" = "com.apple.CharacterPaletteIM";
        InputSourceKind = "Non Keyboard Input Method";
    },
    {
        "Bundle ID" = "com.apple.PressAndHold";
        InputSourceKind = "Non Keyboard Input Method";
    },`;
const pinyin = `
    {
        "Bundle ID" = "com.apple.inputmethod.SCIM";
        "Input Mode" = "com.apple.inputmethod.SCIM.ITABC";
        InputSourceKind = "Input Mode";
    },`;
const squirrel = `
    {
        "Bundle ID" = "im.rime.inputmethod.Squirrel";
        InputSourceKind = "Keyboard Input Method";
    },`;
const list = (...entries: string[]) => `(${entries.join("")}\n)`;

test("a lone layout with non-keyboard entries leaves Ctrl+Space free", () => {
  assert.equal(hasMultipleInputSources(list(usLayout, nonKeyboard)), false);
});

test("a layout plus an input mode or input method is switchable", () => {
  assert.equal(hasMultipleInputSources(list(usLayout, nonKeyboard, pinyin)), true);
  assert.equal(hasMultipleInputSources(list(usLayout, squirrel)), true);
});

test("Linux keeps Ctrl+Space unless fcitx is the input method", () => {
  assert.equal(defaultShortcut("linux", {}), PREFERRED_SHORTCUT);
  assert.equal(defaultShortcut("linux", { XMODIFIERS: "@im=ibus", GTK_IM_MODULE: "ibus" }), PREFERRED_SHORTCUT);
  assert.equal(defaultShortcut("linux", { XMODIFIERS: "@im=fcitx" }), FALLBACK_SHORTCUT);
  assert.equal(defaultShortcut("linux", { QT_IM_MODULE: "fcitx5" }), FALLBACK_SHORTCUT);
});
