import { setupCredo } from "../credo.js";
import { showView, stale, state } from "../nav.js";
import { todayISO } from "../date-utils.js";
import { skeletonHTML, escapeAttr, escapeHtmlText } from "../markdown.js";
import { ghDispatchWorkflow, ghGetFile, ghPutJSON } from "../github-api.js";
import { latestFileOnOrBefore } from "../training-index.js";
import { renderDigestSections } from "../plan-overview.js";

const ALERT_CATEGORY_LABELS = { blessure: "🩹 Blessure/douleur", sommeil: "😴 Sommeil", poids: "⚖️ Poids", charge: "📈 Charge" };

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
