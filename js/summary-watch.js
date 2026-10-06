import { ghGetFile } from "./github-api.js";
import { state, showView } from "./nav.js";
import { loadSyncStatus } from "./sync-status.js";
import { invalidateDataCaches } from "./training-index.js";

// ============================================================================
// Tableaux de bord à jour (docs/adr/0097). Le résumé `data/app/summary.json`
// est recalculé côté GitHub à chaque nouvelle donnée (workflow
// refresh-summary.yml, ~1-2 min) ; l'app le revérifie (requête conditionnelle
// ETag, quasi gratuite) toutes les minutes tant qu'elle est au premier plan et
// à chaque retour dessus. S'il a changé :
// - écran de consultation et en haut de page → rafraîchi tout seul ;
// - sinon (lecture en cours plus bas, saisie) → bandeau « Actualiser ».
// Jamais de rafraîchissement automatique pendant une séance ou une saisie.
// ============================================================================

const AUTO_VIEWS = new Set(["today", "data", "week", "calendar", "settings"]);
const CHECK_EVERY_MS = 60 * 1000;

let knownSha = null;
let timer = null;

function banner() {
  let el = document.getElementById("summary-banner");
  if (!el) {
    el = document.createElement("button");
    el.type = "button";
    el.id = "summary-banner";
    el.className = "summary-banner";
    el.textContent = "Nouvelles données · Actualiser";
    el.addEventListener("click", () => {
      el.hidden = true;
      showView(state.view);
    });
    document.body.appendChild(el);
  }
  return el;
}

/** Pur : rafraîchir seul, proposer, ou ne rien faire. */
export function refreshDecision({ view, scrollTop, typing, overlayOpen }) {
  if (!AUTO_VIEWS.has(view)) return "banner";
  if (typing || overlayOpen || scrollTop > 40) return "banner";
  return "auto";
}

export async function checkSummary() {
  if (document.visibilityState !== "visible") return;
  let file;
  try { file = await ghGetFile("data/app/summary.json"); } catch (_) { return; }
  if (!file || !file.sha) return;
  if (knownSha === null) { knownSha = file.sha; return; }
  if (file.sha === knownSha) return;
  knownSha = file.sha;
  invalidateDataCaches();
  loadSyncStatus();
  const active = document.activeElement;
  const decision = refreshDecision({
    view: state.view,
    scrollTop: (document.getElementById("content") || {}).scrollTop || 0,
    typing: !!(active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)),
    overlayOpen: !!document.querySelector(".sheet-overlay, .raw-editor"),
  });
  if (decision === "auto") {
    const b = document.getElementById("summary-banner");
    if (b) b.hidden = true;
    showView(state.view);
  } else {
    banner().hidden = false;
  }
}

export function startSummaryWatch() {
  checkSummary();
  clearInterval(timer);
  timer = setInterval(checkSummary, CHECK_EVERY_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkSummary(); });
}
