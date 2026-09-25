import { stopAllSessionTimers } from "./session/session-state.js";
import { renderToday } from "./views/today.js";
import { renderWeek } from "./views/week.js";
import { renderForge } from "./views/forge.js";
import { renderData } from "./views/data.js";
import { renderCalendar } from "./views/calendar.js";
import { renderChat } from "./views/chat.js";
import { renderSession } from "./session/session-render.js";
import { renderWriteNote } from "./views/write-note.js";
import { renderAdjustWeek } from "./views/adjust-week.js";
import { renderPain } from "./views/pain.js";
import { loadSyncStatus } from "./sync-status.js";

// ============================================================================
// App state / navigation
// ============================================================================
export const state = {
  view: "today",
  weekSubTab: "planning",
  sessionDate: null,
  forgeMonday: null,
  forgePrefillDraft: null,
  planningMonday: null,
  sessionReturnTo: null,
  // Bumped on every navigation; each async render function captures it and
  // checks `stale(token)` after an await before touching the DOM. Without
  // this, an async render that resolves after the user has already
  // navigated away writes into elements that either no longer exist
  // (`document.getElementById` returns null → "null is not an object"
  // crash, injected as stray red text into whatever view is now showing) or
  // are detached (silently invisible, e.g. a stuck-looking Historique).
  renderToken: 0,
};

export function stale(token) {
  return token !== state.renderToken;
}

const views = {
  today: { title: "Aujourd'hui", render: renderToday },
  week: { title: "Semaine", render: renderWeek },
  forge: { title: "Forge", render: renderForge },
  data: { title: "Data", render: renderData },
  calendar: { title: "Matchs", render: renderCalendar },
  chat: { title: "Coach", render: renderChat },
  session: { title: "Séance", render: renderSession },
  "write-note": { title: "Nouvelle note", render: renderWriteNote },
  "adjust-week": { title: "Ajuster ma semaine", render: renderAdjustWeek },
  pain: { title: "Douleur / gêne", render: renderPain },
};

/** `params.date` (ISO) targets the "session" view at an arbitrary date —
 * set from the Aujourd'hui quick action (today), a day-strip/Forge/
 * Historique tile. renderSession overwrites the topbar title itself once
 * it knows the date, so the generic title below is just the instant
 * placeholder while it loads. */
export function showView(name, params = {}) {
  state.renderToken += 1;
  const token = state.renderToken;
  // The session view's live timer interval targets #timer-display by id —
  // about to be wiped from the DOM below along with the rest of #content,
  // so it must stop now rather than keep ticking against a detached node.
  // The auto-save interval doesn't touch the DOM, but it must stop too —
  // it reads the working session, which the next view's render is about to
  // reassign/ignore, so a leaked tick would silently keep re-saving a
  // session the user has already navigated away from.
  stopAllSessionTimers();
  // Remember where a dive into a single session came from (day-strip,
  // Forge, Historique, the Séances table...) so the back arrow can return
  // there — direct request: "quand je plonge dans une séance j'aurais
  // besoin d'une flèche pour revenir à la page précédente". Only captured
  // on the way in (never session → session in practice), and only the
  // view name is needed since every other view already restores its own
  // state on its own (planningMonday, weekSubTab, etc.).
  if (name === "session" && state.view !== "session") state.sessionReturnTo = state.view;
  state.view = name;
  if (params.date) state.sessionDate = params.date;
  document.getElementById("topbar-title").textContent = views[name].title;
  const backBtn = document.getElementById("topbar-back");
  if (backBtn) backBtn.hidden = !(name === "session" && state.sessionReturnTo);
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  const content = document.getElementById("content");
  content.innerHTML = "";
  const tplId = "tpl-" + name;
  const tpl = document.getElementById(tplId);
  if (tpl) content.appendChild(tpl.content.cloneNode(true));
  views[name].render(token).catch((err) => {
    if (stale(token)) return; // navigated on already — don't inject a stray error into whatever's showing now
    content.insertAdjacentHTML("afterbegin", `<p class="error-text">${err.message}</p>`);
  });
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

document.getElementById("topbar-back").addEventListener("click", () => {
  if (state.sessionReturnTo) showView(state.sessionReturnTo);
});

document.getElementById("refresh-button").addEventListener("click", (e) => {
  e.currentTarget.classList.add("spinning");
  showView(state.view);
  loadSyncStatus();
  setTimeout(() => e.currentTarget.classList.remove("spinning"), 800);
});
