# backend

A Hono + Postgres + Redis API to start a project from. It is a working slice, not a
framework: auth, users, notifications, uploads and a queue, plus the parts every service
needs (config, database, errors, logging, guards, tests, build, deploy).

```bash
cp .env.example .env.development        # then regenerate the JWT pair (see below)
docker compose -f docker-compose.dev.yml up -d
npm install
npm run migrate                         # drizzle-kit output in src/db/migrations
npm run seed:dev                        # dev-admin@example.com / Dev@1234
npm run start:dev                       # http://localhost:5000
```

## Layout

```
app/            process entry points — server, workers, migrate, seed-migrations
src/
  bases/        the three base classes: repository, queue, worker (+ user service)
  config/       env parsing (zod, fails at boot) and the typed config object
  constants/    TTLs, regexes, file sizes, argon2 costs
  db/           postgres + redis connections, the drizzle schema barrel, migrations
  emails/       Handlebars templates, one folder per template
  enums/        roles, queue names, table names, file types
  errors/       one class per HTTP error, mapped to responses in middlewares/error
  helpers/      response envelopes, auth helpers, id generators, error throwers
  interfaces/   small shared types (repo contract, pagination, mail options)
  middlewares/  guard chain, error handler, request logging, upload handling
  models/       column helpers shared by tables (soft delete, timestamps)
  modules/      one folder per feature: routes + controller + service + schema + model
  routes/       the versioned router — one line per module
  services/     cache, jwt, encryption, mail, queue, storage, pub/sub, websocket, zod
  shared/       zod validators and types used by more than one module
  utils/        logger
scripts/        dev fixtures and the db rebuild
tests/          vitest unit tests, no live services required
```

`.env.example` ships a throwaway JWT key pair and encryption key so the first boot works
off a fresh copy — **regenerate both** before anything real runs; the commands are in the
file above each value.

A request is `route → zod validate → guard → controller → service → repository`. The
controller never touches the database, the service never touches Hono's `Context`, and the
repository never decides business rules.

## Modules in place

| Module | Routes | Notes |
|---|---|---|
| auth | `/api/v1/auth/*` | signup → OTP by email, login, OTP login, refresh (with rotation grace), logout, forgot/reset password, `/me` |
| user | `/api/v1/user/*` | profile, avatar, onboarding, password change, sessions, account delete |
| notifications | `/api/v1/notifications/*` | list, unread count, mark read; pushed over the socket |
| upload | `/api/v1/upload/*` | presigned PUT/GET against S3, plus a server-side upload |

Auth is three pieces: an `authId` in a short-lived JWT, the session in Redis under that id,
and a rotating refresh token whose id is registered in Redis. Changing a password or a role
writes the new value into the cached session, so a token minted before the change cannot keep
the old grant.

## Adding a module

1. `src/modules/thing/{thing.model,thing.schema,thing.repository,thing.service,thing.controller,thing.routes,index}.ts`
2. Export the model from `src/db/postgres.schema.ts`, then `npm run migrate:create`.
3. `router.route("/things", thingRouter)` in `src/routes/router.ts`.

## Commands

| Command | What it does |
|---|---|
| `npm run start:dev` | API with nodemon + tsx |
| `npm run start:dev:workers` | queue consumers, separate process |
| `npm run build` | esbuild bundle into `dist/` (assets copied) |
| `npm test` | vitest; unit tests only, no database needed |
| `npm run migrate` | apply pending SQL migrations |
| `npm run migrate:create` | generate a migration from the models |
| `npm run migrate:rebuild` | drop the schema and re-run every migration (dev only) |
| `npm run seed:dev` | recreate the dev accounts |
| `npm run biome:format` | format + organize imports |
| `npm run check:circular` | fail on a circular import |

## Production shape

`npm run build`, then run `dist/server.js` (API) and `dist/init.workers.js` (queues) under
pm2 (`ecosystem.config.cjs`). Migrations run from the same bundle with
`node dist/migrate.js`. Queues have a BullMQ dashboard at `/queue`.

## What this deliberately does not include

OAuth providers, payments, websockets beyond pub/sub fanout, image processing, and any
product domain. Each one is a dependency and a surface to keep correct; add it when the
product needs it, in the module folder it belongs to.
