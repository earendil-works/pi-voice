import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAvailableMicrophones, type InputDevice, type Permission } from "./audio.js";
import type { MicrophoneSetting } from "./settings.js";
import { SingleSelectPicker, type SingleSelectChoice } from "./ui-components.js";

export function microphoneSummary(microphone: MicrophoneSetting): string {
  if (microphone.type === "system-default") return "System default";
  const duplicate = microphone.occurrence > 0 ? ` · device ${microphone.occurrence + 1}` : "";
  return `${microphone.name}${duplicate}`;
}

export function microphonesEqual(left: MicrophoneSetting, right: MicrophoneSetting): boolean {
  return (
    left.type === right.type &&
    (left.type === "system-default" ||
      (right.type === "device" &&
        left.name === right.name &&
        left.occurrence === right.occurrence))
  );
}

function microphoneChoices(
  devices: readonly InputDevice[],
  current: MicrophoneSetting,
): {
  choices: SingleSelectChoice<string>[];
  currentValue: string;
  byValue: Map<string, MicrophoneSetting>;
} {
  const totals = new Map<string, number>();
  for (const { name } of devices) totals.set(name, (totals.get(name) ?? 0) + 1);
  const byValue = new Map<string, MicrophoneSetting>();
  byValue.set("system-default", { type: "system-default" });
  const choices: SingleSelectChoice<string>[] = [
    {
      value: "system-default",
      label: "System default",
      description: "Follow the input device selected by the operating system",
    },
  ];
  let currentValue = "system-default";
  for (const [index, { name, occurrence }] of devices.entries()) {
    const microphone: MicrophoneSetting = { type: "device", name, occurrence };
    const value = `device-${index}`;
    const label = (totals.get(name) ?? 0) > 1 ? `${name} · device ${occurrence + 1}` : name;
    choices.push({ value, label });
    byValue.set(value, microphone);
    if (microphonesEqual(current, microphone)) currentValue = value;
  }
  return { choices, currentValue, byValue };
}

/** Nothing where the platform has no permission to report (Linux). */
export function microphonePermissionSummary(permission: Permission): string | undefined {
  if (permission === "granted") return "Microphone: ✓ Access granted";
  if (permission === "denied") return "Microphone: ✗ Access denied";
  if (permission === "not-determined") {
    return "Microphone: ⚠ Not yet requested — first recording will prompt for access";
  }
  return undefined;
}

export async function chooseMicrophone(
  ctx: ExtensionContext,
  current: MicrophoneSetting,
  permission: Permission,
): Promise<MicrophoneSetting | undefined> {
  let devices: InputDevice[] = [];
  try {
    devices = await getAvailableMicrophones();
  } catch (error) {
    ctx.ui.notify(
      `Could not list microphones: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
  const { choices, currentValue, byValue } = microphoneChoices(devices, current);
  const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    new SingleSelectPicker(
      tui,
      theme,
      keybindings,
      choices,
      currentValue,
      {
        title: "Choose microphone input",
        subtitle: microphonePermissionSummary(permission),
        searchable: choices.length > 8,
        cancelLabel: "back",
      },
      done,
    ),
  );
  return selected ? byValue.get(selected) : undefined;
}
