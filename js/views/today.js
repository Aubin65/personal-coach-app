import { setupCredo } from "../credo.js";
import { showView, stale, state } from "../nav.js";
import { todayISO, sessionHasExecuted } from "../date-utils.js";
import { findSessionForDate } from "../training-index.js";
import { postUserMessage, dispatchStatusNote } from "./chat.js";
import { skeletonHTML, escapeAttr, escapeHtmlText } from "../markdown.js";
import { ghDispatchWorkflow, ghGetFile, ghPutJSON } from "../github-api.js";
import { latestFileOnOrBefore } from "../training-index.js";
import { renderDigestSections } from "../plan-overview.js";
import { setupMicButton } from "../voice-input.js";
import { renderSystemStatus, latestDigestDate } from "../system-status.js";

const ALERT_CATEGORY_LABELS = { blessure: "🩹 Blessure/douleur", sommeil: "😴 Sommeil", poids: "⚖️ Poids", charge: "📈 Charge", prepa_physique: "🏋️ Préparation physique" };

// ============================================================================
// Check-in du matin (docs/adr/0065) — retour direct : "questionnaire de
// bien-être subjectif quotidien" + "suivi de compliance de la routine
// d'étirements du matin". Un seul composer, un seul Enregistrer pour les
// deux (mêmes 15 secondes du matin), écrit sur data/health/<date>.json
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
      <button type="button" class="primary-button ghost small checkin-edit">✏️ Modifier</button>
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
  const arrivalChips = ARRIVAL_STATE_OPTIONS
    .map((o) => `<button type="button" class="suggestion-chip${arrivalState && arrivalState.state === o.id ? " active" : ""}" data-arrival-state="${o.id}" title="${o.label}">${o.emoji} ${o.label}</button>`)
    .join("");
  const mobilityChips = MOBILITY_DONE_OPTIONS
    .map((o) => `<button type="button" class="suggestion-chip${mobility && mobility.done === o.id ? " active" : ""}" data-mobility-done="${o.id}">${o.label}</button>`)
    .join("");
  const wellnessRows = WELLNESS_DIMENSIONS.map((dim) => wellnessChipsRowHTML(dim, wellness ? wellness[dim.key] : null)).join("");
  return `
    <div class="checkin-form"${hidden ? " hidden" : ""}>
      <p class="small checkin-section-title">Comment tu arrives ce matin</p>
      <div class="suggestion-chips">${arrivalChips}</div>
      <p class="small checkin-section-title" style="margin-top:10px">Étirements du matin</p>
      <div class="suggestion-chips">${mobilityChips}</div>
      <div class="exercise-log-grid full" style="margin-top:8px">
        <div><label>Raideur ressentie (0-10)</label><input type="number" id="checkin-stiffness" min="0" max="10" step="1" value="${mobility && mobility.stiffness != null ? mobility.stiffness : ""}" placeholder="0-10"></div>
      </div>
      <p class="small checkin-section-title" style="margin-top:14px">Bien-être du jour</p>
      ${wellnessRows}
      <div class="compose-row" style="margin-top:10px">
        <textarea id="checkin-note" rows="2" placeholder="Note libre (optionnel)">${mobility && mobility.note ? escapeHtmlText(mobility.note) : ""}</textarea>
        <button type="button" class="mic-button" id="checkin-mic" title="Dicter" aria-label="Dicter">🎙️</button>
      </div>
      <p class="voice-hint" id="checkin-voice-hint" hidden></p>
      <p class="live-caption" id="checkin-live-caption" hidden></p>
      <button type="button" class="primary-button small" id="checkin-save" style="margin-top:10px">Enregistrer</button>
      <p class="muted small" id="checkin-status"></p>
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
      if (e.arrival) {
        const opt = ARRIVAL_STATE_OPTIONS.find((o) => o.id === e.arrival.state);
        parts.push(`${opt ? `${opt.emoji} ${opt.label}` : escapeHtmlText(String(e.arrival.state))}`);
      }
      if (e.wellness) parts.push(`bien-être ${e.wellness.score}/100`);
      if (e.mobility) {
        const doneLabel = MOBILITY_DONE_LABELS[e.mobility.done] || e.mobility.done;
        parts.push(`étirements ${escapeHtmlText(String(doneLabel))}${e.mobility.stiffness != null ? ` (raideur ${e.mobility.stiffness}/10)` : ""}`);
      }
      return `<li><strong>${label}</strong> — ${parts.join(" · ") || "—"}</li>`;
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
function wireCheckinEditButton(card) {
  const editBtn = card.querySelector(".checkin-edit");
  if (!editBtn) return;
  editBtn.addEventListener("click", () => {
    card.querySelector(".checkin-summary").hidden = true;
    card.querySelector(".checkin-form").hidden = false;
  });
}

function wireCheckinForm(card) {
  const micBtn = card.querySelector("#checkin-mic");
  if (micBtn) {
    setupMicButton(micBtn, card.querySelector("#checkin-voice-hint"), card.querySelector("#checkin-note"), card.querySelector("#checkin-live-caption"));
  }

  card.querySelectorAll("[data-arrival-state]").forEach((chip) => {
    chip.addEventListener("click", () => {
      card.querySelectorAll("[data-arrival-state]").forEach((c) => c.classList.toggle("active", c === chip));
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
      await ghPutJSON(`data/health/${date}.json`, { date }, `App : check-in du matin du ${date}`, (current) => {
        const base = current || { date };
        healthSynced = !!base.sleep_stages;
        base.arrival_state = arrivalState;
        base.wellness = wellness;
        base.mobility = mobility;
        return base;
      });
      // Patch local plutôt qu'un re-fetch de data/app/summary.json (pas
      // encore régénéré à ce stade, seul le prochain digest le fera) —
      // même motif que le composer de performance match (calendar.js).
      statusEl.textContent = "";
      const wellnessWithScore = { ...wellness, score: wellnessScore(wellness) };
      card.querySelector(".checkin-summary-slot").innerHTML = checkinSummaryHTML(wellnessWithScore, mobility, arrivalState);
      card.querySelector(".checkin-form").hidden = true;
      wireCheckinEditButton(card);
      maybeLaunchDigestAfterCheckin(date, healthSynced, statusEl);
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
async function maybeLaunchDigestAfterCheckin(date, healthSynced, statusEl) {
  if (!healthSynced) return;
  const flagKey = `coach_digest_autolaunch_${date}`;
  try { if (localStorage.getItem(flagKey)) return; } catch (_) {}
  try {
    const latest = await latestDigestDate(date);
    if (latest === date) return;
    await ghDispatchWorkflow("daily-digest.yml");
    try { localStorage.setItem(flagKey, "1"); } catch (_) {}
    statusEl.textContent = "Digest du jour lancé automatiquement — il tiendra compte de ton check-in (⟳ dans quelques minutes).";
  } catch (_) {
    // pas de message ici : "État du système" rend compte d'un refus
  }
}

/** Lit le check-in du jour directement dans `data/health/<date>.json`, la
 * source de vérité écrite par "Enregistrer" — pas dans `data/app/summary.json`,
 * qui n'est régénéré qu'à chaque digest : un check-in tout juste enregistré
 * y restait invisible, le composer se rouvrait vierge et on pouvait
 * enregistrer le matin une deuxième fois. Le résumé ne sert plus que pour
 * l'historique des jours précédents. */
async function loadCheckin(token) {
  const box = document.getElementById("checkin-content");
  const date = todayISO();
  const [summaryFile, liveFile] = await Promise.all([ghGetFile("data/app/summary.json"), ghGetFile(`data/health/${date}.json`)]);
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
      <h2>🌅 Check-in du matin</h2>
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

/** Persistent alert cards — direct request : toutes les alertes
 * (`data/alerts/active.json`, les 4 catégories) sur Aujourd'hui, la
 * première chose vue en ouvrant l'app, et plus du tout dans Semaine
 * (déplacé depuis là, voir docs/adr/0045/0052/0053) — repliées par
 * défaut (`<details>`, direct request : "trop verbeuses à l'écran",
 * surtout avec plusieurs alertes empilées).
 * `resolution: "auto"` entries (sommeil, poids, charge) sont gérées
 * entièrement par `coach.alerts.sync_active_alerts` et disparaissent
 * d'elles-mêmes une fois le signal levé — pas de bouton de résolution
 * pour celles-ci, cliquer n'y changerait rien tant que le signal reste
 * vrai. `resolution: "manual_or_note"` (jugement du coach, ex. une
 * blessure) peut aussi être levée par le coach depuis une note vocale,
 * mais garde toujours un bouton manuel, le coach ne détecte pas
 * forcément la résolution tout seul. */
async function loadActiveAlerts(token) {
  const box = document.getElementById("active-alerts");
  const file = await ghGetFile("data/alerts/active.json");
  if (stale(token)) return;
  let alerts = [];
  if (file) { try { alerts = JSON.parse(file.content); } catch (_) { alerts = []; } }
  if (!Array.isArray(alerts) || alerts.length === 0) { box.innerHTML = ""; return; }

  box.innerHTML = alerts
    .map((a) => `
      <details class="card alert-card" data-alert-id="${escapeAttr(a.id || "")}">
        <summary>⚠️ ${ALERT_CATEGORY_LABELS[a.category] || "Alerte"}</summary>
        <p>${escapeHtmlText(a.message || "")}</p>
        ${Array.isArray(a.advice) && a.advice.length ? `<ul class="alert-advice">${a.advice.map((adv) => `<li>${escapeHtmlText(adv)}</li>`).join("")}</ul>` : ""}
        ${a.resolution === "manual_or_note"
          ? `<div class="proposal-actions">
              <button type="button" class="primary-button ghost small alert-dismiss">✅ Marquer comme résolu</button>
            </div>
            <p class="muted small alert-status"></p>`
          : `<p class="muted small">Se lève automatiquement une fois la situation revenue à la normale.</p>`}
      </details>`)
    .join("");

  box.querySelectorAll(".alert-dismiss").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".alert-card");
      const alertId = card.dataset.alertId;
      const statusEl = card.querySelector(".alert-status");
      btn.disabled = true;
      statusEl.textContent = "Mise à jour…";
      try {
        await ghPutJSON("data/alerts/active.json", [], "Alerte levée depuis l'app", (current) => {
          const list = Array.isArray(current) ? current : [];
          return list.filter((entry) => entry.id !== alertId);
        });
        loadActiveAlerts(state.renderToken).catch(() => {});
      } catch (err) {
        statusEl.textContent = `Échec : ${err.message}`;
        btn.disabled = false;
      }
    });
  });
}

export async function renderToday(token) {
  setupCredo();
  loadCheckin(token).catch(() => {});
  loadActiveAlerts(token).catch(() => {});
  renderSystemStatus(token).catch(() => {});

  document.getElementById("adjust-week-cta").addEventListener("click", () => showView("adjust-week"));

  document.querySelectorAll("#today-quick-actions [data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      showView(action, action === "session" ? { date: todayISO() } : {});
    });
  });

  const genBtn = document.getElementById("generate-digest-button");
  const genStatus = document.getElementById("generate-digest-status");
  genBtn.addEventListener("click", async () => {
    genBtn.disabled = true;
    genStatus.textContent = "Déclenchement…";
    try {
      await ghDispatchWorkflow("daily-digest.yml");
      genStatus.textContent = "Lancé ✓ — nouveau digest dans quelques minutes, puis ⟳ pour le récupérer.";
    } catch (err) {
      genStatus.textContent = `Échec : ${err.message}`;
    } finally {
      genBtn.disabled = false;
    }
  });

  document.getElementById("today-digest-content").innerHTML = skeletonHTML();
  const digest = await latestFileOnOrBefore("data/digests", ".md", todayISO());
  if (stale(token)) return;
  document.getElementById("today-digest-date").textContent = digest ? `Digest du ${digest.date}` : "Digest";
  document.getElementById("today-digest-content").innerHTML = digest
    ? renderDigestSections(digest.content)
    : "<p class='muted'>Pas encore de digest généré.</p>";
}
