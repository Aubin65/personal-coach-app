import { openSheet } from "./sheet.js";
import { escapeHtmlText } from "./markdown.js";

// ============================================================================
// Saisie rapide du RPE (docs/adr/0070) — deux touches : un chiffre 0-10 et
// une durée (déjà remplie par le chrono quand il a tourné). Les mêmes repères
// que la table d'aide du formulaire de séance, pour que "dur" donne le même
// chiffre ici que partout ailleurs. Un jour sans RPE ni durée ne compte pas
// dans la charge aiguë:chronique : c'est la donnée qui manquait le plus.
// ============================================================================

const RPE_DESCRIPTIONS = {
  0: "Repos, très très léger",
  1: "Repos, très très léger (mobilité, marche)",
  2: "Facile, tranquille — tu peux tenir une conversation",
  3: "Facile, tranquille — tu peux tenir une conversation",
  4: "Modéré — respiration marquée mais contrôlée",
  5: "Modéré à soutenu — respiration marquée mais contrôlée",
  6: "Soutenu — respiration marquée mais contrôlée",
  7: "Difficile — ça tire, peu de réserve en fin de séance",
  8: "Difficile — ça tire, peu de réserve en fin de séance",
  9: "Très difficile — proche de l'échec sur les derniers efforts",
  10: "Maximal — tout donné, rien en réserve",
};
const DURATION_SHORTCUTS = [30, 45, 60, 75, 90, 105, 120];

/** Résout `{rpe, duration}` à la validation, `null` si l'utilisateur ferme
 * ("Plus tard", croix, tap à côté). */
export function openRpeSheet({ title, defaultRpe = null, defaultDuration = null }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const rpeChips = Array.from({ length: 11 }, (_, n) => `<button type="button" class="suggestion-chip rpe-chip${defaultRpe === n ? " active" : ""}" data-rpe="${n}">${n}</button>`).join("");
    const durationChips = DURATION_SHORTCUTS.map((m) => `<button type="button" class="suggestion-chip duration-chip" data-minutes="${m}">${m}</button>`).join("");
    const { el, close } = openSheet(
      `
      <h2>${escapeHtmlText(title)}</h2>
      <p class="small rpe-sheet-title">Comment c'était ? (RPE)</p>
      <div class="suggestion-chips rpe-chips">${rpeChips}</div>
      <p class="muted small rpe-description">${defaultRpe != null ? RPE_DESCRIPTIONS[defaultRpe] : "Touche un chiffre — 0 = repos, 10 = maximal."}</p>
      <p class="small rpe-sheet-title">Durée (min)</p>
      <div class="suggestion-chips">${durationChips}</div>
      <input type="number" class="rpe-duration-input" min="1" step="1" inputmode="numeric" placeholder="ou une autre durée" value="${defaultDuration ?? ""}">
      <div class="proposal-actions">
        <button type="button" class="primary-button ghost small rpe-later">Plus tard</button>
        <button type="button" class="primary-button small rpe-confirm">✅ Valider</button>
      </div>
      <p class="muted small rpe-status"></p>`,
      { onClose: () => finish(null) },
    );

    const descEl = el.querySelector(".rpe-description");
    const durationInput = el.querySelector(".rpe-duration-input");
    const statusEl = el.querySelector(".rpe-status");
    let rpe = defaultRpe;

    el.querySelectorAll(".rpe-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        rpe = Number(chip.dataset.rpe);
        el.querySelectorAll(".rpe-chip").forEach((c) => c.classList.toggle("active", c === chip));
        descEl.textContent = RPE_DESCRIPTIONS[rpe];
      });
    });
    el.querySelectorAll(".duration-chip").forEach((chip) => {
      chip.addEventListener("click", () => { durationInput.value = chip.dataset.minutes; });
    });
    el.querySelector(".rpe-later").addEventListener("click", close);
    el.querySelector(".rpe-confirm").addEventListener("click", () => {
      const duration = Number(durationInput.value);
      if (rpe == null) { statusEl.textContent = "Choisis d'abord un RPE."; return; }
      if (!duration || duration < 1) { statusEl.textContent = "Indique aussi la durée en minutes."; return; }
      finish({ rpe, duration: Math.round(duration) });
      close();
    });
  });
}
