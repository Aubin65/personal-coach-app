import { todayISO } from "./date-utils.js";

// ============================================================================
// Credo — a short motto shown big at the top of Aujourd'hui. Fixed, real,
// sourced quotes (not user-editable — see conversation) picked for the
// rugby/return-from-injury/discipline theme, rotating one per day so it
// stays a little alive without any moving parts. Kept short deliberately:
// popular "inspirational quotes" are frequently misattributed online, so
// this list only has ones with a real, checkable source — a majority
// pulled from la philosophie stoïcienne (Marc Aurèle, Épictète, Sénèque)
// depuis que son thème central (ce qui dépend de nous / ce qui n'en
// dépend pas, l'obstacle qui devient le chemin) transfère directement à
// une reprise après blessure. Écarte volontairement le fameux "Nous
// sommes ce que nous répétons..." souvent crédité à Aristote — cette
// formulation est en réalité une paraphrase de Will Durant de l'Éthique à
// Nicomaque, pas une phrase qu'Aristote a réellement écrite, exactement
// le genre de mésattribution que cette liste évite.
// ============================================================================
const CREDO_QUOTES = [
  {
    text: "Le sport a le pouvoir de changer le monde. Il a le pouvoir d'inspirer. Il a le pouvoir de rassembler les gens comme peu de choses le peuvent.",
    author: "Nelson Mandela",
    source: "discours aux Laureus World Sports Awards, 2000",
  },
  {
    text: "Ce n'est pas d'être terrassé qui compte, c'est de se relever.",
    author: "Vince Lombardi",
  },
  {
    text: "Ce n'est pas parce que les choses sont difficiles que nous n'osons pas ; c'est parce que nous n'osons pas qu'elles sont difficiles.",
    author: "Sénèque",
    source: "Lettres à Lucilius",
  },
  {
    text: "La discipline est le pont entre les objectifs et leur accomplissement.",
    author: "Jim Rohn",
  },
  {
    text: "Tu as pouvoir sur ton esprit, non sur les événements extérieurs. Comprends cela, et tu trouveras la force.",
    author: "Marc Aurèle",
    source: "Pensées pour moi-même, Livre II",
  },
  {
    text: "Ce qui fait obstacle à l'action favorise l'action. Ce qui se met en travers du chemin devient le chemin.",
    author: "Marc Aurèle",
    source: "Pensées pour moi-même, Livre V",
  },
  {
    text: "La meilleure façon de se venger est de ne pas imiter celui qui a fait le mal.",
    author: "Marc Aurèle",
    source: "Pensées pour moi-même, Livre VI",
  },
  {
    text: "Ce ne sont pas les choses qui troublent les hommes, mais les opinions qu'ils en ont.",
    author: "Épictète",
    source: "Manuel, chapitre V",
  },
  {
    text: "Ne demande pas que les choses arrivent comme tu le souhaites, mais souhaite qu'elles arrivent comme elles arrivent, et ta vie s'écoulera paisiblement.",
    author: "Épictète",
    source: "Manuel, chapitre VIII",
  },
  {
    text: "Le feu éprouve l'or, l'adversité éprouve les hommes forts.",
    author: "Sénèque",
    source: "De la Providence",
  },
  {
    text: "Vivre, Lucilius, c'est combattre.",
    author: "Sénèque",
    source: "Lettres à Lucilius, Lettre 96",
  },
  {
    text: "Il n'y a pas de vent favorable pour celui qui ne sait pas vers quel port il navigue.",
    author: "Sénèque",
    source: "Lettres à Lucilius, Lettre 71",
  },
  {
    text: "Le caractère de l'homme est son destin.",
    author: "Héraclite",
    source: "Fragment 119",
  },
];

export function dayOfYear(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000);
}

export function credoOfTheDay() {
  return CREDO_QUOTES[dayOfYear(todayISO()) % CREDO_QUOTES.length];
}

export function setupCredo() {
  const textEl = document.getElementById("credo-text");
  const sourceEl = document.getElementById("credo-source");
  if (!textEl) return;
  const q = credoOfTheDay();
  textEl.textContent = q.text;
  if (sourceEl) sourceEl.textContent = `— ${q.author}${q.source ? ` (${q.source})` : ""}`;
}
