# backend-server

Node/Express + Prisma + Postgres backend for the AI-Assisted Safety, Navigation & Cognitive Engagement
System. See `D:\AssistVault\wiki\` for the full spec — this README is just local setup.

## Setup

```
npm install
npx prisma migrate dev
npm run prisma:seed   # optional: creates a demo patient + caregiver login
npm run dev
```

Copy `.env.example` to `.env` and fill in real values for `GEMINI_API_KEY`, `CLOUDINARY_*`, etc. before
testing the `/api/frames` pipeline end-to-end — the ones checked into `.env` locally are dev-only
placeholders (Postgres credentials are real for this machine's local install; see
`AssistVault/wiki/tech-stack.md`).

## Structure

- `routes/`, `controllers/`, `services/`, `middleware/`, `config/` — layered Express app
- `prisma/schema.prisma` — source of truth for the DB schema (mirrored in the wiki's `db-schema.md`)
- `app.js` / `index.js` — Express app / server entrypoint

## Scope

Phase 0 only: DB schema, full API contract, both auth schemes (JWT for users, device API key for
devices), and a single-call Gemini pipeline for frame analysis. No agentic decision layer or short-term
memory context yet — that's Phase 1. See `AssistVault/wiki/index.md` for phasing.
