import { ghGetFile, ghRecentCommits, ghDispatchWorkflow } from "./github-api.js";
import { escapeHtmlText } from "./markdown.js";
import { todayISO } from "./date-utils.js";
import { healthPath, checkinPath } from "./data-paths.js";
import { stale } from "./nav.js";

// ============================================================================
// « Données du jour » (docs/adr/0075) — retour direct : « savoir si l'app a
// reçu les données d'aujourd'hui ». « État du système » (ADR-0069) tolère un
// jour de retard sur la synchro Santé et vit replié en bas d'Aujourd'hui : un
// matin sans synchro passait pour « à jour » alors que le digest et l'indice
// de forme avaient été calculés sans la nuit. Cette carte ne regarde
// qu'aujourd'hui, en tête d'écran, et propose l'action qui débloque.
// ============================================================================

const SHORTCUT_NAME = "Push Santé Vers Coach";
const SHORTCUT_URL = `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}`;
const DIGEST_EXPECTED_AFTER_HOUR = 9;

const HEALTH_FIELDS = [
  { key: "sleep_stages", label: "sommeil" },
  { key: "resting_heart_rate", label: "FC repos" },
  { key: "hrv_ms", label: "HRV" },
  { key: "weight_kg", label: "poids" },
];

function hhmm(iso) {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** État des données du jour, sans rendu — testable à part.
 * Renvoie `{ health: {received, fields, at}, checkin, digest: {exists, at},
 * digestBeforeHealth }`. */
export async function loadTodayDataState(today = todayISO()) {
  const [healthFile, checkinFile, digestFile] = await Promise.all([
    ghGetFile(healthPath(today)).catch(() => null),
    ghGetFile(checkinPath(today)).catch(() => null),
    ghGetFile(`data/digests/${today}.md`).catch(() => null),
  ]);
  let record = {};
  if (healthFile) { try { record = JSON.parse(healthFile.content) || {}; } catch (_) { record = {}; } }
  const fields = HEALTH_FIELDS.filter((f) => record[f.key] != null && record[f.key] !== "").map((f) => f.label);
  const received = fields.length > 0;
  let checkinRecord = {};
  if (checkinFile) { try { checkinRecord = JSON.parse(checkinFile.content) || {}; } catch (_) { checkinRecord = {}; } }
  const checkin = !!(checkinRecord.arrival_state || checkinRecord.wellness || checkinRecord.mobility);
  // Heure d'arrivée de la synchro : le commit du raccourci (« santé du … »).
  // Le fichier santé n'est plus touché par l'app (ADR-0083).
  const [healthCommits, digestCommits] = await Promise.all([
    received ? ghRecentCommits(healthPath(today)) : Promise.resolve([]),
    digestFile ? ghRecentCommits(`data/digests/${today}.md`, 1) : Promise.resolve([]),
  ]);
  const syncCommit = healthCommits.find((c) => /^sant[ée] du/i.test(c.message));
  const healthAt = syncCommit ? syncCommit.date : null;
  const digestAt = digestCommits.length ? digestCommits[0].date : null;
  // Le digest dit lui-même quand il n'avait pas les mesures de la nuit.
  const digestSaysNoHealth = !!(digestFile && /pas de sommeil ni de FC|sans (tes |les )?donn[ée]es sant|pas encore re[çc]u (le |les )?(sommeil|donn)/i.test(digestFile.content));
  const digestBeforeHealth = !!(received && digestFile && (
    digestSaysNoHealth || (healthAt && digestAt && new Date(healthAt) > new Date(digestAt))
  ));
  return {
    health: { received, fields, at: healthAt },
    checkin,
    digest: { exists: !!digestFile, at: digestAt, missingHealth: digestSaysNoHealth },
    digestBeforeHealth,
  };
}

function row(status, title, detail, actionHTML = "") {
  return `
    <li class="data-check-row ${status}">
      <span class="data-check-dot" aria-hidden="true"></span>
      <div class="data-check-text"><strong>${escapeHtmlText(title)}</strong><span>${detail}</span>${actionHTML}</div>
    </li>`;
}

export async function renderTodayDataCheck(token) {
  const box = document.getElementById("today-data-check");
  if (!box) return;
  const hour = new Date().getHours();
  const s = await loadTodayDataState();
  if (stale(token)) return;

  const rows = [];
  let issues = 0;

  if (s.health.received) {
    const missing = HEALTH_FIELDS.map((f) => f.label).filter((l) => !s.health.fields.includes(l));
    rows.push(row("ok", "Données santé",
      `reçues${s.health.at ? ` à ${hhmm(s.health.at)}` : ""} : ${escapeHtmlText(s.health.fields.join(", "))}${missing.length ? ` (pas de ${escapeHtmlText(missing.join(", "))})` : ""}.`));
  } else {
    issues += 1;
    rows.push(row("warn", "Données santé",
      "pas encore reçues aujourd'hui (sommeil, FC repos, HRV, poids).",
      `<a class="data-check-action" href="${SHORTCUT_URL}">Lancer le raccourci Santé</a>`));
  }

  if (s.checkin) rows.push(row("ok", "Check-in", "fait."));
  else rows.push(row("info", "Check-in", "à faire, juste en dessous."));

  let relaunch = false;
  if (!s.digest.exists) {
    if (hour < DIGEST_EXPECTED_AFTER_HOUR) {
      rows.push(row("info", "Digest et indice de forme", "attendus à partir de 8h30."));
    } else {
      issues += 1;
      relaunch = true;
      rows.push(row("warn", "Digest et indice de forme", "pas encore calculés aujourd'hui."));
    }
  } else if (!s.health.received || s.digestBeforeHealth) {
    issues += 1;
    relaunch = s.health.received;
    rows.push(row("warn", "Digest et indice de forme",
      s.health.received
        ? "calculés avant l'arrivée de tes données santé : relance-les pour en tenir compte."
        : `calculés${s.digest.at ? ` à ${hhmm(s.digest.at)}` : ""} sans tes données santé de la nuit. Une fois le raccourci passé, relance-les.`));
  } else {
    rows.push(row("ok", "Digest et indice de forme", `calculés${s.digest.at ? ` à ${hhmm(s.digest.at)}` : ""} avec tes données du jour.`));
  }

  const relaunchHTML = relaunch
    ? `<button type="button" class="primary-button ghost small data-check-relaunch">Relancer le digest</button>`
    : "";

  box.innerHTML = `
    <details class="card data-check ${issues ? "has-issues" : "all-ok"}">
      <summary>
        <span class="data-check-badge" aria-hidden="true"></span>
        <span class="data-check-title">${issues ? `Données du jour : ${issues} point${issues > 1 ? "s" : ""} à régler` : "Données du jour reçues"}</span>
        <svg class="data-check-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </summary>
      <ul class="data-check-list">${rows.join("")}</ul>
      ${relaunchHTML}
      <p class="muted small data-check-note"></p>
    </details>`;

  const btn = box.querySelector(".data-check-relaunch");
  if (btn) {
    btn.addEventListener("click", async () => {
      const note = box.querySelector(".data-check-note");
      btn.disabled = true;
      note.textContent = "Déclenchement…";
      try {
        await ghDispatchWorkflow("daily-digest.yml");
        note.textContent = "Lancé : digest et indice de forme recalculés dans 2 à 3 minutes. Rafraîchis ensuite.";
      } catch (err) {
        note.textContent = `Échec : ${err.message}`;
        btn.disabled = false;
      }
    });
  }
}
