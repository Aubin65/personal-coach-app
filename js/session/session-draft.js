// ---------- Brouillon local de la séance en cours (ADR-0103) ----------
// La séance qu'on édite ne vit qu'en mémoire (`sessionRuntime.working`)
// tant qu'on n'a pas appuyé sur « Enregistrer » (la sauvegarde auto
// GitHub ne passe que toutes les 3 minutes, et seulement chrono lancé).
// Quitter l'écran, rafraîchir ou voir iOS recharger l'application après un
// passage en arrière-plan faisait donc perdre tout ce qui avait été saisi.
// Ce brouillon est écrit dans localStorage à chaque modification (et à la
// sortie de l'écran / de l'app), puis restauré à la réouverture. Il ne remplace
// pas l'enregistrement : il disparaît dès que la séance est enregistrée.
import { sessionRuntime } from "./session-state.js";
import { state } from "../nav.js";

const KEY = (date) => `coach_session_draft_${date}`;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const DEBOUNCE_MS = 300;

/** Empreinte rapide d'une séance telle que lue du serveur : sert seulement à
 * savoir si la version enregistrée a changé depuis la saisie du brouillon. */
export function sessionSig(session) {
  const text = JSON.stringify(session ?? null);
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

export function loadDraft(date) {
  try {
    const raw = localStorage.getItem(KEY(date));
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (!draft || !draft.session || Date.now() - draft.savedAt > MAX_AGE_MS) { localStorage.removeItem(KEY(date)); return null; }
    return draft;
  } catch (_) { return null; }
}

export function clearDraft(date) {
  try { localStorage.removeItem(KEY(date)); } catch (_) { /* rien à nettoyer */ }
}

/** Retire les brouillons trop anciens (appelé à l'ouverture d'une séance). */
export function pruneDrafts() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith("coach_session_draft_")).forEach((k) => {
      try { if (Date.now() - JSON.parse(localStorage.getItem(k)).savedAt > MAX_AGE_MS) localStorage.removeItem(k); } catch (_) { localStorage.removeItem(k); }
    });
  } catch (_) { /* confort seulement */ }
}

/** Écrit le brouillon de la séance ouverte — seulement si l'utilisateur y a
 * touché (une simple consultation ne laisse aucun brouillon). */
export function persistWorkingDraft({ sync = true } = {}) {
  const w = sessionRuntime.working;
  if (!w || !w.session || !w.touched || state.view !== "session") return;
  // Surcouche guidée ouverte : le formulaire dessous n'est pas la source.
  if (sync && !sessionRuntime.liveCleanup && sessionRuntime.syncForm) {
    try { sessionRuntime.syncForm(); } catch (_) { /* le dernier état connu suffit */ }
  }
  try {
    localStorage.setItem(KEY(w.date), JSON.stringify({ savedAt: Date.now(), remoteSig: w.remoteSig, weekLabel: w.weekLabel, session: w.session }));
  } catch (_) { /* stockage plein ou indisponible : le brouillon est un confort */ }
}

let timer = null;
/** À appeler après une modification utilisateur : écrit le brouillon peu après. */
export function touchSession() {
  const w = sessionRuntime.working;
  if (!w || !w.session) return;
  w.touched = true;
  clearTimeout(timer);
  timer = setTimeout(() => persistWorkingDraft(), DEBOUNCE_MS);
}

/** La séance vient d'être enregistrée (ou envoyée en file d'attente) : le
 * brouillon n'a plus de raison d'être, la version enregistrée fait foi. */
export function markSaved(date) {
  clearTimeout(timer);
  clearDraft(date);
  const w = sessionRuntime.working;
  if (w && w.date === date) {
    w.touched = false;
    w.remoteSig = sessionSig(w.session);
    w.draftNotice = null;
  }
}

// Sortie de l'écran (navigation) ou de l'app (arrière-plan, fermeture).
sessionRuntime.flushDraft = () => { clearTimeout(timer); persistWorkingDraft(); };
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") sessionRuntime.flushDraft(); });
  window.addEventListener("pagehide", () => sessionRuntime.flushDraft());
}

export function draftNoticeHTML(notice) {
  if (!notice) return "";
  const hhmm = new Date(notice.savedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const day = new Date(notice.savedAt).toDateString() === new Date().toDateString() ? "" : ` le ${new Date(notice.savedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}`;
  if (notice.kind === "restored") {
    return `<section class="card draft-notice"><p class="small"><strong>Brouillon restauré</strong> — saisi${day} à ${hhmm}, pas encore enregistré.</p>
      <div class="draft-notice-actions"><button type="button" class="primary-button ghost small" id="draft-discard">Revenir à la version enregistrée</button></div></section>`;
  }
  return `<section class="card draft-notice draft-conflict"><p class="small"><strong>Brouillon non enregistré${day} à ${hhmm}</strong> — la séance enregistrée a changé depuis (le coach ou un autre appareil).</p>
    <div class="draft-notice-actions"><button type="button" class="primary-button small" id="draft-restore">Reprendre mon brouillon</button><button type="button" class="primary-button ghost small" id="draft-discard">Ignorer</button></div></section>`;
}
