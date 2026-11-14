// ============================================================================
// Indicateurs d'écran verrouillé pendant la séance guidée (docs/adr/0121).
// Une seule notification locale (tag « live-session »), remplacée à chaque
// changement d'état : exercice et série en cours, cible, fin du repos.
// Limites assumées d'une PWA : pas de Live Activity ni de compte à rebours
// animé — le repos s'affiche en HEURE DE FIN (« jusqu'à 18:42 »), seule forme
// qui reste juste sans mise à jour ; l'alerte « repos terminé » dépend d'un
// JavaScript encore actif (fiable écran allumé, best effort écran verrouillé).
// ============================================================================

const TAG = "live-session";
const OFF_KEY = "coach.lockscreen";
let lastText = "";

export function lockscreenEnabled() {
  try { return localStorage.getItem(OFF_KEY) !== "off"; } catch (_) { return true; }
}

function canNotify() {
  return typeof Notification !== "undefined" && Notification.permission === "granted" && "serviceWorker" in navigator && lockscreenEnabled();
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** Texte de la notification à partir de l'état de la séance guidée, ou `null`.
 * `s` : {position, total, name, setNo, target, plan, restEnd, now, restDone}. */
export function statusText(s) {
  const step = `${s.position}/${s.total}`;
  const next = s.target != null && s.setNo > s.target ? "Exercice terminé" : `Série ${s.setNo}${s.target != null ? `/${s.target}` : ""}${s.plan ? ` · ${s.plan}` : ""}`;
  if (s.restDone) return { title: "⏱ Repos terminé", body: `${s.name} — ${next}`, alert: true };
  if (s.restEnd && s.restEnd > s.now) return { title: `⏱ Repos jusqu'à ${hhmm(s.restEnd)}`, body: `Ensuite : ${s.name} — ${next}`, alert: false };
  return { title: `🏋️ ${s.name}`, body: `${next} · exercice ${step}`, alert: false };
}

export async function publishStatus(s) {
  if (!canNotify()) return;
  const t = statusText(s);
  const key = `${t.title}|${t.body}`;
  if (key === lastText) return;
  lastText = key;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(t.title, {
      body: t.body, tag: TAG, renotify: t.alert, silent: !t.alert, vibrate: t.alert ? [200, 100, 200] : undefined,
      icon: "./icons/icon-192.png", badge: "./icons/icon-192.png", data: { url: "./?go=session" },
    });
  } catch (_) { /* notification facultative */ }
}

/** Retire la notification (fin/abandon de la séance, ou reste d'une séance précédente). */
export async function clearStatus() {
  lastText = "";
  if (typeof Notification === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    (await reg.getNotifications({ tag: TAG })).forEach((n) => n.close());
  } catch (_) { /* rien à retirer */ }
}
