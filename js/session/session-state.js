// Mutable runtime shared across the session/* modules — a plain object
// (not separate `let` bindings) so every module can import the same
// `sessionRuntime` reference and mutate its properties directly; ES module
// imports are live bindings for the *name* `sessionRuntime`, but re-
// assigning a bare `let sessionWorking = ...` from another module isn't
// possible, so the mutable state lives on properties of one shared object
// instead. `nav.js`'s `showView` calls `stopAllSessionTimers()` on every
// navigation so a leaked interval never keeps ticking (and re-saving)
// against a session the user has already left.
export const sessionRuntime = {
  working: null, // in-memory copy of the session being edited — nothing is written to GitHub before "Enregistrer la séance"
  timerIntervalId: null,
  autoSaveIntervalId: null,
  saveInFlight: false,
  blockTimerIntervalIds: {},
};

export function stopAllSessionTimers() {
  if (sessionRuntime.timerIntervalId) {
    clearInterval(sessionRuntime.timerIntervalId);
    sessionRuntime.timerIntervalId = null;
  }
  if (sessionRuntime.autoSaveIntervalId) {
    clearInterval(sessionRuntime.autoSaveIntervalId);
    sessionRuntime.autoSaveIntervalId = null;
  }
  Object.values(sessionRuntime.blockTimerIntervalIds).forEach((id) => clearInterval(id));
  sessionRuntime.blockTimerIntervalIds = {};
}
