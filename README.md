# Reversy

Reversy takes a site apart and rebuilds it with agents. The product spec is in `docs/spec.md` and the agent system in `docs/orchestrator/spec.md`.

This repository is one TypeScript project deployed as a single Cloudflare Worker named `reversy`:

- `src/web/`: React front end, built with Vite and served as Workers static assets.
- `src/worker/`: the Worker, which handles `/api/*` (for example `GET /api/health`).
- `src/shared/`: contracts used by both, as zod schemas with their TypeScript types.

## Setup

Requires Node 22.

```sh
npm install
npm run dev
```

`npm run dev` serves the front end and the Worker together through the Cloudflare Vite plugin.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Local dev server for the app and API |
| `npm run build` | Builds the front end and the Worker into `dist/` |
| `npm run typecheck` | Type-checks the web and Worker code |
| `npm run lint` | Lints with Biome |
| `npm run format` | Checks formatting with Biome (`npx biome format --write .` fixes it) |
| `npm test` | Runs the Vitest tests |
| `npm run deploy` | Builds, then runs `wrangler deploy` |

## Deploy

GitHub Actions (`.github/workflows/ci.yml`) runs format, lint, typecheck, test and build on every pull request and push.
On a push to `main`, once CI passes, the deploy job builds and deploys the Worker with the Cloudflare wrangler action.

The deploy job needs two repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Without them the deploy job logs that it is skipping and succeeds, so CI stays green.
