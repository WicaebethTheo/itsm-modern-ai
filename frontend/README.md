# Console web — ITSM Modern AI

SPA d'administration du moteur de triage. **Habillage** au-dessus de l'API REST du
moteur : aucune logique métier ici, tout passe par le client API typé (`src/lib/api.ts`).

## Stack

- **Vite 6** + **React 19** + **TypeScript**
- **Tailwind CSS v4** (`@tailwindcss/vite`, thème CSS-first, tokens façon shadcn/ui)
- **react-router 7**, **lucide-react** (icônes)
- **Biome** (lint + format, un seul outil)

## Développement

```bash
npm install
npm run dev        # http://localhost:5173 — proxy /api et /health vers le moteur :8000
npm run typecheck  # tsc --noEmit
npm run lint       # biome check .
npm run format     # biome check --write .
npm run build      # -> dist/ (servi en statique par le moteur, ou par l'image Docker)
```

En production, l'image Docker build cette SPA (étape Node) puis FastAPI sert `dist/`
à la racine `/`. Aucun serveur Node au runtime.

## Organisation

```
src/
├── lib/
│   ├── api.ts        # client API typé — POINT D'ENTRÉE UNIQUE vers le backend
│   └── utils.ts      # cn() (clsx + tailwind-merge)
├── hooks/
│   └── useResource.ts# chargement async réutilisable (data/loading/error/reload)
├── components/
│   ├── ui/           # primitives (button, card, badge, input, label, textarea)
│   ├── Layout.tsx    # sidebar (navigation data-driven) + Outlet
│   ├── RequireAuth.tsx
│   ├── PageHeader.tsx StatCard.tsx SyncButton.tsx RefEligibilityEditor.tsx
└── pages/            # une page = une route (cf. App.tsx)
```

**Ajouter une page** = 1 composant dans `pages/`, 1 `<Route>` dans `App.tsx`, 1 entrée
dans `SECTIONS` de `Layout.tsx`. **Ajouter un appel backend** = 1 type + 1 méthode dans
`lib/api.ts` (jamais de `fetch` direct dans une page).
