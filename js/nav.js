import { stopAllSessionTimers } from "./session/session-state.js";
import { renderToday } from "./views/today.js";
import { renderWeek } from "./views/week.js";
import { renderForge } from "./views/forge.js";
import { renderForgeBloc } from "./views/forge-bloc.js";
import { renderData } from "./views/data.js";
import { renderCalendar } from "./views/calendar.js";
import { renderChat } from "./views/chat.js";
import { renderSession } from "./session/session-render.js";
import { renderWriteNote } from "./views/write-note.js";
import { renderAdjustWeek } from "./views/adjust-week.js";
import { renderPain } from "./views/pain.js";
import { renderSettings } from "./views/settings.js";
import { loadSyncStatus } from "./sync-status.js";
import { openAddSheet } from "./add-sheet.js";
import { invalidateDataCaches } from "./training-index.js";

// ============================================================================
// App state / navigation
// ============================================================================
export const state = {
  view: "today",
  weekSubTab: "planning",
  sessionDate: null,
  forgeMonday: null,
  forgePrefillDraft: null,
  forgeBlocLabel: null,
  planningMonday: null,
  sessionReturnTo: null,
  settingsReturnTo: null,
  openLiveOnLoad: false, // « Démarrer » d'Aujourd'hui : ouvrir la séance guidée dès le rendu (ADR-0076)
  adjustPrefill: null, // « Adapter » d'Aujourd'hui : texte de départ d'« Ajuster ma semaine » (ADR-0076)
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
  week: { title: "Plan", render: renderWeek },
  forge: { title: "Plan", render: renderForge },
  "forge-bloc": { title: "Forge de bloc", render: renderForgeBloc },
  data: { title: "Progrès", render: renderData },
  calendar: { title: "Plan", render: renderCalendar },
  chat: { title: "Coach", render: renderChat },
  session: { title: "Séance", render: renderSession },
  "write-note": { title: "Nouvelle note", render: renderWriteNote },
  "adjust-week": { title: "Ajuster ma semaine", render: renderAdjustWeek },
  pain: { title: "Douleur / gêne", render: renderPain },
  settings: { title: "Réglages", render: renderSettings },
};

// Barre du bas à 4 onglets (docs/adr/0071) : plusieurs vues partagent un
// même onglet. Semaine, Forge et Matchs vivent sous « Plan » (avec la sous-
// navigation #plan-switch) ; les vues de saisie ouvertes depuis le bouton +
// (séance, note, douleur, ajustement) n'allument aucun onglet.
const TAB_FOR_VIEW = {
  today: "today",
  week: "week",
  forge: "week",
  "forge-bloc": "week",
  calendar: "week",
  data: "data",
  chat: "chat",
};
const PLAN_VIEWS = new Set(["week", "forge", "calendar"]);

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
  if (name === "settings" && state.view !== "settings") state.settingsReturnTo = state.view;
  state.view = name;
  if (params.date) state.sessionDate = params.date;
  document.getElementById("topbar-title").textContent = views[name].title;
  const backBtn = document.getElementById("topbar-back");
  if (backBtn) backBtn.hidden = !((name === "session" && state.sessionReturnTo) || (name === "settings" && state.settingsReturnTo));
  const settingsBtn = document.getElementById("settings-button");
  if (settingsBtn) settingsBtn.classList.toggle("active", name === "settings");
  const activeTab = TAB_FOR_VIEW[name];
  document.querySelectorAll(".nav-item").forEach((btn) => {
    const on = btn.dataset.view === activeTab;
    btn.classList.toggle("active", on);
    if (on) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  const planSwitch = document.getElementById("plan-switch");
  if (planSwitch) {
    planSwitch.hidden = !PLAN_VIEWS.has(name);
    planSwitch.querySelectorAll(".plan-switch-item").forEach((btn) => {
      // Semaine / Bloc / Historique sont trois sous-onglets de la vue week ;
      // la Forge (ouverte par « Modifier ») reste rattachée à Semaine.
      const on = btn.dataset.subtab
        ? (name === "week" && btn.dataset.subtab === state.weekSubTab) || (name === "forge" && btn.dataset.subtab === "planning")
        : btn.dataset.view === name;
      btn.classList.toggle("active", on);
    });
  }
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

document.querySelectorAll(".nav-item, .plan-switch-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.subtab) state.weekSubTab = btn.dataset.subtab;
    showView(btn.dataset.view);
  });
});

document.getElementById("nav-add-button").addEventListener("click", openAddSheet);

document.getElementById("topbar-back").addEventListener("click", () => {
  if (state.view === "settings") { showView(state.settingsReturnTo || "today"); return; }
  if (state.sessionReturnTo) showView(state.sessionReturnTo);
});

document.getElementById("settings-button").addEventListener("click", () => {
  if (state.view === "settings") showView(state.settingsReturnTo || "today");
  else showView("settings");
});

function refreshCurrentView() {
  const btn = document.getElementById("refresh-button");
  btn.classList.add("spinning");
  invalidateDataCaches();
  showView(state.view);
  loadSyncStatus();
  setTimeout(() => btn.classList.remove("spinning"), 800);
}
document.getElementById("refresh-button").addEventListener("click", refreshCurrentView);

// Tirer pour rafraîchir (ADR-0092) : sur téléphone, le bouton ⟳ est masqué
// (CSS, pointeur tactile) — tirer l'écran vers le bas depuis le haut du
// contenu recharge la vue. Pas pendant une séance guidée ni dans un champ.
(function setupPullToRefresh() {
  const content = document.getElementById("content");
  const hint = document.createElement("div");
  hint.className = "ptr-hint";
  hint.setAttribute("aria-hidden", "true");
  document.body.appendChild(hint);
  const THRESHOLD = 70;
  let startY = null;
  let pulled = 0;
  content.addEventListener("touchstart", (e) => {
    const inField = e.target.closest && e.target.closest("input, textarea, select, .sheet");
    startY = content.scrollTop <= 0 && !inField && e.touches.length === 1 ? e.touches[0].clientY : null;
    pulled = 0;
  }, { passive: true });
  content.addEventListener("touchmove", (e) => {
    if (startY == null) return;
    pulled = e.touches[0].clientY - startY;
    if (pulled <= 10 || content.scrollTop > 0) { hint.classList.remove("visible", "ready"); return; }
    hint.textContent = pulled > THRESHOLD ? "Relâche pour rafraîchir" : "Tire pour rafraîchir";
    hint.classList.add("visible");
    hint.classList.toggle("ready", pulled > THRESHOLD);
  }, { passive: true });
  content.addEventListener("touchend", () => {
    if (startY != null && pulled > THRESHOLD && content.scrollTop <= 0) refreshCurrentView();
    startY = null;
    pulled = 0;
    hint.classList.remove("visible", "ready");
  });
})();
