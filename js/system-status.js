import { ghListDir, ghGetFile, ghDispatchWorkflow, lastDispatchResult } from "./github-api.js";
import { escapeHtmlText } from "./markdown.js";
import { todayISO } from "./date-utils.js";
import { stale } from "./nav.js";

// ============================================================================
// "État du système" (docs/adr/0069) — retour direct après trois pannes
// silencieuses en une semaine (digest démarré 4h en retard, raccourci Santé
// bloqué par iOS, permission Actions refusée au token) : chacune n'était
// découverte que parce que quelque chose manquait. Un encart sur Aujourd'hui
// dit lequel des fournisseurs de données est en retard et quoi faire.
// ============================================================================

const HEALTH_SYNC_KEYS = ["sleep_stages", "weight_kg", "resting_heart_rate", "hrv_ms"];
const HEALTH_FILES_TO_SCAN = 5;
const HEALTH_MAX_LAG_DAYS = 1;
const DIGEST_EXPECTED_AFTER_HOUR = 9;
const CHAT_PENDING_WARN_MINUTES = 20;

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T12:00:00`) - new Date(`${fromIso}T12:00:00`)) / 86400000);
}

function frDay(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function frTime(iso) {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** Date du digest le plus récent (≤ aujourd'hui), ou `null`. */
export async function latestDigestDate(today) {
  const entries = await ghListDir("data/digests");
  const dates = entries
    .filter((e) => e.type === "file" && e.name.endsWith(".md"))
    .map((e) => e.name.slice(0, -3))
    .filter((d) => d <= today)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/** Dernière date dont le fichier `data/health/` porte une vraie donnée du
 * raccourci Santé — pas seulement un check-in ou une douleur saisie dans
 * l'app, qui créent aussi un fichier ce jour-là. */
async function latestHealthSyncDate() {
  const entries = await ghListDir("data/health");
  const names = entries.filter((e) => e.type === "file" && e.name.endsWith(".json")).map((e) => e.name).sort().reverse();
  for (const name of names.slice(0, HEALTH_FILES_TO_SCAN)) {
    const file = await ghGetFile(`data/health/${name}`);
    if (!file) continue;
    let record;
    try { record = JSON.parse(file.content); } catch (_) { continue; }
    if (record && HEALTH_SYNC_KEYS.some((k) => record[k] != null)) return name.slice(0, -5);
  }
  return null;
}

async function unansweredChatMinutes() {
  const file = await ghGetFile("data/app-chat/conversation.json");
  if (!file) return null;
  let conv;
  try { conv = JSON.parse(file.content); } catch (_) { return null; }
  if (!Array.isArray(conv) || !conv.length) return null;
  const last = conv[conv.length - 1];
  if (last.role !== "user" || !last.at) return null;
  return Math.round((Date.now() - new Date(last.at).getTime()) / 60000);
}

function rowHTML(status, label, detail, actionHTML = "") {
  const icon = status === "ok" ? "✅" : status === "warn" ? "⚠️" : "•";
  return `<li class="system-status-row ${status}"><span class="system-status-icon">${icon}</span><div><strong>${escapeHtmlText(label)}</strong> — ${detail}${actionHTML}</div></li>`;
}

export async function renderSystemStatus(token) {
  const box = document.getElementById("system-status");
  if (!box) return;
  const today = todayISO();
  const hour = new Date().getHours();

  const [healthDate, digestDate, chatMinutes] = await Promise.all([
    latestHealthSyncDate().catch(() => undefined),
    latestDigestDate(today).catch(() => undefined),
    unansweredChatMinutes().catch(() => null),
  ]);
  if (stale(token)) return;

  const rows = [];

  if (healthDate === undefined) {
    rows.push(rowHTML("info", "Synchro santé", "vérification impossible pour l'instant."));
  } else if (healthDate === null) {
    rows.push(rowHTML("warn", "Synchro santé", "aucune donnée du raccourci Santé trouvée. Vérifie le raccourci « Push Santé Vers Coach » (docs/apple-health-shortcut.md)."));
  } else if (daysBetween(healthDate, today) > HEALTH_MAX_LAG_DAYS) {
    rows.push(rowHTML("warn", "Synchro santé", `dernière donnée du ${frDay(healthDate)} (${daysBetween(healthDate, today)} jours). Lance le raccourci à la main ; s'il affiche « partager des éléments Santé n'est pas autorisé », active Réglages → Raccourcis → Avancé → Autoriser le partage de grandes quantités de données.`));
  } else if (healthDate === today) {
    rows.push(rowHTML("ok", "Synchro santé", "données d'aujourd'hui reçues."));
  } else {
    // Un jour de retard reste « normal » pour le circuit (raccourci pas
    // encore passé ce matin), mais ce n'est plus marqué comme à jour : le
    // détail du jour est dans « Données du jour » (docs/adr/0075).
    rows.push(rowHTML("info", "Synchro santé", `dernière donnée du ${frDay(healthDate)} ; celles d'aujourd'hui pas encore reçues.`));
  }

  let digestNeedsAction = false;
  if (digestDate === undefined) {
    rows.push(rowHTML("info", "Digest", "vérification impossible pour l'instant."));
  } else if (digestDate === today) {
    rows.push(rowHTML("ok", "Digest", "celui d'aujourd'hui est prêt."));
  } else if (hour < DIGEST_EXPECTED_AFTER_HOUR) {
    rows.push(rowHTML("info", "Digest", `pas encore celui d'aujourd'hui (attendu vers ${DIGEST_EXPECTED_AFTER_HOUR}h) — dernier : ${digestDate ? frDay(digestDate) : "aucun"}.`));
  } else {
    digestNeedsAction = true;
    rows.push(rowHTML("warn", "Digest", `pas encore celui d'aujourd'hui (le déclenchement automatique de GitHub peut avoir plusieurs heures de retard).`, ` <button type="button" class="primary-button ghost small system-launch-digest">🔄 Lancer maintenant</button>`));
  }

  const dispatch = lastDispatchResult();
  if (!dispatch) {
    rows.push(rowHTML("info", "Déclenchements immédiats", "pas encore testés depuis cet appareil (se vérifient au prochain envoi d'un message ou d'un digest)."));
  } else if (dispatch.ok) {
    rows.push(rowHTML("ok", "Déclenchements immédiats", `dernier réussi à ${frTime(dispatch.at)}.`));
  } else {
    rows.push(rowHTML("warn", "Déclenchements immédiats", `refusé à ${frTime(dispatch.at)} : le token n'a sans doute pas la permission Actions en lecture/écriture. Les réponses du coach passent alors par le cycle lent (docs/app-deploy.md).`));
  }

  if (chatMinutes != null && chatMinutes >= CHAT_PENDING_WARN_MINUTES) {
    rows.push(rowHTML("warn", "Coach", `ton dernier message attend une réponse depuis ${chatMinutes} min.`));
  }

  const warnings = rows.filter((r) => r.includes('class="system-status-row warn"')).length;
  box.innerHTML = `
    <details class="card system-status-card"${warnings ? " open" : ""}>
      <summary>🩺 État du système — ${warnings ? `${warnings} point(s) à vérifier` : "tout est à jour"}</summary>
      <ul class="system-status-list small">${rows.join("")}</ul>
      <p class="muted small system-status-note"></p>
    </details>`;

  const launchBtn = box.querySelector(".system-launch-digest");
  if (launchBtn && digestNeedsAction) {
    launchBtn.addEventListener("click", async () => {
      const note = box.querySelector(".system-status-note");
      launchBtn.disabled = true;
      note.textContent = "Déclenchement…";
      try {
        await ghDispatchWorkflow("daily-digest.yml");
        note.textContent = "Lancé ✓ — nouveau digest dans quelques minutes, puis ⟳ pour le récupérer.";
      } catch (err) {
        note.textContent = `Échec : ${err.message}`;
        launchBtn.disabled = false;
      }
    });
  }
}
