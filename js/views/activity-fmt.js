// Formats et libellés partagés par Progrès › Activité (activity.js, activity-chart.js).
export const TYPE_LABELS = { musculation: "Muscu", rugby: "Rugby", match: "Match", autre: "Autre" };
export const TYPE_ORDER = ["musculation", "rugby", "match", "autre"];

export function fmtMinutes(min) {
  if (!min) return "0 min";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}
/** Charge de séance = RPE × minutes, en unités arbitraires (u.a.). */
export function fmtLoad(ua) {
  return `${Math.round(ua || 0).toLocaleString("fr-FR")} u.a.`;
}
export function fmtTonnage(kg) {
  if (!kg) return "0 kg";
  return kg >= 10000 ? `${(kg / 1000).toFixed(1).replace(".", ",")} t` : `${Math.round(kg).toLocaleString("fr-FR")} kg`;
}
export const rpeText = (v) => String(v).replace(".", ",");
