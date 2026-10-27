// Setup that saves a new shortcut ends in ctx.reload(), which clears every
// extension widget, so the instance that finished setup cannot show Ready
// itself. Pi re-evaluates the extension in the same process, so a global keyed
// by a registry symbol carries the request to the instance that starts next.
const READY_AFTER_RELOAD = Symbol.for("pi-voice.readyAfterReload");

type Handoff = { [READY_AFTER_RELOAD]?: true };

export function requestReadyAfterReload(): void {
  (globalThis as Handoff)[READY_AFTER_RELOAD] = true;
}

/** Reports whether Ready was requested, and clears the request. */
export function takeReadyRequest(): boolean {
  const requested = (globalThis as Handoff)[READY_AFTER_RELOAD] === true;
  delete (globalThis as Handoff)[READY_AFTER_RELOAD];
  return requested;
}
