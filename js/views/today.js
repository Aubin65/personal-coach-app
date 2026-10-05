import { setupCredo } from "../credo.js";
import { kindIconHTML } from "../session-icons.js";
import { showView, stale, state } from "../nav.js";
import { todayISO, addDaysISO, sessionHasExecuted } from "../date-utils.js";
import { findSessionForDate } from "../training-index.js";
import { postUserMessage, dispatchStatusNote } from "./chat.js";
import { skeletonHTML, escapeAttr, escapeHtmlText } from "../markdown.js";
import { ghDispatchWorkflow, ghGetFile, ghPutJSON, ghListDir } from "../github-api.js";
import { checkinPath, healthPath } from "../data-paths.js";
import { openSheet } from "../sheet.js";
import { latestFileOnOrBefore } from "../training-index.js";
import { renderDigestSections } from "../plan-overview.js";
import { setupMicButton } from "../voice-input.js";
import { renderSystemStatus, latestDigestDate } from "../system-status.js";
import { openRpeSheet } from "../rpe-sheet.js";
import { saveSession } from "../session/session-form.js";
import { registerQueuedOp, runQueued } from "../offline-queue.js";
import { READINESS_LEVEL_LABELS, WORKLOAD_ZONE_LABELS } from "./data.js";
import { formatHoursFr } from "./data-viz.js";
import { SESSION_TYPES } from "../session-types.js";
import { renderTodayDataCheck } from "../today-data-check.js";

const ALERT_CATEGORY_LABELS = { blessure: "blessure / douleur", sommeil: "sommeil", poids: "poids", charge: "charge", prepa_physique: "préparation physique" };

// ============================================================================
// Check-in du matin (docs/adr/0065) — retour direct : "questionnaire de
// bien-être subjectif quotidien" + "suivi de compliance de la routine
// d'étirements du matin". Un seul composer, un seul Enregistrer pour les
// deux (mêmes 15 secondes du matin), écrit sur data/checkin/<date>.json
// sous deux clés séparées (`wellness`, `mobility`) — lues ensuite par
// coach.readiness (composante bien_etre) et coach.progression.
// mobility_streak_days côté Python, jamais recalculées ici autrement que
// pour l'affichage immédiat après sauvegarde (voir `wellnessScore`).
// ============================================================================

const ARRIVAL_STATE_OPTIONS = [
  { id: "energique", label: "Énergique", emoji: "⚡" },
  { id: "ok", label: "OK", emoji: "👍" },
  { id: "difficile", label: "Difficile", emoji: "😴" },
  { id: "vraiment_fatigué", label: "Vraiment fatigué", emoji: "🚫" },
];
const ARRIVAL_STATE_LABELS = Object.fromEntries(ARRIVAL_STATE_OPTIONS.map((o) => [o.id, o.label]));

const WELLNESS_DIMENSIONS = [
  { key: "energie", label: "Énergie", low: "Épuisé", high: "Plein d'énergie" },
  { key: "stress", label: "Stress", low: "Très stressé", high: "Détendu" },
  { key: "courbatures", label: "Courbatures", low: "Très courbaturé", high: "Aucune courbature" },
  { key: "motivation", label: "Motivation", low: "Aucune envie", high: "Très motivé" },
];

const MOBILITY_DONE_OPTIONS = [
  { id: "fait", label: "Fait" },
  { id: "partiel", label: "Partiel" },
  { id: "non", label: "Non" },
];
const MOBILITY_DONE_LABELS = Object.fromEntries(MOBILITY_DONE_OPTIONS.map((o) => [o.id, o.label]));

/** Même formule que `coach.progression.wellness_history` côté Python
 * (1-5 chacune, polarité "5 = très bien" partagée par les 4 curseurs) —
 * dupliquée ici uniquement pour afficher un résumé immédiat après
 * sauvegarde, sans attendre le prochain export (voir plus bas). */
function wellnessScore(w) {
  const avg = (w.energie + w.stress + w.courbatures + w.motivation) / 4;
  return Math.round(((avg - 1) / 4) * 100);
}

function checkinSummaryHTML(wellness, mobility, arrivalState) {
  const parts = [];
  if (arrivalState) {
    const opt = ARRIVAL_STATE_OPTIONS.find((o) => o.id === arrivalState.state);
    parts.push(`Arrivée : ${opt ? opt.emoji : ""} ${arrivalState.label || ARRIVAL_STATE_LABELS[arrivalState.state] || arrivalState.state}`);
  }
  if (wellness) parts.push(`Bien-être : ${wellness.score}/100`);
  if (mobility) {
    const doneLabel = MOBILITY_DONE_LABELS[mobility.done] || mobility.done;
    parts.push(`Étirements : ${doneLabel}${mobility.stiffness != null ? ` (raideur ${mobility.stiffness}/10)` : ""}`);
  }
  return `
    <div class="checkin-summary">
      <p class="small">${parts.join(" · ") || "Check-in fait aujourd'hui."}</p>
      <div class="checkin-summary-actions">
        <button type="button" class="primary-button ghost small checkin-edit">Modifier</button>
        <button type="button" class="delete-link checkin-delete">Effacer</button>
      </div>
    </div>`;
}

function wellnessChipsRowHTML(dim, value) {
  const chips = [1, 2, 3, 4, 5]
    .map((n) => `<button type="button" class="suggestion-chip${value === n ? " active" : ""}" data-wellness="${dim.key}" data-value="${n}">${n}</button>`)
    .join("");
  return `
    <div class="checkin-wellness-row">
      <p class="small checkin-wellness-label">${dim.label}</p>
      <div class="suggestion-chips">${chips}</div>
      <p class="muted small checkin-wellness-anchors"><span>${dim.low}</span><span>${dim.high}</span></p>
    </div>`;
}

function checkinFormHTML(wellness, mobility, arrivalState, hidden) {
  // Tuiles d'arrivée (docs/adr/0072) : un tap suffit pour commencer ; le
  // reste du check-in (étirements, bien-être, note) se déplie ensuite.
  const arrivalChips = ARRIVAL_STATE_OPTIONS
    .map((o) => `<button type="button" class="arrival-tile${arrivalState && arrivalState.state === o.id ? " active" : ""}" data-arrival-state="${o.id}"><span class="arrival-dot" aria-hidden="true"></span><span>${o.label}</span></button>`)
    .join("");
  const showMore = !!(arrivalState || wellness || mobility);
  const mobilityChips = MOBILITY_DONE_OPTIONS
    .map((o) => `<button type="button" class="suggestion-chip${mobility && mobility.done === o.id ? " active" : ""}" data-mobility-done="${o.id}">${o.label}</button>`)
    .join("");
  const wellnessRows = WELLNESS_DIMENSIONS.map((dim) => wellnessChipsRowHTML(dim, wellness ? wellness[dim.key] : null)).join("");
  return `
    <div class="checkin-form"${hidden ? " hidden" : ""}>
      <p class="checkin-question">Comment tu arrives ce matin ?</p>
      <div class="arrival-tiles">${arrivalChips}</div>
      <p class="muted small checkin-more-hint"${showMore ? " hidden" : ""}>Un tap pour commencer. Étirements, bien-être et note suivent.</p>
      <div class="checkin-more"${showMore ? "" : " hidden"}>
      <p class="small checkin-section-title" style="margin-top:14px">Étirements du matin</p>
      <div class="suggestion-chips">${mobilityChips}</div>
      <div class="exercise-log-grid full" style="margin-top:8px">
        <div><label>Raideur ressentie (0-10)</label><input type="number" id="checkin-stiffness" min="0" max="10" step="1" value="${mobility && mobility.stiffness != null ? mobility.stiffness : ""}" placeholder="0-10"></div>
      </div>
      <p class="small checkin-section-title" style="margin-top:14px">Bien-être du jour</p>
      ${wellnessRows}
      <div class="compose-row" style="margin-top:10px">
        <textarea id="checkin-note" rows="2" placeholder="Note libre (optionnel)">${mobility && mobility.note ? escapeHtmlText(mobility.note) : ""}</textarea>
        <button type="button" class="mic-button" id="checkin-mic" title="Dicter" aria-label="Dicter"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
      </div>
      <p class="voice-hint" id="checkin-voice-hint" hidden></p>
      <p class="live-caption" id="checkin-live-caption" hidden></p>
      <button type="button" class="primary-button" id="checkin-save" style="margin-top:12px">Enregistrer</button>
      <p class="muted small" id="checkin-status"></p>
      </div>
    </div>`;
}

const POOR_ARRIVALS = ["difficile", "vraiment_fatigué"];
const adaptRequestKey = (date) => `coach_checkin_adapt_requested_${date}`;

function checkinAdaptRequestText(arrivalState, wellness, session) {
  const opt = ARRIVAL_STATE_OPTIONS.find((o) => o.id === arrivalState.state);
  const label = opt ? opt.label.toLowerCase() : arrivalState.state;
  // Échelles 1-5 où 5 = très bien pour les quatre curseurs : "courbatures
  // 1/5" veut dire très courbaturé — à préciser pour ne pas être lu à l'envers.
  const dims = wellness ? ` (énergie ${wellness.energie}/5, courbatures ${wellness.courbatures}/5 où 1 = très courbaturé, motivation ${wellness.motivation}/5 ; 5 = au mieux)` : "";
  return `[Check-in] J'arrive « ${label} » ce matin${dims}. Adapte la séance d'aujourd'hui (« ${session.name || "séance"} ») en conséquence : allège-la, ou propose du repos si c'est plus sage.`;
}

/** Après un check-in "difficile"/"vraiment fatigué" et seulement s'il reste
 * une séance à faire aujourd'hui, propose d'un tap de demander au coach de
 * l'adapter — le digest de 8h30 passe souvent avant le check-in du
 * matin, donc il ne verrait jamais cet état (docs/adr/0068). La demande
 * suit le chemin habituel du chat (préfixe `[Check-in]` routé vers
 * prompts/session-adjustment.md) : une proposition à valider dans Semaine,
 * jamais une modification appliquée d'office. */
async function refreshAdaptOffer(card, token) {
  const slot = card.querySelector(".checkin-adapt-slot");
  if (!slot) return;
  const { today } = card._history;
  const arrival = today.arrival;
  if (!arrival || !POOR_ARRIVALS.includes(arrival.state)) { slot.innerHTML = ""; return; }

  let found = null;
  try { found = await findSessionForDate(today.date); } catch (_) { return; }
  if (stale(token)) return;
  const session = found && found.session;
  if (!session || session.type === "repos" || sessionHasExecuted(session)) { slot.innerHTML = ""; return; }

  let alreadyRequested = false;
  try { alreadyRequested = !!localStorage.getItem(adaptRequestKey(today.date)); } catch (_) {}
  if (alreadyRequested) {
    slot.innerHTML = `<p class="muted small">Demande d'adaptation envoyée au coach — la proposition arrive dans Semaine.</p>`;
    return;
  }

  slot.innerHTML = `
    <div class="checkin-adapt">
      <p class="small">Arrivée difficile ce matin : veux-tu que le coach adapte la séance du jour (« ${escapeHtmlText(session.name || "séance")} ») ?</p>
      <button type="button" class="primary-button small checkin-adapt-button">🧠 Adapter ma séance</button>
      <p class="muted small checkin-adapt-status"></p>
    </div>`;
  const btn = slot.querySelector(".checkin-adapt-button");
  const statusEl = slot.querySelector(".checkin-adapt-status");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    statusEl.textContent = "Envoi…";
    try {
      const dispatch = await postUserMessage(checkinAdaptRequestText(arrival, today.wellness, session));
      try { localStorage.setItem(adaptRequestKey(today.date), "1"); } catch (_) {}
      statusEl.textContent = `Demande envoyée ✓ — proposition dans Semaine d'ici quelques minutes.${dispatchStatusNote(dispatch)}`;
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
      btn.disabled = false;
    }
  });
}

const WEEKDAYS_SHORT = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

/** Fusionne par date les trois historiques exportés (`arrival_state_recent`,
 * `wellness_recent`, `mobility_recent`) — le résumé n'est régénéré qu'à
 * chaque digest, donc le check-in du jour (lu en direct, voir
 * `loadCheckin`) est toujours ajouté par-dessus. Plus récent d'abord. */
function mergeCheckinHistory(summary, today) {
  const byDate = new Map();
  const slot = (date) => {
    if (!byDate.has(date)) byDate.set(date, { date });
    return byDate.get(date);
  };
  ((summary.arrival_state_recent || {}).history || []).forEach((e) => { slot(e.date).arrival = { state: e.state }; });
  ((summary.wellness_recent || {}).history || []).forEach((e) => { slot(e.date).wellness = e; });
  ((summary.mobility_recent || {}).history || []).forEach((e) => { slot(e.date).mobility = e; });
  if (today.arrival || today.wellness || today.mobility) {
    const entry = slot(today.date);
    if (today.arrival) entry.arrival = today.arrival;
    if (today.wellness) entry.wellness = today.wellness;
    if (today.mobility) entry.mobility = today.mobility;
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

function checkinHistoryHTML(entries) {
  if (!entries.length) return "";
  const rows = entries
    .map((e) => {
      const d = new Date(`${e.date}T12:00:00`);
      const label = `${WEEKDAYS_SHORT[d.getDay()]} ${e.date.slice(8, 10)}/${e.date.slice(5, 7)}`;
      const parts = [];
      let sev = "";
      if (e.arrival) {
        const opt = ARRIVAL_STATE_OPTIONS.find((o) => o.id === e.arrival.state);
        const level = { energique: "ok", ok: "ok", difficile: "warn", "vraiment_fatigué": "alert" }[e.arrival.state];
        if (level) sev = `<span class="sev-dot sev-${level}" aria-hidden="true"></span>`;
        parts.push(`${opt ? `${opt.emoji} ${opt.label}` : escapeHtmlText(String(e.arrival.state))}`);
      }
      if (e.wellness) parts.push(`bien-être ${e.wellness.score}/100`);
      if (e.mobility) {
        const doneLabel = MOBILITY_DONE_LABELS[e.mobility.done] || e.mobility.done;
        parts.push(`étirements ${escapeHtmlText(String(doneLabel))}${e.mobility.stiffness != null ? ` (raideur ${e.mobility.stiffness}/10)` : ""}`);
      }
      return `<li>${sev}<strong>${label}</strong> — ${parts.join(" · ") || "—"}</li>`;
    })
    .join("");
  return `
    <details class="block-overview-details checkin-history">
      <summary>📅 Historique des check-ins (${entries.length})</summary>
      <ul class="checkin-history-list small">${rows}</ul>
    </details>`;
}

function recoveryPatternsHTML(patterns) {
  if (!patterns) return "";
  const lines = [];
  const sleep = patterns.sleep_correlation;
  if (sleep) {
    lines.push(`Nuits < 7h : arrivée moyenne ${sleep.short_sleep_avg_severity}/5 (${sleep.short_sleep_n} jours) contre ${sleep.good_sleep_avg_severity}/5 après ≥ 7h (${sleep.good_sleep_n} jours).`);
  }
  const contact = patterns.poor_recovery_after_contact;
  if (contact && contact.length) {
    lines.push(`Arrivée difficile le lendemain d'un match à contacts : ${contact.length} fois (${contact.map((c) => `${c.date.slice(8, 10)}/${c.date.slice(5, 7)}`).join(", ")}).`);
  }
  if (!lines.length) return "";
  return `<p class="muted small checkin-patterns">${lines.map(escapeHtmlText).join("<br>")}</p>`;
}

/** (Re)branche "✏️ Modifier" — appelé au rendu initial et après une
 * sauvegarde qui remplace le contenu du slot résumé (le nouveau bouton
 * n'a pas encore d'écouteur, même motif que calendar.js). */
registerQueuedOp("checkinDelete", async ({ date }) => {
  await ghPutJSON(checkinPath(date), { date }, `App : check-in du ${date} effacé`, (current) => {
    const base = current || { date };
    delete base.arrival_state;
    delete base.wellness;
    delete base.mobility;
    return base;
  });
});

function wireCheckinEditButton(card) {
  const deleteBtn = card.querySelector(".checkin-delete");
  if (deleteBtn) deleteBtn.addEventListener("click", async () => {
    if (!window.confirm("Effacer le check-in d'aujourd'hui (arrivée, bien-être, étirements) ?")) return;
    deleteBtn.disabled = true;
    try {
      await runQueued("checkinDelete", { date: todayISO() }, { key: `checkin:${todayISO()}`, label: "Effacer le check-in" });
      loadCheckin(state.renderToken).catch(() => {});
      loadReadiness(state.renderToken).catch(() => {});
    } catch (err) {
      deleteBtn.disabled = false;
      window.alert(`Échec : ${err.message}`);
    }
  });
  const editBtn = card.querySelector(".checkin-edit");
  if (!editBtn) return;
  editBtn.addEventListener("click", () => {
    card.querySelector(".checkin-summary").hidden = true;
    card.querySelector(".checkin-form").hidden = false;
  });
}

/** Écrit le check-in du jour dans data/checkin/<date>.json — opération
 * rejouable par la file hors-ligne (offline-queue.js). Renvoie si la synchro
 * Santé du jour était déjà passée (sommeil présent), qui conditionne le
 * lancement automatique du digest. */
registerQueuedOp("checkin", async ({ date, arrivalState, wellness, mobility }) => {
  // Lecture seule du fichier du Raccourci : l'app ne l'écrit jamais (ADR-0083).
  const healthFile = await ghGetFile(healthPath(date)).catch(() => null);
  let healthSynced = false;
  if (healthFile) { try { healthSynced = !!JSON.parse(healthFile.content).sleep_stages; } catch (_) { /* fichier illisible */ } }
  await ghPutJSON(checkinPath(date), { date }, `App : check-in du matin du ${date}`, (current) => {
    const base = current || { date };
    base.arrival_state = arrivalState;
    base.wellness = wellness;
    base.mobility = mobility;
    return base;
  });
  return { healthSynced };
});

function wireCheckinForm(card) {
  const micBtn = card.querySelector("#checkin-mic");
  if (micBtn) {
    setupMicButton(micBtn, card.querySelector("#checkin-voice-hint"), card.querySelector("#checkin-note"), card.querySelector("#checkin-live-caption"));
  }

  card.querySelectorAll("[data-arrival-state]").forEach((chip) => {
    chip.addEventListener("click", () => {
      card.querySelectorAll("[data-arrival-state]").forEach((c) => c.classList.toggle("active", c === chip));
      const more = card.querySelector(".checkin-more");
      if (more && more.hidden) {
        more.hidden = false;
        const hint = card.querySelector(".checkin-more-hint");
        if (hint) hint.hidden = true;
      }
    });
  });

  card.querySelectorAll("[data-mobility-done]").forEach((chip) => {
    chip.addEventListener("click", () => {
      card.querySelectorAll("[data-mobility-done]").forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  card.querySelectorAll("[data-wellness]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const dim = chip.dataset.wellness;
      card.querySelectorAll(`[data-wellness="${dim}"]`).forEach((c) => c.classList.toggle("active", c === chip));
    });
  });

  wireCheckinEditButton(card);

  card.querySelector("#checkin-save").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = card.querySelector("#checkin-status");
    const arrivalChip = card.querySelector("[data-arrival-state].active");
    const mobilityDoneChip = card.querySelector("[data-mobility-done].active");
    const stiffnessEl = card.querySelector("#checkin-stiffness");
    const noteEl = card.querySelector("#checkin-note");
    const wellness = {};
    for (const dim of WELLNESS_DIMENSIONS) {
      const chip = card.querySelector(`[data-wellness="${dim.key}"].active`);
      if (chip) wellness[dim.key] = Number(chip.dataset.value);
    }
    if (!arrivalChip) { statusEl.textContent = "Indique comment tu arrives ce matin."; return; }
    if (!mobilityDoneChip) { statusEl.textContent = "Indique si tu as fait tes étirements."; return; }
    if (Object.keys(wellness).length < WELLNESS_DIMENSIONS.length) { statusEl.textContent = "Complète les 4 curseurs de bien-être."; return; }

    const date = todayISO();
    const arrivalState = {
      state: arrivalChip.dataset.arrivalState,
      label: ARRIVAL_STATE_LABELS[arrivalChip.dataset.arrivalState] || null,
    };
    const mobility = {
      done: mobilityDoneChip.dataset.mobilityDone,
      stiffness: stiffnessEl.value !== "" ? Number(stiffnessEl.value) : null,
      note: noteEl.value.trim() || null,
    };

    btn.disabled = true;
    statusEl.textContent = "Enregistrement…";
    let healthSynced = false;
    try {
      const outcome = await runQueued("checkin", { date, arrivalState, wellness, mobility }, { key: `checkin:${date}`, label: "Check-in du matin" });
      healthSynced = !!(outcome.result && outcome.result.healthSynced);
      // Patch local plutôt qu'un re-fetch de data/app/summary.json (pas
      // encore régénéré à ce stade, seul le prochain digest le fera) —
      // même motif que le composer de performance match (calendar.js).
      if (!outcome.queued) statusEl.textContent = "";
      const wellnessWithScore = { ...wellness, score: wellnessScore(wellness) };
      card.querySelector(".checkin-summary-slot").innerHTML = checkinSummaryHTML(wellnessWithScore, mobility, arrivalState);
      card.querySelector(".checkin-form").hidden = true;
      wireCheckinEditButton(card);
      const summarySlot = card.querySelector(".checkin-summary-slot");
      if (outcome.queued) summarySlot.insertAdjacentHTML("beforeend", `<p class="muted small">Gardé sur le téléphone — envoi dès que le réseau revient.</p>`);
      maybeLaunchDigestAfterCheckin(date, healthSynced, summarySlot);
      const historyCard = card.querySelector(".checkin-card");
      if (historyCard && historyCard._history) {
        historyCard._history.today = { date, arrival: arrivalState, wellness: wellnessWithScore, mobility };
        refreshCheckinHistory(historyCard);
        refreshAdaptOffer(historyCard, state.renderToken).catch(() => {});
      }
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

/** Lance le digest du jour dès que le check-in est enregistré, plutôt que
 * d'attendre l'horloge de GitHub (déclenchements `schedule` parfois en
 * retard de plusieurs heures — docs/adr/0069) : le digest verra aussi
 * l'état d'arrivée du jour, qu'il manquait quand il partait avant le
 * check-in. Seulement si la synchro Santé du jour est déjà passée (sinon le
 * digest partirait sans le sommeil de la nuit — le cron s'en charge alors
 * comme avant), si aucun digest n'existe encore pour aujourd'hui, et une
 * seule fois par jour et par appareil. Silencieux en cas d'échec : l'état du
 * système affiche déjà le refus de déclenchement. */
async function maybeLaunchDigestAfterCheckin(date, healthSynced, noteSlot) {
  if (!healthSynced) return;
  const flagKey = `coach_digest_autolaunch_${date}`;
  try { if (localStorage.getItem(flagKey)) return; } catch (_) {}
  try {
    const latest = await latestDigestDate(date);
    if (latest === date) return;
    await ghDispatchWorkflow("daily-digest.yml");
    try { localStorage.setItem(flagKey, "1"); } catch (_) {}
    noteSlot.insertAdjacentHTML("beforeend", `<p class="muted small">Digest du jour lancé automatiquement — il tiendra compte de ton check-in (⟳ dans quelques minutes).</p>`);
  } catch (_) {
    // pas de message ici : "État du système" rend compte d'un refus
  }
}

/** Lit le check-in du jour directement dans `data/checkin/<date>.json`, la
 * source de vérité écrite par "Enregistrer" — pas dans `data/app/summary.json`,
 * qui n'est régénéré qu'à chaque digest : un check-in tout juste enregistré
 * y restait invisible, le composer se rouvrait vierge et on pouvait
 * enregistrer le matin une deuxième fois. Le résumé ne sert plus que pour
 * l'historique des jours précédents. */
async function loadCheckin(token) {
  const box = document.getElementById("checkin-content");
  const date = todayISO();
  const [summaryFile, liveFile] = await Promise.all([ghGetFile("data/app/summary.json"), ghGetFile(checkinPath(date))]);
  if (stale(token)) return;
  const summary = summaryFile ? JSON.parse(summaryFile.content) : {};
  let live = {};
  if (liveFile) { try { live = JSON.parse(liveFile.content) || {}; } catch (_) { live = {}; } }

  const arrivalStateToday = live.arrival_state && live.arrival_state.state ? live.arrival_state : null;
  const wellnessRaw = live.wellness;
  const wellnessToday = wellnessRaw && WELLNESS_DIMENSIONS.every((d) => wellnessRaw[d.key] != null)
    ? { ...wellnessRaw, score: wellnessScore(wellnessRaw) }
    : null;
  const mobilityToday = live.mobility && live.mobility.done ? live.mobility : null;
  const alreadyLogged = !!(arrivalStateToday || wellnessToday || mobilityToday);

  box.innerHTML = `
    <section class="card checkin-card">
      <div class="card-head"><h2>Check-in du matin</h2>${alreadyLogged ? '<span class="pill pill-ok">Fait</span>' : '<span class="pill pill-warn">À faire</span>'}</div>
      <div class="checkin-summary-slot">${alreadyLogged ? checkinSummaryHTML(wellnessToday, mobilityToday, arrivalStateToday) : ""}</div>
      <div class="checkin-adapt-slot"></div>
      ${checkinFormHTML(wellnessToday, mobilityToday, arrivalStateToday, alreadyLogged)}
      <div class="checkin-history-slot"></div>
      ${recoveryPatternsHTML((summary.arrival_state_recent || {}).patterns)}
    </section>`;
  const card = box.querySelector(".checkin-card");
  card._history = { summary, today: { date, arrival: arrivalStateToday, wellness: wellnessToday, mobility: mobilityToday } };
  refreshCheckinHistory(card);
  wireCheckinForm(box);
  refreshAdaptOffer(card, token).catch(() => {});
}

function refreshCheckinHistory(card) {
  const { summary, today } = card._history;
  card.querySelector(".checkin-history-slot").innerHTML = checkinHistoryHTML(mergeCheckinHistory(summary, today));
}

// ============================================================================
// Charge à saisir (docs/adr/0070) — une séance d'hier ou d'aujourd'hui sans
// RPE ni durée ne compte pas dans la charge aiguë:chronique. Un rugby ou une
// autre activité se faisait surtout oublier : rien ne la signalait. Carte
// à deux touches (RPE + durée), repoussable par date ("Ignorer").
// ============================================================================

const QUICK_LOAD_TYPES = ["musculation", "rugby", "autre"];
const quickLoadDismissKey = (date) => `coach_quickload_dismissed_${date}`;

function hasLoggedExerciseValues(session) {
  return (session.exercises || []).some((ex) => {
    const executed = ex.executed || {};
    return !!(executed.sets || executed.reps || executed.load);
  });
}

/** Séances de [aujourd'hui, hier] pour lesquelles une saisie de charge a du
 * sens : pas de repos, ni RPE ni durée déjà là, pas ignorée. Une
 * musculation sans aucun chiffre saisi est probablement non faite (ou en
 * cours de log dans la vue séance) : pas de relance. */
export async function pendingLoadSessions() {
  const today = todayISO();
  const found = [];
  for (const date of [today, addDaysISO(today, -1)]) {
    let dismissed = false;
    try { dismissed = !!localStorage.getItem(quickLoadDismissKey(date)); } catch (_) {}
    if (dismissed) continue;
    const day = await findSessionForDate(date);
    const session = day && day.session;
    if (!session || !QUICK_LOAD_TYPES.includes(session.type || "musculation")) continue;
    if (session.session_rpe != null || session.session_duration_min != null) continue;
    if ((session.type || "musculation") === "musculation" && !hasLoggedExerciseValues(session)) continue;
    found.push({ date, session, weekLabel: day.weekLabel });
  }
  return found;
}

// ============================================================================
// « À faire » (docs/adr/0076, maquette C) — une seule carte pour tout ce qui
// attend une action : alertes actives, séances sans RPE/durée, propositions du
// coach en attente (planning, ajustement de séance, squelette Forge). Avant,
// trois cartes séparées (alertes repliées, « Charge à saisir », et rien du
// tout pour les propositions, visibles seulement dans Semaine). Chaque ligne
// ouvre l'action ; le détail d'une alerte s'ouvre dans une feuille.
// ============================================================================

const TODO_ICONS = {
  alert: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M4 12h12M12 6l6 6-6 6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

function frShortDate(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Ouvre la saisie RPE + durée d'une séance et l'enregistre. Exportée pour le
 * bouton + (add-sheet.js). Renvoie le résultat ou `null` si fermée. */
export async function promptSessionLoad(item) {
  const label = item.date === todayISO() ? "aujourd'hui" : item.date === addDaysISO(todayISO(), -1) ? "hier" : frShortDate(item.date);
  const result = await openRpeSheet({ title: `${item.session.name || "Séance"} — ${label}` });
  if (!result) return null;
  const updated = { ...item.session, session_rpe: result.rpe, session_duration_min: result.duration };
  const outcome = await saveSession(item.weekLabel || "app", item.date, updated);
  return { ...result, queued: !!(outcome && outcome.queued) };
}

/** Séances d'aujourd'hui / hier sans charge, sinon la séance du jour (pour le
 * bouton + : une saisie express doit toujours avoir une cible). */
export async function loadTargetsForQuickLoad() {
  const pending = await pendingLoadSessions();
  if (pending.length) return pending;
  const date = todayISO();
  const day = await findSessionForDate(date);
  const session = day && day.session;
  if (session && (session.type || "musculation") !== "repos") return [{ date, session, weekLabel: day.weekLabel }];
  return [];
}

async function pendingProposals() {
  const [plans, sessions] = await Promise.all([
    ghListDir("data/plans/pending").catch(() => []),
    ghListDir("data/training/app-log/pending").catch(() => []),
  ]);
  const out = [];
  plans.filter((e) => e.type === "file" && e.name.endsWith(".md")).forEach((e) => {
    out.push({ kind: "plan", title: "Le coach propose un nouveau planning", detail: `Semaine du ${frShortDate(e.name.slice(0, 10))} · à valider dans Plan`, go: () => showView("week") });
  });
  sessions.filter((e) => e.type === "file" && e.name.endsWith(".json")).forEach((e) => {
    const m = e.name.match(/(\d{4}-\d{2}-\d{2})/);
    const date = m ? m[1] : null;
    if (e.name.startsWith("adjust-")) {
      out.push({ kind: "adjust", title: `Le coach propose d'ajuster la séance${date ? ` du ${frShortDate(date)}` : ""}`, detail: "À valider dans Plan", go: () => showView("week") });
    } else {
      out.push({ kind: "skeleton", title: "Le coach a préparé une trame de semaine", detail: "À valider dans la Forge", go: () => showView("forge") });
    }
  });
  return out;
}

function openAlertSheet(alert, onResolved) {
  const manual = alert.resolution === "manual_or_note";
  const { el, close } = openSheet(`
    <p class="alert-sheet-kicker">Alerte · ${escapeHtmlText(ALERT_CATEGORY_LABELS[alert.category] || "Alerte")}</p>
    <h2>${escapeHtmlText(alert.title || (ALERT_CATEGORY_LABELS[alert.category] ? ALERT_CATEGORY_LABELS[alert.category][0].toUpperCase() + ALERT_CATEGORY_LABELS[alert.category].slice(1) : "Alerte"))}</h2>
    <p class="alert-sheet-message">${escapeHtmlText(alert.message || "")}</p>
    ${Array.isArray(alert.advice) && alert.advice.length ? `<p class="alert-sheet-sub">Ce que conseille le coach</p><ol class="alert-sheet-advice">${alert.advice.map((a) => `<li>${escapeHtmlText(a)}</li>`).join("")}</ol>` : ""}
    <div class="alert-sheet-actions">
      ${manual ? '<button type="button" class="primary-button ghost alert-sheet-resolve">Marquer résolu</button>' : ""}
      <button type="button" class="primary-button alert-sheet-plan">Voir le plan</button>
    </div>
    <p class="muted small alert-sheet-status">${manual ? "" : "L'alerte se lève toute seule quand la situation revient à la normale."}</p>
  `);
  el.querySelector(".alert-sheet-plan").addEventListener("click", () => { close(); showView("week"); });
  const resolveBtn = el.querySelector(".alert-sheet-resolve");
  if (resolveBtn) {
    resolveBtn.addEventListener("click", async () => {
      const statusEl = el.querySelector(".alert-sheet-status");
      resolveBtn.disabled = true;
      statusEl.textContent = "Mise à jour…";
      try {
        await ghPutJSON("data/alerts/active.json", [], "Alerte levée depuis l'app", (current) => {
          const list = Array.isArray(current) ? current : [];
          return list.filter((entry) => entry.id !== alert.id);
        });
        close();
        onResolved();
      } catch (err) {
        statusEl.textContent = `Échec : ${err.message}`;
        resolveBtn.disabled = false;
      }
    });
  }
}

async function loadTodo(token) {
  const box = document.getElementById("today-todo");
  if (!box) return;
  const [alertsFile, loads, proposals] = await Promise.all([
    ghGetFile("data/alerts/active.json").catch(() => null),
    pendingLoadSessions().catch(() => []),
    pendingProposals().catch(() => []),
  ]);
  if (stale(token)) return;
  let alerts = [];
  if (alertsFile) { try { alerts = JSON.parse(alertsFile.content); } catch (_) { alerts = []; } }
  if (!Array.isArray(alerts)) alerts = [];

  const rows = [];
  alerts.forEach((a, i) => rows.push(`
    <li class="todo-row"><button type="button" class="todo-main" data-todo="alert" data-i="${i}">
      <span class="todo-ico red">${TODO_ICONS.alert}</span>
      <span class="todo-text"><strong class="todo-alert-title">Alerte : ${escapeHtmlText(ALERT_CATEGORY_LABELS[a.category] || "à lire")}</strong><small>${escapeHtmlText((a.message || "").slice(0, 90))}${(a.message || "").length > 90 ? "…" : ""}</small></span>
      <span class="todo-chevron">${TODO_ICONS.chevron}</span>
    </button></li>`));
  loads.forEach((item, i) => rows.push(`
    <li class="todo-row" data-load-date="${item.date}"><button type="button" class="todo-main" data-todo="load" data-i="${i}">
      <span class="todo-ico gold">${TODO_ICONS.clock}</span>
      <span class="todo-text"><strong>RPE et durée : ${escapeHtmlText(item.session.name || "séance")}</strong><small class="todo-load-status">${item.date === todayISO() ? "Aujourd'hui" : "Hier"} · sinon la séance ne compte pas dans ta charge</small></span>
      <span class="todo-chevron">${TODO_ICONS.chevron}</span>
    </button><button type="button" class="todo-dismiss" data-todo="dismiss" data-i="${i}" aria-label="Ignorer cette saisie">${TODO_ICONS.close}</button></li>`));
  proposals.forEach((p, i) => rows.push(`
    <li class="todo-row"><button type="button" class="todo-main" data-todo="proposal" data-i="${i}">
      <span class="todo-ico green">${TODO_ICONS.arrow}</span>
      <span class="todo-text"><strong>${escapeHtmlText(p.title)}</strong><small>${escapeHtmlText(p.detail)}</small></span>
      <span class="todo-chevron">${TODO_ICONS.chevron}</span>
    </button></li>`));

  if (!rows.length) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <section class="card todo-card">
      <h2>À faire <span class="todo-count">· ${rows.length}</span></h2>
      <ul class="todo-list">${rows.join("")}</ul>
    </section>`;

  box.querySelectorAll("[data-todo]").forEach((btn) => {
    const i = +btn.dataset.i;
    btn.addEventListener("click", async () => {
      const kind = btn.dataset.todo;
      if (kind === "alert") openAlertSheet(alerts[i], () => loadTodo(state.renderToken).catch(() => {}));
      else if (kind === "proposal") proposals[i].go();
      else if (kind === "dismiss") {
        try { localStorage.setItem(quickLoadDismissKey(loads[i].date), "1"); } catch (_) {}
        loadTodo(state.renderToken).catch(() => {});
      } else if (kind === "load") {
        const status = btn.querySelector(".todo-load-status");
        try {
          const r = await promptSessionLoad(loads[i]);
          if (!r) return;
          status.textContent = `RPE ${r.rpe} · ${r.duration} min ${r.queued ? "gardés sur le téléphone" : "enregistrés"}`;
          setTimeout(() => loadTodo(state.renderToken).catch(() => {}), 1200);
        } catch (err) {
          status.textContent = `Échec : ${err.message}`;
        }
      }
    });
  });
}

// ============================================================================
// Carte « forme » (docs/adr/0072) — la réponse à « est-ce que je peux y
// aller aujourd'hui ? » en tête d'écran : score de forme (coach.readiness,
// précalculé dans summary.json), son niveau, et les deux repères qui le
// font bouger le plus souvent (sommeil 7 j, zone de charge). Le détail des
// composantes reste dans Progrès, ouvert d'un tap sur la carte.
// ============================================================================

const READINESS_RING = { pret: "#7BE0A0", bonne_forme: "#7BE0A0", vigilance: "#E8B857", repos_recommande: "#FF8A80" };

async function loadReadiness(token) {
  const box = document.getElementById("today-readiness");
  if (!box) return;
  const file = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  let summary = {};
  try { summary = file ? JSON.parse(file.content) : {}; } catch (_) { summary = {}; }
  const r = summary.readiness;
  if (!r || r.score == null) { box.innerHTML = ""; return; }
  const facts = [];
  const sleep = summary.sleep_recent;
  if (sleep && sleep.avg_7d != null) facts.push(`Sommeil ${formatHoursFr(sleep.avg_7d)} (7 j)`);
  const w = summary.workload;
  if (w && w.zone) facts.push(`Charge : ${(WORKLOAD_ZONE_LABELS[w.zone] || w.zone).toLowerCase()}`);
  const circ = 2 * Math.PI * 37;
  const dash = Math.max(0, Math.min(100, r.score)) / 100 * circ;
  const asOf = r.date && r.date !== todayISO() ? ` · au ${r.date.slice(8, 10)}/${r.date.slice(5, 7)}` : "";
  box.innerHTML = `
    <button type="button" class="readiness-hero" aria-label="Indice de forme ${r.score} sur 100 : ${escapeAttr(READINESS_LEVEL_LABELS[r.level] || r.level)}. Voir le détail dans Progrès">
      <span class="readiness-hero-ring">
        <svg viewBox="0 0 88 88" width="88" height="88" aria-hidden="true"><circle cx="44" cy="44" r="37" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="9"/><circle cx="44" cy="44" r="37" fill="none" stroke="${READINESS_RING[r.level] || "#7BE0A0"}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 44 44)"/></svg>
        <span class="readiness-hero-score">${r.score}</span>
      </span>
      <span class="readiness-hero-text">
        <span class="readiness-hero-kicker">Indice de forme${asOf}</span>
        <span class="readiness-hero-level">${escapeHtmlText(READINESS_LEVEL_LABELS[r.level] || r.level)}</span>
        ${facts.length ? `<span class="readiness-hero-facts">${facts.map(escapeHtmlText).join(" · ")}</span>` : ""}
      </span>
    </button>`;
  box.querySelector(".readiness-hero").addEventListener("click", () => showView("data"));
}

// ============================================================================
// Séance du jour (docs/adr/0072) — remplace la grille « Loguer la séance /
// Note vocale / Douleur » (déplacée dans le bouton +) par la séance elle-
// même : nom, premiers exercices prévus, et un seul bouton pour l'ouvrir.
// ============================================================================

function plannedLine(ex) {
  const p = ex.planned || {};
  const parts = [];
  if (p.sets && p.reps) parts.push(`${p.sets} × ${p.reps}`);
  else if (p.reps) parts.push(String(p.reps));
  if (p.load != null && p.load !== "") parts.push(`${p.load}${/^[\d.,]+$/.test(String(p.load)) ? " kg" : ""}`);
  return parts.join(" · ");
}

async function loadTodaySession(token) {
  const box = document.getElementById("today-session");
  if (!box) return;
  const date = todayISO();
  const day = await findSessionForDate(date);
  if (stale(token)) return;
  const session = day && day.session;
  const open = () => showView("session", { date });
  if (!session) {
    box.innerHTML = `
      <section class="card today-session today-session-empty">
        <p class="today-session-kicker">Aujourd'hui</p>
        <h2 class="today-session-name">Rien de prévu</h2>
        <button type="button" class="primary-button ghost today-session-open">Loguer une séance</button>
      </section>`;
    box.querySelector(".today-session-open").addEventListener("click", open);
    return;
  }
  const type = session.type || "musculation";
  const typeLabel = (SESSION_TYPES[type] && SESSION_TYPES[type].label) || type;
  if (type === "repos") {
    box.innerHTML = `
      <section class="card today-session today-session-rest">
        <div class="today-session-title">${kindIconHTML("repos")}<div><p class="today-session-kicker">Aujourd'hui</p>
        <h2 class="today-session-name">${escapeHtmlText(session.name || "Repos")}</h2></div></div>
        ${session.notes ? `<p class="muted small">${escapeHtmlText(session.notes)}</p>` : ""}
        <button type="button" class="primary-button ghost small today-session-open">Voir ou modifier</button>
      </section>`;
    box.querySelector(".today-session-open").addEventListener("click", open);
    return;
  }
  const exercises = session.exercises || [];
  const shown = exercises.slice(0, 3);
  const done = sessionHasExecuted(session);
  const meta = [typeLabel];
  if (session.session_duration_min) meta.push(`${session.session_duration_min} min`);
  box.innerHTML = `
    <section class="card today-session">
      <div class="today-session-tags"><span class="pill pill-gold">Séance du jour</span><span class="muted small">${escapeHtmlText(meta.join(" · "))}</span>${done ? '<span class="pill pill-ok">Loguée</span>' : ""}</div>
      <div class="today-session-title">${kindIconHTML(/match/i.test(session.name || "") ? "match" : type)}<h2 class="today-session-name">${escapeHtmlText(session.name || typeLabel)}</h2></div>
      ${shown.length ? `<ul class="today-session-list">${shown.map((ex) => `<li><span>${escapeHtmlText(ex.name || "Exercice")}</span><span class="today-session-planned">${escapeHtmlText(plannedLine(ex))}</span></li>`).join("")}${exercises.length > shown.length ? `<li class="muted">+ ${exercises.length - shown.length} exercice${exercises.length - shown.length > 1 ? "s" : ""}</li>` : ""}</ul>` : ""}
      ${session.notes ? `<p class="today-session-notes">${escapeHtmlText(session.notes)}</p>` : ""}
      <div class="today-session-actions">
        ${type === "musculation" && !done
          ? `<button type="button" class="primary-button today-session-start"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>Démarrer</button>`
          : `<button type="button" class="primary-button today-session-open">${done ? "Revoir la séance" : "Ouvrir la séance"}</button>`}
        ${done ? "" : '<button type="button" class="today-session-adapt">Adapter</button>'}
      </div>
      ${type === "musculation" && !done ? '<button type="button" class="today-session-form">Voir le détail de la séance</button>' : ""}
    </section>`;
  // « Démarrer » ouvre directement la séance guidée (ADR-0074) ; « Adapter »
  // ouvre « Ajuster ma semaine » pré-rempli pour cette séance (docs/adr/0076).
  const startBtn = box.querySelector(".today-session-start");
  if (startBtn) startBtn.addEventListener("click", () => { state.openLiveOnLoad = true; open(); });
  const openBtn = box.querySelector(".today-session-open");
  if (openBtn) openBtn.addEventListener("click", open);
  const formBtn = box.querySelector(".today-session-form");
  if (formBtn) formBtn.addEventListener("click", open);
  const adaptBtn = box.querySelector(".today-session-adapt");
  if (adaptBtn) adaptBtn.addEventListener("click", () => {
    state.adjustPrefill = `Séance du jour (${session.name || typeLabel}) : `;
    showView("adjust-week");
  });
}

export async function renderToday(token) {
  setupCredo();
  loadReadiness(token).catch(() => {});
  renderTodayDataCheck(token).catch(() => {});
  loadCheckin(token).catch(() => {});
  loadTodaySession(token).catch(() => {});
  loadTodo(token).catch(() => {});
  renderSystemStatus(token).catch(() => {});

  const genBtn = document.getElementById("generate-digest-button");
  const genStatus = document.getElementById("generate-digest-status");
  genBtn.addEventListener("click", async () => {
    genBtn.disabled = true;
    genStatus.textContent = "Déclenchement…";
    try {
      await ghDispatchWorkflow("daily-digest.yml");
      genStatus.textContent = "Lancé : nouveau digest dans 2 à 3 minutes. Rafraîchis ensuite pour le récupérer.";
    } catch (err) {
      genStatus.textContent = `Échec : ${err.message}`;
    } finally {
      genBtn.disabled = false;
    }
  });

  document.getElementById("today-digest-content").innerHTML = skeletonHTML();
  const digest = await latestFileOnOrBefore("data/digests", ".md", todayISO());
  if (stale(token)) return;
  const digestBox = document.getElementById("today-digest-content");
  document.getElementById("today-digest-date").textContent = digest && digest.date !== todayISO()
    ? `Le mot du coach · ${digest.date.slice(8, 10)}/${digest.date.slice(5, 7)}`
    : "Le mot du coach";
  digestBox.innerHTML = digest
    ? renderDigestSections(digest.content)
    : "<p class='muted'>Pas encore de digest généré.</p>";
  // Replié au-delà d'un écran (docs/adr/0072) : le digest reste entier, mais
  // ne repousse plus le reste de la page loin sous la ligne de flottaison.
  const expandBtn = document.getElementById("digest-expand");
  if (digest && digestBox.scrollHeight > 420) {
    digestBox.classList.add("digest-collapsed");
    expandBtn.hidden = false;
    expandBtn.addEventListener("click", () => {
      digestBox.classList.remove("digest-collapsed");
      expandBtn.hidden = true;
    });
  }
}
