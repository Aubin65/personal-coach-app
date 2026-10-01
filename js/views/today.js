import { setupCredo } from "../credo.js";
import { showView, stale, state } from "../nav.js";
import { todayISO } from "../date-utils.js";
import { skeletonHTML, escapeAttr, escapeHtmlText } from "../markdown.js";
import { ghDispatchWorkflow, ghGetFile, ghPutJSON } from "../github-api.js";
import { latestFileOnOrBefore } from "../training-index.js";
import { renderDigestSections } from "../plan-overview.js";
import { setupMicButton } from "../voice-input.js";

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

function checkinSummaryHTML(wellness, mobility) {
  const parts = [];
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

function checkinFormHTML(wellness, mobility, hidden) {
  const mobilityChips = MOBILITY_DONE_OPTIONS
    .map((o) => `<button type="button" class="suggestion-chip${mobility && mobility.done === o.id ? " active" : ""}" data-mobility-done="${o.id}">${o.label}</button>`)
    .join("");
  const wellnessRows = WELLNESS_DIMENSIONS.map((dim) => wellnessChipsRowHTML(dim, wellness ? wellness[dim.key] : null)).join("");
  return `
    <div class="checkin-form"${hidden ? " hidden" : ""}>
      <p class="small checkin-section-title">Étirements du matin</p>
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
    const mobilityDoneChip = card.querySelector("[data-mobility-done].active");
    const stiffnessEl = card.querySelector("#checkin-stiffness");
    const noteEl = card.querySelector("#checkin-note");
    const wellness = {};
    for (const dim of WELLNESS_DIMENSIONS) {
      const chip = card.querySelector(`[data-wellness="${dim.key}"].active`);
      if (chip) wellness[dim.key] = Number(chip.dataset.value);
    }
    if (!mobilityDoneChip) { statusEl.textContent = "Indique si tu as fait tes étirements."; return; }
    if (Object.keys(wellness).length < WELLNESS_DIMENSIONS.length) { statusEl.textContent = "Complète les 4 curseurs de bien-être."; return; }

    const date = todayISO();
    const mobility = {
      done: mobilityDoneChip.dataset.mobilityDone,
      stiffness: stiffnessEl.value !== "" ? Number(stiffnessEl.value) : null,
      note: noteEl.value.trim() || null,
    };

    btn.disabled = true;
    statusEl.textContent = "Enregistrement…";
    try {
      await ghPutJSON(`data/health/${date}.json`, { date }, `App : check-in du matin du ${date}`, (current) => {
        const base = current || { date };
        base.wellness = wellness;
        base.mobility = mobility;
        return base;
      });
      // Patch local plutôt qu'un re-fetch de data/app/summary.json (pas
      // encore régénéré à ce stade, seul le prochain digest le fera) —
      // même motif que le composer de performance match (calendar.js).
      statusEl.textContent = "";
      card.querySelector(".checkin-summary-slot").innerHTML = checkinSummaryHTML({ ...wellness, score: wellnessScore(wellness) }, mobility);
      card.querySelector(".checkin-form").hidden = true;
      wireCheckinEditButton(card);
    } catch (err) {
      statusEl.textContent = `Échec : ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

async function loadCheckin(token) {
  const box = document.getElementById("checkin-content");
  const file = await ghGetFile("data/app/summary.json");
  if (stale(token)) return;
  const s = file ? JSON.parse(file.content) : {};
  const wellnessToday = (s.wellness_recent || {}).today || null;
  const mobilityToday = (s.mobility_recent || {}).today || null;
  const alreadyLogged = !!(wellnessToday || mobilityToday);

  box.innerHTML = `
    <section class="card checkin-card">
      <h2>🌅 Check-in du matin</h2>
      <div class="checkin-summary-slot">${alreadyLogged ? checkinSummaryHTML(wellnessToday, mobilityToday) : ""}</div>
      ${checkinFormHTML(wellnessToday, mobilityToday, alreadyLogged)}
    </section>`;
  wireCheckinForm(box);
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
