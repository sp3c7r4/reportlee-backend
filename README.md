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
| user | `/api/v1/user/*` | profile, avatar, onboarding, password change, sessions, account delete, role grant (`PATCH /user/:id/role`, admin only) |
| notifications | `/api/v1/notifications/*` | list, unread count, mark read; pushed over the socket |
| upload | `/api/v1/upload/*` | presigned PUT/GET against S3, plus a server-side upload |

Auth is three pieces: an `authId` in a short-lived JWT, the session in Redis under that id,
and a rotating refresh token whose id is registered in Redis. Changing a password or a role
writes the new value into the cached session, so a token minted before the change cannot keep
the old grant.

### First admin
Every signup is a member; only an existing admin can grant admin. `npm run seed:dev` creates
`dev-admin` locally. For staging and production, the owner inserts the `admin` row for a chosen
user in one transaction, after deleting that user's `member` row. This is a manual step and is
never run by tooling.

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

## Deploy to Railway

One Railway project from this repo, two services plus the Railway Postgres and Redis plugins. Node 22.

| Service | Build | Start |
|---|---|---|
| API | `npm ci && npm run build` | `node dist/server.js` |
| Worker (no public domain) | `npm ci && npm run build` | `node dist/init.workers.js` |

- The worker must be running, or no OTP or verification email is sent.
- Give both services `POSTGRES_URI` and `REDIS_URI` as reference variables to the plugin URLs (for example `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}`; plugin names may differ).
- Migrations: run `node dist/migrate.js` once per deploy, as the API pre-deploy command or with `railway run node dist/migrate.js`. The build copies the SQL files to `dist/migrations`.
- Regenerate the JWT key pair and `ENCRYPTION_KEY` for production (commands are in `.env.example`). The ones in the example file are throwaway.
- `ORIGINS` (a JSON array string such as `["https://<app>.vercel.app"]`, exact origin, no trailing slash) and `FRONTEND_URL` must be the Vercel URL, or CORS rejects the frontend.
- Set `HOSTNAME=0.0.0.0` explicitly on the API service, because some container runtimes export `HOSTNAME` as the container id. Railway injects `PORT`.
- Gmail: turn on 2-step verification, create an app password, then set `MAIL_PROVIDER=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` (the Gmail address) and `SMTP_PASS` (the app password). A personal account allows about 500 messages per day.
- Switching to Resend later: `MAIL_PROVIDER=resend` plus `RESEND_API_KEY` and `RESEND_DOMAIN`, then restart both services.

Environment variable names:

- Runtime: `NODE_ENV` (`production`), `HOSTNAME`, `PORT`, `SERVER_DOMAIN` (bare host of the Railway API domain), `ROOT_DOMAIN`, `FRONTEND_URL`, `ORIGINS`
- Data: `POSTGRES_URI`, `REDIS_URI`, `REDIS_CHANNEL_PREFIX` (optional)
- Auth: `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_EXPIRES_IN`, `JWT_ISSUER`, `ENCRYPTION_KEY`
- Mail: `MAIL_PROVIDER`, `MAIL_DOMAIN`, `MAIL_FROM_NAME`, `MAIL_LOGO_URL`
- SMTP provider: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`
- Resend provider: `RESEND_API_KEY`, `RESEND_DOMAIN`
- Storage: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`, `AWS_S3_ENDPOINT`, `CDN_URL`

The schema requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` and `MAIL_DOMAIN` even when unused, so set placeholders. Uploads do not work until real AWS values exist. `MAIL_DOMAIN` is unused while `MAIL_PROVIDER=smtp`.

## What this deliberately does not include

OAuth providers, payments, websockets beyond pub/sub fanout, image processing, and any
product domain. Each one is a dependency and a surface to keep correct; add it when the
product needs it, in the module folder it belongs to.
