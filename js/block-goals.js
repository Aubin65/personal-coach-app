// ============================================================================
// Objectifs de bloc structurés (docs/adr/0123). La Forge de bloc saisissait
// les objectifs dans une zone de texte libre : rien n'indiquait qu'il fallait
// écrire « Back Squat : 100 → 108 kg » pour que Plan › Bloc les suive
// (coach.block_progress, ADR-0094). Ici : une ligne de texte ⇄ un objectif
// typé, dans les deux sens. Le stockage ne change pas (`sections.objectif`,
// une ligne par objectif) : le coach, `block_progress` et `blockMarkdown`
// continuent de lire le même texte.
// ============================================================================

/** Exercices proposés pour un objectif de charge — noms reconnus par
 * coach.block_progress (`_RATIO_EXERCISE_NAMES`, `_SECONDARY_LIFT_NAMES`). */
export const GOAL_LIFTS = [
  { name: "Back Squat", key: "back_squat" },
  { name: "Bench", key: "bench" },
  { name: "Trap Bar Deadlift", key: "trap_bar_deadlift" },
  { name: "Strict Press", key: "strict_press" },
  { name: "Tractions", key: "chin_up", hint: "lest ajouté" },
  { name: "Dips", key: null, hint: "lest ajouté" },
];

/** Zones pour « sans douleur … » — le premier mot suffit au suivi
 * (block_progress compare les 6 premières lettres à la zone signalée). */
export const GOAL_PAIN_ZONES = ["lombaire", "épaule", "genou", "ischio", "hanche", "cou", "cheville", "mollet", "poignet"];

const LIFT_RE = /^\s*([^:→]+?)\s*:\s*(\d+(?:[.,]\d+)?)\s*(?:kg)?\s*(?:→|->)\s*(\d+(?:[.,]\d+)?)\s*kg\s*(.*)$/i;
const FREQ_RE = /(\d+)\s*s[ée]ances?\s+de\s+(?:muscu|musculation)\b[^/]*?(?:\/\s*semaine|par\s+semaine)/i;
const PAIN_RE = /sans\s+(?:douleur|g[êe]ne)\s+([\wéèêàç'-]+)/i;

const num = (s) => Number(String(s).replace(",", "."));
export const fmtKg = (v) => String(Math.round(Number(v) * 10) / 10).replace(".", ",");

/** Ligne de texte → objectif typé. */
export function parseGoalLine(line) {
  const text = String(line || "").replace(/^\s*[-•*]\s*/, "").trim();
  const lift = LIFT_RE.exec(text);
  if (lift) {
    const note = lift[4].trim().replace(/^\((.*)\)$/, "$1").replace(/^[,;—–-]\s*/, "").trim();
    return { kind: "lift", exercise: lift[1].trim(), start: num(lift[2]), target: num(lift[3]), note };
  }
  const freq = FREQ_RE.exec(text);
  if (freq) {
    const pain = PAIN_RE.exec(text);
    return { kind: "frequency", perWeek: Number(freq[1]), painZone: pain ? pain[1].toLowerCase() : "", text };
  }
  return { kind: "other", text };
}

/** Objectif typé → ligne de texte, dans la forme que coach.block_progress
 * sait suivre. Une ligne de fréquence déjà écrite (`text`) est gardée telle
 * quelle si son nombre et sa zone n'ont pas changé. */
export function goalLine(g) {
  if (g.kind === "lift") {
    return `${g.exercise} : ${fmtKg(g.start)} → ${fmtKg(g.target)} kg${g.note ? ` (${g.note})` : ""}`;
  }
  if (g.kind === "frequency") {
    if (g.text) {
      const p = parseGoalLine(g.text);
      if (p.kind === "frequency" && p.perWeek === g.perWeek && p.painZone === (g.painZone || "")) return g.text;
    }
    return `${g.perWeek} séances de muscu/semaine${g.painZone ? `, sans douleur ${g.painZone}` : ""}`;
  }
  return String(g.text || "").trim();
}

export function goalsFromText(text) {
  return String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).map(parseGoalLine);
}

export function textFromGoals(goals) {
  return goals.map(goalLine).filter(Boolean).join("\n");
}

/** Un objectif est-il suivi automatiquement dans Plan › Bloc ? */
export const isTracked = (g) => g.kind === "lift" || g.kind === "frequency";
