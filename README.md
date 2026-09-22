# personal-coach-app

App mobile statique (PWA) pour [Aubin65/personal_coach](https://github.com/Aubin65/personal_coach) — voir ce repo pour tout le reste (données, logique de coaching, automatisations).

**Ce repo est public, et c'est volontaire.** Il ne contient que le code de
l'app (HTML/CSS/JS, zéro dépendance, zéro build) — aucune donnée
personnelle, aucun secret. Toutes les vraies données (planning, séances,
santé, notes) restent dans le repo privé `personal_coach` et ne sont
lues/écrites par cette app qu'en direct, via l'API GitHub, avec un token
personnel que chaque utilisateur garde sur son propre téléphone. Voir
`docs/adr/0017-...` et son amendement dans ce repo pour le détail de cette
architecture (et pourquoi GitHub Pages impose un repo public sur le plan
Free, ce qui a motivé ce découpage en deux repos).

Ce repo est synchronisé automatiquement depuis `personal_coach/app/` —
ne pas éditer directement ici, les changements seraient écrasés au
prochain sync.

Hébergé via GitHub Pages (Settings → Pages → Source : Deploy from a
branch → `main` → `/ (root)`).
