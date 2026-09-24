import { setupCredo } from "../credo.js";
import { showView, stale, state } from "../nav.js";
import { todayISO } from "../date-utils.js";
import { skeletonHTML, escapeAttr, escapeHtmlText } from "../markdown.js";
import { ghDispatchWorkflow, ghGetFile, ghPutJSON } from "../github-api.js";
import { latestFileOnOrBefore } from "../training-index.js";
import { renderDigestSections } from "../plan-overview.js";

const ALERT_CATEGORY_LABELS = { blessure: "🩹 Blessure/douleur", sommeil: "😴 Sommeil", poids: "⚖️ Poids", charge: "📈 Charge" };

/** "Zone de blessure" — direct request : les alertes blessure/douleur
 * (`data/alerts/active.json`, catégorie `blessure`) méritent une place à
 * part sur Aujourd'hui, la première chose vue en ouvrant l'app, plutôt
 * que d'être noyées dans la liste multi-catégories de Semaine (où elles
 * restent aussi, repliées par défaut — voir loadActiveAlerts). Toujours
 * dépliée ici (jamais de `<details>`) : contrairement à Semaine, il n'y a
 * normalement qu'une seule alerte à la fois, et son intérêt même est
 * d'être vue tout de suite (consigne kiné, séance à éviter...), pas
 * repliée derrière un clic. Ne rend rien s'il n'y a aucune alerte
 * blessure en cours — jamais un encart vide sur un jour sans souci. */
async function loadInjuryZone(token) {
  const box = document.getElementById("injury-zone");
  const file = await ghGetFile("data/alerts/active.json");
  if (stale(token)) return;
  let alerts = [];
  if (file) { try { alerts = JSON.parse(file.content); } catch (_) { alerts = []; } }
  const injuryAlerts = Array.isArray(alerts) ? alerts.filter((a) => a.category === "blessure") : [];
  if (!injuryAlerts.length) { box.innerHTML = ""; return; }

  box.innerHTML = injuryAlerts
    .map((a) => `
      <section class="card alert-card injury-zone-card" data-alert-id="${escapeAttr(a.id || "")}">
        <h2>${ALERT_CATEGORY_LABELS[a.category] || "⚠️ Alerte"}</h2>
        <p>${escapeHtmlText(a.message || "")}</p>
        ${Array.isArray(a.advice) && a.advice.length ? `<ul class="alert-advice">${a.advice.map((adv) => `<li>${escapeHtmlText(adv)}</li>`).join("")}</ul>` : ""}
        ${a.resolution === "manual_or_note"
          ? `<div class="proposal-actions">
              <button type="button" class="primary-button ghost small alert-dismiss">✅ Marquer comme résolu</button>
            </div>
            <p class="muted small alert-status"></p>`
          : `<p class="muted small">Se lève automatiquement une fois la situation revenue à la normale.</p>`}
      </section>`)
    .join("");

  box.querySelectorAll(".alert-dismiss").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".injury-zone-card");
      const alertId = card.dataset.alertId;
      const statusEl = card.querySelector(".alert-status");
      btn.disabled = true;
      statusEl.textContent = "Mise à jour…";
      try {
        await ghPutJSON("data/alerts/active.json", [], "Alerte levée depuis l'app", (current) => {
          const list = Array.isArray(current) ? current : [];
          return list.filter((entry) => entry.id !== alertId);
        });
        loadInjuryZone(state.renderToken).catch(() => {});
      } catch (err) {
        statusEl.textContent = `Échec : ${err.message}`;
        btn.disabled = false;
      }
    });
  });
}

export async function renderToday(token) {
  setupCredo();
  loadInjuryZone(token).catch(() => {});

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
