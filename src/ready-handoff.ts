// ctx.reload() clears widgets, so setup asks the next instance to show Ready.
// Reload re-evaluates the extension in the same process; a global symbol survives it.
const READY_AFTER_RELOAD = Symbol.for("pi-voice.readyAfterReload");

type Handoff = { [READY_AFTER_RELOAD]?: true };

export function requestReadyAfterReload(): void {
  (globalThis as Handoff)[READY_AFTER_RELOAD] = true;
}

export function takeReadyRequest(): boolean {
  const requested = (globalThis as Handoff)[READY_AFTER_RELOAD] === true;
  delete (globalThis as Handoff)[READY_AFTER_RELOAD];
  return requested;
}
