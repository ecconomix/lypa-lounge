# lypa-lounge

Мінімальний фронтенд-проєкт для сервісу **Lipa Lounge** (M0 — Project Foundation).

## Технології

- React
- TypeScript (strict mode)
- Vite
- Plain CSS
- ESLint

## Скрипти

- `npm run dev` — запуск локального dev-сервера
- `npm run build` — production-збірка
- `npm run lint` — перевірка ESLint

## M2 backend foundation

The frontend still uses React state and mock reservations. The read-only availability API is implemented; reservation creation and
frontend API integration are not implemented yet.

### Structure

- `worker/index.ts` — standalone TypeScript Worker using native Request/Response
  APIs. `GET /api/health` queries D1 with `SELECT 1` and returns `{"status":"ok"}`.
  Unknown paths return JSON 404; unsupported health methods return 405. Unexpected
  failures are logged server-side and return a generic JSON 500.
- `wrangler.jsonc` — Worker entry point, compatibility date, local port, and D1
  binding `DB` for `lypa-lounge-db`. The all-zero database ID is a local-only
  placeholder, not a provisioned resource.
- `migrations/0001_create_reservations.sql` — initial reservations table.
- `worker/tsconfig.json` — separate strict backend TypeScript configuration,
  discovered automatically by editors for files in `worker/`.
- `.wrangler/` — ignored generated runtime types and local database state.

Wrangler is the only added direct dependency (development only); there is no ORM
or backend framework. Configuration uses Cloudflare's recommended
[JSONC format](https://developers.cloudflare.com/workers/wrangler/configuration/).
Runtime types are generated from it using
[`wrangler types`](https://developers.cloudflare.com/workers/languages/typescript/)
before backend type checking, so they do not need to be checked into Git.

### Local development

Use Node.js 24 LTS or newer and npm. The project `.nvmrc` contains `lts/*` to track the latest
LTS release. With [nvm](https://github.com/nvm-sh/nvm) loaded in your shell, run
these commands from the project directory:

```sh
nvm install
nvm use
```

`nvm install` installs the latest matching release; `nvm use` selects an installed
matching version for the current shell. Rerun `nvm install` to pick up future LTS
updates. Automatic switching when entering the directory requires nvm's
[shell integration](https://github.com/nvm-sh/nvm#deeper-shell-integration).

No Cloudflare account, credentials, remote database, or login is needed for local
development.

```sh
npm ci
npm run db:migrate:local
npm run typecheck:worker
npm run dev:worker
```

In another terminal, run `npm run dev` for the existing frontend. Vite proxies
`/api` requests to `http://127.0.0.1:8787`; the UI continues to use mocks. The Worker
only serves API responses, not the frontend assets.

```sh
curl -i http://127.0.0.1:8787/api/health
# HTTP 200, Content-Type: application/json, {"status":"ok"}
curl -i http://127.0.0.1:8787/api/unknown
# HTTP 404, {"error":"Not found"}
curl -i -X POST http://127.0.0.1:8787/api/health
# HTTP 405, Allow: GET
```

Both Worker and migration scripts explicitly use `--local`. Wrangler stores D1
state under `.wrangler/state`; subsequent starts reuse it. Local migrations apply
only pending numbered SQL files and can safely be rerun. Add future changes as
new migrations rather than editing an already applied migration. To inspect:

```sh
npx wrangler d1 migrations list DB --local
npx wrangler d1 execute DB --local --command "SELECT name FROM sqlite_master WHERE type = 'table';"
```

`npm run types:worker` regenerates ignored types explicitly;
`npm run typecheck:worker` regenerates them automatically and runs TypeScript.
After a fresh checkout, run it once to make the generated types available to the editor.
Existing frontend build and lint scripts remain available. For validation run
`npm run format`, then `npm run build`, `npm run lint`,
`npm run typecheck`, and `npm run format:check`.

### Availability API (M2.2)

`GET /api/availability?from=2026-10-18&to=2026-11-17` returns active
reservations ordered by date, then start time. Required `from` and `to` values
must be valid `YYYY-MM-DD` Europe/Kyiv calendar dates. Both boundaries are
inclusive; the maximum is 31 calendar days. Past and future ranges are allowed.
Missing, empty, duplicate, unknown, malformed, reversed, or overly long query
parameters return HTTP 400.

HTTP 200 (an empty range returns `{"reservations":[]}`):

```json
{
  "reservations": [
    {
      "id": "reservation-123",
      "date": "2026-10-20",
      "startTime": "18:00",
      "endTime": "21:00",
      "nameOrApartment": "Квартира 12",
      "description": null
    }
  ]
}
```

HTTP 400:

```json
{
  "error": {
    "code": "INVALID_DATE_RANGE",
    "message": "Invalid date range"
  }
}
```

Unsupported methods return HTTP 405 with `Allow: GET` and error code
`METHOD_NOT_ALLOWED`. Unexpected database failures are logged server-side and
return HTTP 500 with `{"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}`.
Only the six public fields above are selected; internal fields are excluded.
Existing health and unknown-path responses retain their original format.

After starting the local Worker using the commands above:

```sh
curl -i 'http://127.0.0.1:8787/api/availability?from=2026-10-18&to=2026-11-17'
curl -i 'http://127.0.0.1:8787/api/availability?from=2026-02-30&to=2026-03-01'
npm test
```

Vitest is the test framework for frontend and backend tests:

- `npm test` runs all tests once; `npm run test:watch` reruns tests on changes.
- Colocate `*.test.ts` / `*.test.tsx` beside the code under test and import APIs
  explicitly from `vitest`. Tests default to the Node environment, with mocks
  restored before each test. The shared Vite React plugin supports future TSX
  tests; no DOM environment or component testing dependencies are installed yet.
- `worker/availability.test.ts` invokes the Worker handler directly with
  Wrangler's real local D1 bindings, with persistence and remote bindings disabled.
  It applies the existing migration and seeds isolated fixtures without changing
  your development database. Targeted D1 failures and query guards use Vitest mocks.
- Worker test types live in `worker/tsconfig.test.json`, including Node types
  separately from production Worker types; `npm run typecheck` checks both.

The 38 tests cover validation, DST boundaries, filtering, sorting, public fields,
database failures, unsupported methods, and health regressions. Run the validation
commands above plus `npm test`.

Availability is a request-time snapshot. Atomic conflict prevention belongs to
the future reservation creation endpoint (M2.3). This endpoint adds no locking,
polling, caching infrastructure, or frontend integration.

### Reservation storage conventions

- `id` is a nonempty application-generated text identifier. `idempotency_key` is
  nonempty and unique, retained even for cancelled reservations. Future request
  replay behavior belongs to the booking API.
- `date` is a valid calendar date in `YYYY-MM-DD` form. `start_time` and `end_time`
  are zero-padded `HH:mm` civil times in **Europe/Kyiv**, matching the frontend.
  Both endpoints must fall on a 30-minute boundary; the end must follow the start
  on the same date. Intervals will be treated as `[start, end)` by future logic.
  These are not UTC clock times: future conversion to instants must use the IANA
  timezone for the chosen date, including daylight-saving rules. Ambiguous or
  nonexistent DST times need validation when implementing booking; the current
  frontend offers daytime hours (08:00–22:00).
- `created_at` and `updated_at` are integer **UTC Unix seconds**, defaulting to
  `unixepoch()`. Future updates must explicitly advance `updated_at`; no update
  trigger is installed.
- `status` is `active` (default) or `cancelled`, allowing future soft cancellation
  without deleting history. Cancellation requests and their workflow are not
  implemented. `name_or_apartment` is required; `description` is nullable.
- A `(date, status, start_time)` index supports daily queries. The primary key and
  unique idempotency key supply their own indexes. No overlap constraint, trigger,
  or booking logic is included; overlap prevention belongs to M2.3.

### Remote D1 provisioning (manual, future work)

These steps **create or modify remote resources** and are documentation only;
they are not required or executed for M2.1:

1. Create/access a Cloudflare account with permission to manage Workers and D1.
   Install dependencies and authenticate with `npx wrangler login`. Select the
   intended account if you have more than one (set its `account_id` in config).
2. Run `npx wrangler d1 create lypa-lounge-db`. Copy the returned database UUID into
   `wrangler.jsonc`, replacing the all-zero `database_id`; retain binding `DB`,
   database name `lypa-lounge-db`, and the migrations directory. Review and commit
   the configuration update.
3. After reviewing migrations and confirming the target account/database, apply
   them with `npx wrangler d1 migrations apply DB --remote`.
4. Deployment, Worker routing, and frontend hosting integration must be handled
   separately in a later task. No deployment script or pipeline is provided here.

Local and remote databases are independent; local migrations/data are never
uploaded automatically. See Cloudflare's
[local D1 guide](https://developers.cloudflare.com/d1/best-practices/local-development/)
and [D1 setup guide](https://developers.cloudflare.com/d1/get-started/).
