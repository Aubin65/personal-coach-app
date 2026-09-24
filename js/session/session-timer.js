import { sessionRuntime } from "./session-state.js";
import { syncFormIntoSession, saveSession } from "./session-form.js";

// ---------- Timer de séance ("Lancer"/"Terminer") ----------
// localStorage uniquement — un pur confort de ce navigateur, jamais relu
// par le coach ni par un autre appareil (voir la note sur le stockage
// navigateur) : l'instant de départ n'a besoin de survivre qu'à un
// verrouillage/passage en arrière-plan du téléphone pendant la séance,
// pas de se synchroniser où que ce soit. Une seule séance à la fois par
// date suffit largement en pratique.
export function getSessionTimerStart(date) {
  try { return localStorage.getItem(`coach_session_timer_${date}`); } catch (_) { return null; }
}
export function setSessionTimerStart(date, iso) {
  try {
    if (iso) localStorage.setItem(`coach_session_timer_${date}`, iso);
    else localStorage.removeItem(`coach_session_timer_${date}`);
  } catch (_) { /* stockage indisponible — le timer tourne quand même pour ce rendu, juste pas persistant */ }
}

export function formatDurationMs(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatElapsed(startedAtIso) {
  return formatDurationMs(Date.now() - new Date(startedAtIso).getTime());
}

/** "Lancer la séance" démarre un timer visible en permanence (sticky en
 * haut, même en défilant) qui remplit automatiquement `session_duration_
 * min` à "Terminer la séance" — la durée exacte plutôt qu'estimée après
 * coup, avec confirmation pour éviter de perdre le temps en cours sur un
 * appui accidentel. La saisie manuelle du champ durée plus bas
 * (workloadSectionHTML) reste toujours possible en parallèle — oubli
 * d'arrêt du timer, ou simplement ne pas s'en servir du tout. */
export function timerBarHTML(date) {
  const startedAt = getSessionTimerStart(date);
  if (!startedAt) {
    return `
      <section class="card timer-card">
        <button type="button" id="start-timer" class="primary-button">▶️ Lancer la séance</button>
      </section>`;
  }
  return `
    <section class="card timer-card timer-running" id="timer-bar">
      <div class="timer-running-info">
        <div class="timer-label">Séance en cours</div>
        <div class="timer-display" id="timer-display">${formatElapsed(startedAt)}</div>
      </div>
      <button type="button" id="stop-timer" class="timer-stop-button">⏹ Terminer</button>
    </section>`;
}

/** Redémarré à chaque rendu de la séance (`renderSessionContent` tourne
 * souvent — ajout d'exercice, changement de format...) : plus simple et
 * plus sûr que d'essayer de faire survivre un seul intervalle à travers
 * des re-rendus qui remplacent le DOM sous ses pieds. */
export function startTimerDisplayInterval() {
  if (sessionRuntime.timerIntervalId) {
    clearInterval(sessionRuntime.timerIntervalId);
    sessionRuntime.timerIntervalId = null;
  }
  const startedAt = getSessionTimerStart(sessionRuntime.working.date);
  if (!startedAt || !document.getElementById("timer-display")) return;
  sessionRuntime.timerIntervalId = setInterval(() => {
    const displayEl = document.getElementById("timer-display");
    if (!displayEl) {
      clearInterval(sessionRuntime.timerIntervalId);
      sessionRuntime.timerIntervalId = null;
      return;
    }
    displayEl.textContent = formatElapsed(startedAt);
  }, 1000);
}

// ---------- Sauvegarde automatique pendant la séance ----------
// Filet de sécurité pour la durée de la séance chronométrée : un
// verrouillage de téléphone prolongé, un crash de l'onglet ou un simple
// oubli d'appuyer sur "Enregistrer" avant de partir ne doivent pas faire
// perdre tout le log en cours. Se déclenche silencieusement en tâche de
// fond tant que le timer tourne ; le bouton "Enregistrer la séance"
// manuel reste le mécanisme principal, celui-ci ne fait que réduire la
// fenêtre de perte possible.
const SESSION_AUTOSAVE_INTERVAL_MS = 3 * 60 * 1000;

/** Redémarré à chaque rendu, même logique que startTimerDisplayInterval —
 * s'arrête tout seul (et ne redémarre pas) dès que le timer n'est plus en
 * cours pour cette date, donc un simple appel après chaque
 * renderSessionContent suffit à suivre l'état démarré/arrêté sans logique
 * séparée. */
export function startSessionAutoSave() {
  if (sessionRuntime.autoSaveIntervalId) {
    clearInterval(sessionRuntime.autoSaveIntervalId);
    sessionRuntime.autoSaveIntervalId = null;
  }
  if (!getSessionTimerStart(sessionRuntime.working.date)) return;
  sessionRuntime.autoSaveIntervalId = setInterval(async () => {
    // Ne rentre jamais en conflit avec une sauvegarde manuelle déjà en
    // cours (double écriture concurrente sur le même fichier) — retentera
    // simplement au prochain intervalle.
    if (sessionRuntime.saveInFlight) return;
    if (!getSessionTimerStart(sessionRuntime.working.date)) return; // séance terminée entre-temps
    syncFormIntoSession();
    sessionRuntime.saveInFlight = true;
    try {
      await saveSession(sessionRuntime.working.weekLabel, sessionRuntime.working.date, sessionRuntime.working.session);
      const statusEl = document.getElementById("session-status");
      if (statusEl) {
        const hhmm = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        statusEl.textContent = `Sauvegarde auto ✓ ${hhmm}`;
      }
    } catch (_) {
      // Échec silencieux — pas d'alerte intrusive pendant une séance en
      // cours, le prochain intervalle retentera de lui-même ; "Enregistrer
      // la séance" reste disponible à tout moment en filet de secours.
    } finally {
      sessionRuntime.saveInFlight = false;
    }
  }, SESSION_AUTOSAVE_INTERVAL_MS);
}

// ---------- Chrono par tour (blocs EMOM/Circuit) ----------
// Un chrono secondaire optionnel, par bloc — le timer de séance ci-dessus
// ne donne qu'un total, pas le détail utile pour un EMOM/circuit ("le
// 3e tour a traîné, pas le 1er"). localStorage uniquement, même
// convention que le timer de séance ; clé par date+leaderIdx puisque
// plusieurs blocs EMOM/circuit peuvent coexister dans une même séance.
// À l'arrêt, un résumé texte des tours est ajouté aux notes du bloc
// (jamais dans coach.tonnage — même principe que le reste de ce format de
// bloc, voir docs/adr/0036/0038 : rien d'assez fiable ici pour en faire
// une donnée de suivi chiffrée, mais utile à relire pour voir si ça
// s'améliore d'une séance à l'autre).
export function blockTimerKey(date, leaderIdx) {
  return `coach_block_timer_${date}_${leaderIdx}`;
}
export function getBlockTimerState(date, leaderIdx) {
  try {
    const raw = localStorage.getItem(blockTimerKey(date, leaderIdx));
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
export function setBlockTimerState(date, leaderIdx, stateObj) {
  try {
    const key = blockTimerKey(date, leaderIdx);
    if (stateObj) localStorage.setItem(key, JSON.stringify(stateObj));
    else localStorage.removeItem(key);
  } catch (_) { /* stockage indisponible — le bouton reste utilisable, juste pas persistant */ }
}

export function splitTimerHTML(leaderIdx, date) {
  const bt = getBlockTimerState(date, leaderIdx);
  if (!bt) {
    return `
      <div class="split-timer-card">
        <button type="button" class="primary-button ghost small split-timer-start" data-leader-idx="${leaderIdx}">⏱️ Chrono par tour</button>
      </div>`;
  }
  const lapsHTML = bt.laps.length
    ? `<div class="split-timer-laps">${bt.laps.map((ms, i) => `<span>Tour ${i + 1} : ${formatDurationMs(ms)}</span>`).join("")}</div>`
    : "";
  return `
    <div class="split-timer-card split-timer-running">
      <div class="split-timer-row">
        <div class="split-timer-current">
          Tour ${bt.laps.length + 1} en cours
          <span class="split-timer-display" data-leader-idx="${leaderIdx}">${formatElapsed(bt.lastLapAt)}</span>
        </div>
        <div class="split-timer-buttons">
          <button type="button" class="primary-button small split-timer-lap" data-leader-idx="${leaderIdx}">✓ Tour terminé</button>
          <button type="button" class="icon-button small danger split-timer-stop" data-leader-idx="${leaderIdx}" title="Arrêter le chrono par tour" aria-label="Arrêter le chrono par tour">⏹</button>
        </div>
      </div>
      ${lapsHTML}
    </div>`;
}

/** Un intervalle par bloc dont le chrono-tours tourne, redémarré à chaque
 * rendu — même logique que startTimerDisplayInterval/startSessionAutoSave
 * (plus simple que de faire survivre des intervalles à travers des
 * re-rendus qui remplacent le DOM sous leurs pieds). */
export function startBlockTimerIntervals() {
  Object.values(sessionRuntime.blockTimerIntervalIds).forEach((id) => clearInterval(id));
  sessionRuntime.blockTimerIntervalIds = {};
  document.querySelectorAll(".split-timer-display[data-leader-idx]").forEach((displayEl) => {
    const leaderIdx = displayEl.dataset.leaderIdx;
    const bt = getBlockTimerState(sessionRuntime.working.date, +leaderIdx);
    if (!bt) return;
    sessionRuntime.blockTimerIntervalIds[leaderIdx] = setInterval(() => {
      const el = document.querySelector(`.split-timer-display[data-leader-idx="${leaderIdx}"]`);
      if (!el) {
        clearInterval(sessionRuntime.blockTimerIntervalIds[leaderIdx]);
        delete sessionRuntime.blockTimerIntervalIds[leaderIdx];
        return;
      }
      el.textContent = formatElapsed(bt.lastLapAt);
    }, 1000);
  });
}
