import { escapeAttr } from "../markdown.js";

// ---------- Fait : charge + reps/temps + RIR par série, sans les taper
// à la main avec des tirets ----------
// `coach.tonnage._total_reps` et le RIR (voir `coaching-guidelines.md`,
// "RIR structuré") acceptent déjà un texte à tirets par série
// ("10-8-8-6") en plus d'une valeur unique — cette convention de
// stockage ne change pas, seule la façon de la remplir change : une
// ligne par série avec ses trois valeurs ensemble plutôt que des champs
// texte séparés à composer à la main. La charge, elle, n'est pas encore
// supportée à tirets côté Python (`_load_kg` n'accepte qu'une valeur
// unique) — un poids identique sur toutes les séries (le cas courant) se
// simplifie donc en une valeur simple exploitable pour le tonnage ; une
// charge réellement variable reste stockée à tirets mais sort du calcul
// de tonnage tant que `_load_kg` ne le supporte pas (même principe que
// le reste du module : refuser plutôt que deviner).

/** Reconstruit un seul champ (reps, charge ou RIR) en lignes — une
 * chaîne à tirets impose son propre découpage (la source la plus précise
 * possible) ; sinon `sets` donne le nombre de lignes, chacune préremplie
 * avec la valeur unique partagée (le cas le plus courant : "4 séries de
 * 10"). */
export function hydrateSetRows(setsRaw, valueRaw) {
  if (valueRaw != null && String(valueRaw).includes("-")) {
    return String(valueRaw).split("-");
  }
  const setsCount = parseInt(setsRaw, 10);
  if (Number.isFinite(setsCount) && setsCount > 0) {
    return Array.from({ length: setsCount }, () => (valueRaw != null ? String(valueRaw) : ""));
  }
  return valueRaw != null && valueRaw !== "" ? [String(valueRaw)] : [];
}

/** `[{reps, load, rir}, ...]`, une entrée par série — les trois champs
 * peuvent avoir des découpages différents une fois hydratés isolément
 * (ex. reps à tirets mais charge en valeur unique) ; le nombre de lignes
 * suit le plus précis des trois, les autres sont complétés (valeur
 * répétée si elle était unique, vide sinon) pour rester alignés ligne à
 * ligne. */
export function hydrateExecRows(executed, rir) {
  const repsRows = hydrateSetRows(executed.sets, executed.reps);
  const loadRows = hydrateSetRows(executed.sets, executed.load);
  const rirRows = hydrateSetRows(executed.sets, rir);
  const n = Math.max(repsRows.length, loadRows.length, rirRows.length);
  const pad = (arr) => {
    if (arr.length >= n) return arr;
    const fill = arr.length === 1 ? arr[0] : "";
    return Array.from({ length: n }, (_, i) => (i < arr.length ? arr[i] : fill));
  };
  const reps = pad(repsRows);
  const load = pad(loadRows);
  const rirs = pad(rirRows);
  return Array.from({ length: n }, (_, i) => ({ reps: reps[i], load: load[i], rir: rirs[i] }));
}

/** L'inverse de hydrateExecRows — `{sets, reps, load, rir}` prêts à
 * stocker à partir des trois tableaux de lignes (même longueur, un
 * élément par série). `sets` est `null` si les trois champs sont
 * entièrement vides (pas encore vraiment "fait", voir
 * sessionHasExecuted) ; chaque champ se simplifie individuellement en
 * valeur simple s'il est identique sur toutes les lignes, ou se joint à
 * tirets sinon — hydrateExecRows reconstruit fidèlement dans les deux
 * cas au rendu suivant. */
export function serializeExecRows(repsVals, loadVals, rirVals) {
  const allEmpty = [repsVals, loadVals, rirVals].every((arr) => arr.every((v) => !(v || "").trim()));
  if (allEmpty) return { sets: null, reps: null, load: null, rir: null };
  const joinField = (values) => {
    const trimmed = values.map((v) => (v || "").trim());
    if (trimmed.every((v) => v === "")) return null;
    const allSame = trimmed.every((v) => v === trimmed[0]);
    return allSame ? trimmed[0] : trimmed.join("-");
  };
  return {
    sets: String(repsVals.length),
    reps: joinField(repsVals),
    load: joinField(loadVals),
    rir: joinField(rirVals),
  };
}

export function execSetRowHeadHTML() {
  return `<div class="set-row set-row-head"><span></span><span>Charge</span><span>Reps/temps</span><span>RIR</span><span></span></div>`;
}

export function execSetRowHTML(r, i) {
  return `
    <div class="set-row">
      <span class="set-row-num">Série ${i + 1}</span>
      <input type="text" inputmode="decimal" class="f-exec-set-load" value="${escapeAttr(r.load)}" placeholder="charge">
      <input type="text" inputmode="numeric" class="f-exec-set-reps" value="${escapeAttr(r.reps)}" placeholder="reps">
      <input type="text" inputmode="numeric" class="f-exec-set-rir" value="${escapeAttr(r.rir)}" placeholder="RIR">
      <button type="button" class="icon-button small danger remove-exec-set" title="Retirer cette série" aria-label="Retirer cette série">✕</button>
    </div>`;
}

export function execRowsHTML(rows) {
  const rowsHTML = rows.map((r, i) => execSetRowHTML(r, i)).join("");
  return `
    <div class="exec-set-rows">
      ${rows.length ? execSetRowHeadHTML() : ""}
      ${rowsHTML}
      <div class="exec-set-actions">
        <button type="button" class="primary-button ghost small as-planned-exec">📋 Comme planifié</button>
        <button type="button" class="primary-button ghost small add-exec-set">+ Série faite</button>
        <button type="button" class="primary-button ghost small duplicate-exec-set"${rows.length < 2 ? " hidden" : ""}>🔁 Dupliquer la 1ʳᵉ série partout</button>
      </div>
    </div>`;
}

/** Vide les lignes actuelles et les reconstruit à partir de "Prévu" — la
 * séance s'est souvent déroulée exactement comme prévu, retaper
 * série par série ce qui est déjà écrit juste au-dessus n'a pas de sens.
 * Le RIR reste vide (rien de "prévu" côté ressenti) ; la charge est
 * reprise telle quelle sur toutes les lignes (elle-même toujours une
 * valeur unique côté Prévu, voir stationRowHTML/exerciseCardHTML). Reste
 * un point de départ éditable, pas un verrou — une série qui a
 * finalement différé (coupée court, charge ajustée) se corrige ensuite
 * ligne par ligne comme n'importe quelle valeur tapée à la main. */
export function fillExecRowsAsPlanned(container, plannedSets, plannedReps, plannedLoad) {
  const reps = hydrateSetRows(plannedSets, plannedReps);
  if (!reps.length) return; // rien de prévu à reprendre
  container.querySelectorAll(".set-row").forEach((el) => el.remove());
  const actions = container.querySelector(".exec-set-actions");
  const headWrap = document.createElement("div");
  headWrap.innerHTML = execSetRowHeadHTML();
  container.insertBefore(headWrap.firstElementChild, actions);
  reps.forEach((repVal, i) => {
    const rowWrap = document.createElement("div");
    rowWrap.innerHTML = execSetRowHTML({ load: plannedLoad || "", reps: repVal, rir: "" }, i);
    const rowEl = rowWrap.firstElementChild;
    container.insertBefore(rowEl, actions);
    bindRemoveExecSetRow(rowEl.querySelector(".remove-exec-set"));
  });
  const dupBtn = container.querySelector(".duplicate-exec-set");
  if (dupBtn) dupBtn.hidden = reps.length < 2;
}

/** Ajoute une ligne en DOM pur (pas de mutation du modèle de données, pas
 * de re-rendu complet — voir bindRemoveExecSetRow) — préremplie avec les
 * valeurs actuelles de la dernière ligne plutôt que vide : le cas
 * courant est "même charge/reps/RIR sur toutes les séries", retaper la
 * même chose à chaque appui sur "+ Série faite" n'a pas de sens ("Si
 * toutes les séries sont au même poids et reps, je dois avoir une
 * solution pour ne pas avoir à taper toutes les séries"). Reste un champ
 * texte normal ensuite — modifiable dès que cette série diffère. */
export function addExecSetRow(container) {
  const rows = container.querySelectorAll(".set-row:not(.set-row-head)");
  const rowCount = rows.length;
  const last = rows[rows.length - 1];
  const lastLoad = last ? last.querySelector(".f-exec-set-load").value : "";
  const lastReps = last ? last.querySelector(".f-exec-set-reps").value : "";
  const lastRir = last ? last.querySelector(".f-exec-set-rir").value : "";
  const actions = container.querySelector(".exec-set-actions");
  if (rowCount === 0) {
    const headWrap = document.createElement("div");
    headWrap.innerHTML = execSetRowHeadHTML();
    container.insertBefore(headWrap.firstElementChild, actions);
  }
  const rowWrap = document.createElement("div");
  rowWrap.innerHTML = execSetRowHTML({ load: lastLoad, reps: lastReps, rir: lastRir }, rowCount);
  const rowEl = rowWrap.firstElementChild;
  container.insertBefore(rowEl, actions);
  bindRemoveExecSetRow(rowEl.querySelector(".remove-exec-set"));
  rowEl.querySelector(".f-exec-set-reps").focus();
  const dupBtn = container.querySelector(".duplicate-exec-set");
  if (dupBtn) dupBtn.hidden = container.querySelectorAll(".set-row:not(.set-row-head)").length < 2;
}

/** Add/remove a set row purely in the DOM (no data-model mutation, no
 * full re-render) — a full re-render here would go through
 * syncFormIntoSession/serializeExecRows first, which collapses an empty
 * row right back to nothing (see serializeExecRows's docstring), so a
 * freshly-added blank row would visually vanish before the user gets to
 * type anything into it. The row's value only becomes real stored data
 * once syncFormIntoSession reads it — on any structural change elsewhere,
 * or on save. */
export function bindRemoveExecSetRow(btn) {
  btn.addEventListener("click", () => {
    const container = btn.closest(".exec-set-rows");
    btn.closest(".set-row").remove();
    const remaining = container.querySelectorAll(".set-row:not(.set-row-head)");
    remaining.forEach((row, i) => { row.querySelector(".set-row-num").textContent = `Série ${i + 1}`; });
    if (remaining.length === 0) {
      const head = container.querySelector(".set-row-head");
      if (head) head.remove();
    }
    const dupBtn = container.querySelector(".duplicate-exec-set");
    if (dupBtn) dupBtn.hidden = remaining.length < 2;
  });
}
