/** Widget slot shared by the startup status and the recording meter. */
export const STATUS_WIDGET_KEY = "pi-voice-meter";

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const SPECIAL_KEYS = new Set([
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
]);
const SYMBOL_KEYS = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/"]);

export function normalizeShortcut(input: string): string | undefined {
  const parts = input
    .trim()
    .toLowerCase()
    .replaceAll("option", "alt")
    .replaceAll("command", "super")
    .replaceAll("cmd", "super")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  if (new Set(modifiers).size !== modifiers.length) return undefined;
  if (
    modifiers.some(
      (modifier) =>
        !MODIFIER_ORDER.includes(modifier as (typeof MODIFIER_ORDER)[number]),
    )
  ) {
    return undefined;
  }

  const isLetter = /^[a-z]$/.test(key);
  const isDigit = /^\d$/.test(key);
  const isFunction = /^f(?:[1-9]|1[0-2])$/.test(key);
  const isSpecial = SPECIAL_KEYS.has(key);
  const isSymbol = SYMBOL_KEYS.has(key);
  if (!isLetter && !isDigit && !isFunction && !isSpecial && !isSymbol) return undefined;

  // Bare printable keys would make normal editor input impossible.
  if (modifiers.length === 0 && !isFunction) return undefined;
  // Shift-only printable keys are also normal text input.
  if (
    modifiers.length === 1 &&
    modifiers[0] === "shift" &&
    (isLetter || isDigit || isSymbol)
  ) {
    return undefined;
  }

  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  return [
    ...ordered,
    key === "pageup" ? "pageUp" : key === "pagedown" ? "pageDown" : key,
  ].join("+");
}

export function displayShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => {
      if (process.platform === "darwin" && part.toLowerCase() === "alt") return "Option";
      return part.length === 1
        ? part.toUpperCase()
        : `${part[0]?.toUpperCase()}${part.slice(1)}`;
    })
    .join("+");
}
