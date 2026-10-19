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

The frontend loads reservations from the Worker API and stores the current 31-day
snapshot in React state. Local D1 persists bookings across reloads.

### Structure

- `worker/index.ts` — standalone TypeScript Worker using native Request/Response
  APIs. `GET /api/health` queries D1 with `SELECT 1` and returns `{"status":"ok"}`.
  Unknown paths return JSON 404; unsupported health methods return 405. Unexpected
  failures are logged server-side and return a generic JSON 500.
- `wrangler.jsonc` — Worker entry point, compatibility date, local port, and D1
  binding `DB` for `lypa-lounge-db`. The all-zero database ID is a local-only
  placeholder, not a provisioned resource.
- `migrations/0001_create_reservations.sql` — initial reservations table.
- `worker/tsconfig.json` — editor-discovered project references for production
  Worker types (`tsconfig.worker.json`) and test types (`tsconfig.test.json`).
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
`/api` requests to `http://127.0.0.1:8787`. Both servers must be running. The Worker
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
  restored before each test. React integration tests opt into jsdom with a file directive and use React
  `act` and native DOM events; other tests retain the Node environment.
- `worker/availability.test.ts` invokes the Worker handler directly with
  Wrangler's real local D1 bindings, with persistence and remote bindings disabled.
  It applies the existing migration and seeds isolated fixtures without changing
  your development database. Targeted D1 failures and query guards use Vitest mocks.
- Worker test types live in `worker/tsconfig.test.json`, including Node types
  separately from production Worker types; `npm run typecheck` checks both.

The original 38 tests remain intact. Reservation tests add validation, Kyiv clock
and DST boundaries, persistence, overlap and concurrency, replay after cancellation
and expiry, and safe failures. All integration tests use ephemeral local D1.
Run the validation commands above plus `npm test`.
Availability is a request-time snapshot. Reservation creation checks conflicts
atomically; no polling, caching infrastructure, or real-time transport is added.

### Reservation API (M2.3)

`POST /api/reservations` requires `Content-Type: application/json` (optional
charset parameter) and an `Idempotency-Key` UUID header. Example, using a date
within the current booking window:

```sh
curl -i http://127.0.0.1:8787/api/reservations \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 91b65f1b-c03e-4697-9cf5-636c020d4e61' \
  -d '{"date":"2026-10-20","startTime":"18:00","endTime":"21:00","nameOrApartment":"Квартира 12","description":"День народження"}'
```

HTTP 201 returns `{"reservation":{...}}` with the same six public fields as
availability, including a generated UUID `id`. Internal keys/status/audit fields
are excluded. `description` may be omitted; blank or missing text becomes `null`
in responses. Explicit JSON `null` input is rejected. Free text is trimmed;
`nameOrApartment` must contain 1–100 UTF-16 code units after trimming, and
`description` at most 1000. Unknown fields, non-object bodies, malformed JSON,
wrong types, missing fields, and invalid/missing UUID headers return 400.
UUID keys are case-insensitive (canonical lowercase storage).

Dates are strict valid `YYYY-MM-DD`, from today through 30 calendar days ahead
inclusive in Europe/Kyiv. Times are strict `HH:mm` on 30-minute boundaries,
08:00–22:00 inclusive, with end after start on the same day. Duration is at least
30 minutes; 08:00–22:00 is allowed. Today's start must be at or after the current
instant, including seconds/milliseconds. Kyiv calendar arithmetic handles DST
and year boundaries independently of the server timezone.

Errors use `{"error":{"code":"...","message":"..."}}`:

| HTTP | Code                   | Message                               |
| ---- | ---------------------- | ------------------------------------- |
| 400  | INVALID_RESERVATION    | Invalid reservation data              |
| 415  | UNSUPPORTED_MEDIA_TYPE | Content-Type must be application/json |
| 409  | RESERVATION_CONFLICT   | Selected time is no longer available  |
| 409  | IDEMPOTENCY_CONFLICT   | Idempotency key was already used      |
| 405  | METHOD_NOT_ALLOWED     | Method not allowed                    |
| 500  | INTERNAL_ERROR         | Internal server error                 |

Unsupported methods include `Allow: POST`. Unexpected failures are logged only
server-side. A rejected interval does not consume its idempotency key.

Retries with an identical **normalized** payload return the original reservation
and HTTP 201, including after cancellation or expiry of the booking window.
Different normalized payloads with a consumed key return `IDEMPOTENCY_CONFLICT`.
An omitted description and blank description are equivalent. Keys are retained
indefinitely. There is no migration: the existing unique key plus stored booking
fields identify the original payload. Those fields must remain immutable; a
future edit API must preserve an original payload/fingerprint before changing
them. Cancellation may change status without invalidating replay.

Overlap checking and insertion use one bound `INSERT ... SELECT ... WHERE NOT
EXISTS` statement. The predicate checks active rows on the same date using
`start_time < requestedEnd AND end_time > requestedStart`; adjacent bookings are
allowed and cancelled rows do not block. D1 processes queries one at a time
([Cloudflare FAQ](https://developers.cloudflare.com/d1/reference/faq/)), so this
single write cannot interleave its check with another insert. The write uses
`ON CONFLICT(idempotency_key) DO NOTHING` and is batched transactionally with a
lookup by key ([D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)).
A matching key resolves replay; no matching row means the conditional insert
created zero rows due to an overlap. An initial key lookup permits expired retries
before applying time-sensitive rules; it is never used to decide availability.

With the local Worker running, repeat the same curl to verify replay, change the
key to verify an overlap returns 409, and query availability for that date to see
the persistent row. `npm test` verifies these flows against isolated local D1,
including concurrent requests. No remote resources or deployment are required.
The API has no authentication/rate limiting in this MVP; keys identify retries,
not user identities. The frontend uses these APIs directly.

### Concurrency verification (M2.4)

`worker/reservations.test.ts` reuses the ephemeral local D1 setup and migration.
It verifies 20 competing users on one interval, partial overlaps, three adjacent
slots, independent dates, identical and conflicting concurrent idempotency keys,
and contention over a cancelled interval. A bounded 50-request stress test mixes
overlapping, adjacent, and minimum-duration slots. Tests query committed D1 rows
for overlap, ID/key uniqueness, and unreported inserts, and compare availability
with the final active rows. A real local D1 write failure verifies a generic 500,
no partial row, and subsequent reuse of the unconsumed key. Existing Kyiv clock,
DST, full-day, and instant-boundary cases are retained; spring DST booking-window
regressions check the inclusive 30-day limit.

```sh
npm test
npm test -- worker/reservations.test.ts -t concurrent
```

These tests use `Promise.all` without sleeps or assumptions about which request
wins. They exercise contention and invariants, not guaranteed simultaneous
execution or production load/latency. Overlap prevention depends on every writer
using the atomic conditional insert described above; direct SQL can bypass it.
Tests disable persistence and remote bindings and do not access production D1.

### Reservation storage conventions

- `id` is a nonempty application-generated text identifier. `idempotency_key` is
  nonempty and unique, retained even for cancelled reservations. The booking API
  uses UUID keys to identify retries.
- `date` is a valid calendar date in `YYYY-MM-DD` form. `start_time` and `end_time`
  are zero-padded `HH:mm` civil times in **Europe/Kyiv**, matching the frontend.
  Both endpoints must fall on a 30-minute boundary; the end must follow the start
  on the same date. Intervals are treated as `[start, end)` by the booking API.
  These are not UTC clock times: future conversion to instants must use the IANA
  timezone for the chosen date, including daylight-saving rules. Booking hours (08:00–22:00) exclude the Europe/Kyiv DST transition hours.
- `created_at` and `updated_at` are integer **UTC Unix seconds**, defaulting to
  `unixepoch()`. Future updates must explicitly advance `updated_at`; no update
  trigger is installed.
- `status` is `active` (default) or `cancelled`, allowing future soft cancellation
  without deleting history. Cancellation requests are stored separately; their review workflow is deferred
  to M3.3. `name_or_apartment` is required; `description` is nullable.
- A `(date, status, start_time)` index supports daily queries. The primary key and
  unique idempotency key supply their own indexes. There is no database overlap constraint or trigger: all booking writes must use
  the API conditional insert. Direct SQL writes can bypass overlap prevention.

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

### Frontend API integration (M2.5)

- `src/api/reservations.ts` uses native fetch, validates public responses, maps
  nullable descriptions, and preserves HTTP status/error codes.
- `src/hooks/useAvailability.ts` loads today plus 30 civil days in Europe/Kyiv in
  one GET. Date selection filters this snapshot locally. Initial failure blocks
  booking and offers retry; background refresh retains the current calendar.
- Availability refreshes after creation/conflict and when the document becomes
  visible. Concurrent GETs are deduplicated; superseded GETs are aborted and their
  responses ignored. A 30-second local clock check detects Kyiv day rollover,
  updates the range and preserves valid selections. It does not poll the API.
- The form trims text and sends a UUID `Idempotency-Key`. Pending submissions
  disable form controls and reject duplicate submit events. Uncertain failures
  retain the original payload/key and offer an explicit same-request retry, even
  if a later refresh discovers that booking or its time has passed. A different
  normalized payload or a new booking after success gets a new key.
- Reservation conflicts refresh the full range and clear only time selections.
  Text and selected date remain. Idempotency conflicts have separate feedback.
  Confirmed creations appear immediately; a failed follow-up GET keeps success
  feedback and provides a refresh retry.
- Retry keys live in memory: after an uncertain POST, use the same-request retry
  before reloading/closing the page. There is no durable submission recovery.

Run frontend tests with `npm test -- src`; run all frontend and ephemeral D1
integration tests with `npm test`. Validate with `npm run format`, `npm test`,
`npm run typecheck`, `npm run build`, `npm run lint`, `npm run format:check`.
For manual integration, start local migrations/Worker and Vite as above; create
an interval, reload and open another tab to verify persistence. Submit an interval
from an older snapshot after another tab books it to exercise conflict feedback.
Returning to a visible tab refreshes its snapshot automatically.

## M3.1 — Single administrator authentication

`/admin` is a separate minimal React page selected by pathname, without a router
library. It restores the cookie session on reload and visible-tab return, and
returns to the login form at the server's expiry deadline. Passwords are held only
in the password input and request, cleared after submission, and never written to
browser storage. No admin booking management or cancellation review controls are implemented.
Public reservation responses are unchanged; no admin data is added to them.

### Configuration and local setup

Use Node 24 (see nvm instructions above). Create an **ignored** `.dev.vars` in the
repository root, alongside `wrangler.jsonc`:

```dotenv
ADMIN_PASSWORD="replace-with-a-unique-random-password-of-at-least-16-characters"
ADMIN_ORIGIN="http://localhost:5173"
```

Use a password manager to generate a unique random password (at least 16
characters, at most 1024; do not reuse the example). Do not use a `VITE_` variable:
Vite variables are public. Never commit `.dev.vars`, credentials, or session tokens.
`ADMIN_PASSWORD` is the only required secret. If it is missing or outside
the 16–1024 character range, authentication fails closed with HTTP 503.

`ADMIN_ORIGIN` is a non-secret exact browser origin, without a trailing slash.
Set it to `http://localhost:5173` locally as shown above. Open that exact address;
using `127.0.0.1`, another port, or HTTPS requires changing the configured origin
in `.dev.vars`. HTTP origins are accepted only for loopback
hosts. No wildcard origins or CORS access are enabled.

```sh
npm ci
npm run db:migrate:local
npm run dev:worker
# In another terminal:
npm run dev
# Open http://localhost:5173/admin
```

Migration `0002_admin_auth.sql` adds `admin_sessions` (SHA-256 token hashes and
UTC expiry) and `admin_login_limits` (hashed-IP/global buckets, counts and UTC
expiry). Expired limit rows are removed on login; expired sessions are removed
on successful login and are always denied even before cleanup. D1 remains the
only persistent dependency.

### API and security decisions

| Endpoint                 | Behavior                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/admin/login`  | JSON `{ "password": "…" }`; 200 sets session cookie and returns `{ authenticated: true, expiresAt }`.                       |
| `GET /api/admin/session` | 200 with authentication state/UTC Unix expiry; otherwise generic 401.                                                       |
| `POST /api/admin/logout` | JSON `{}`; deletes server session and expires cookie. Always 200 for valid same-origin requests, including repeated logout. |

Admin responses use `Cache-Control: no-store`. Passwords are verified with native
Web Crypto HMAC verification, which avoids a JavaScript secret string comparison.
A fresh ephemeral HMAC key is used for each comparison; this is verification of a
high-entropy password held in a Cloudflare secret, not a password database/KDF.
Use a randomly generated password. Login bodies are bounded to 4096 bytes.
Invalid and missing passwords share a generic response; auth exceptions are not
logged. Session tokens have 256 random bits and only SHA-256 hashes enter D1.
Successful login rotates the browser's previous session; other browsers retain
their independent sessions. Cookies are host-only, `HttpOnly`, `SameSite=Strict`,
`Path=/api/admin`, with a fixed seven-day `Max-Age`. D1 checks expiry on every
protected request; there is no sliding renewal.

Cookies use `Secure` whenever the request or configured origin is HTTPS, and
non-loopback admin requests over HTTP are rejected. Local loopback HTTP omits `Secure`.
All admin mutations, including login/logout, require `application/json` and an
exact matching `Origin`. Together with Strict cookies this protects against
CSRF without another token. Future admin endpoints must use `requireAdmin` from
`worker/admin.ts`, which checks the session and applies mutation validation;
the admin namespace already defaults to authenticated access. Missing, invalid,
unknown, expired, and revoked sessions receive the same 401 response. Logout
intentionally does not reveal whether the cookie existed.

D1 atomically consumes attempts **before** verification: five per client IP and
30 application-wide per 15-minute fixed window starting with the first attempt.
Successes also count and do not reset limits. Concurrent requests cannot bypass
caps. IP buckets use SHA-256 of Cloudflare's edge-supplied `CF-Connecting-IP`;
missing IPs share a fallback bucket. Arbitrary `X-Forwarded-For` is ignored.
This requires the production Worker to run behind Cloudflare's edge; do not
forward an untrusted `CF-Connecting-IP` through another proxy. The global cap
also bounds password checks across distributed sources. HTTP 429 supplies a
conservative 900-second `Retry-After`.

Limits deliberately trade availability for simplicity: someone can exhaust the
global budget and temporarily prevent the administrator from logging in. Shared
IP users share a budget. This is brute-force protection, not volumetric DDoS
protection. Expired rows are cleaned on login rather than by scheduled jobs.
Changing the password does **not** revoke existing sessions; to revoke all
sessions, delete rows from `admin_sessions` in the intended database. There is no
registration, recovery, role system, OAuth, or MFA.

### Later production configuration (documentation only)

No production resources or deployment are configured by this change. When that
work is explicitly authorized, provision D1 and apply migrations as described
above, set the non-secret `ADMIN_ORIGIN` variable in `wrangler.jsonc` to the exact HTTPS public frontend origin, and store
the password using the interactive secret command:

```sh
npx wrangler secret put ADMIN_PASSWORD
```

Enter the password at its prompt; do not put it in shell command arguments or
commit it. This command changes remote configuration and is **not** needed for
local development. Production hosting must serve the SPA for `/admin` and route
`/api/*` to the Worker under the **same public origin**, with HTTPS throughout.
Keep local and production passwords separate. Do not deploy using the local
placeholder D1 ID or local origin. Secrets are managed as described in
[Cloudflare's secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/);
verification uses supported [Web Crypto APIs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/),
and limits use [transactional D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

### Verification

```sh
npm run format
npm test
npm run typecheck
npm run build
npm run lint
npm run format:check
# Focused auth checks:
npm test -- worker/admin.test.ts src/components/AdminPage.test.tsx
```

Manual checklist:

- Open `/admin` at the configured origin; verify the loading and password form.
- Try an incorrect password, then the correct password; verify Ukrainian feedback.
- Inspect the cookie in browser devtools: HttpOnly, Strict, admin API path,
  seven-day expiry (Secure on HTTPS); no auth values in browser storage.
- Reload and reopen the tab; verify that the session is restored without bookings
  being fetched on the admin page.
- Log out; reload and verify access remains denied. Repeat logout through the API.
- Expire a session row in local D1; verify the API denies it and visible-tab return
  displays login. Let the frontend expiry timer elapse to verify its message.
- Attempt more than five logins in 15 minutes; verify 429, then wait for reset.
- Send login/logout with a foreign/missing Origin or a non-JSON Content-Type;
  verify rejection and that the current session remains valid.
- Check the public calendar and reservation creation still work normally.

## M3.2 — Public cancellation requests

The reservation list offers **Запросити скасування** with an inline explanation
form. Users must identify themselves (name/apartment) and explain their reason.
Submitting only asks for administrator review: the reservation stays active and
its time stays unavailable. Approval/rejection is deferred to M3.3.

### Storage and architecture

Apply `0003_cancellation_requests.sql` using `npm run db:migrate:local` before
starting the local Worker. This adds a strict `cancellation_requests` table with
UUID `id`, `reservation_id` foreign key, required `reason`, `status`
(`pending`, `approved`, `rejected`), UTC Unix-second `created_at`, and nullable
`reviewed_at`. Pending rows require no review timestamp; reviewed rows require a
timestamp at or after creation. A partial unique index permits at most one
pending row per reservation, while preserving all reviewed history. Foreign keys
restrict reservation deletion. No reservation columns or availability queries change.

The existing reservation IDs are random UUIDs but publicly listed, so they are
identifiers, never authorization. Any public visitor may submit a request; only
a future authenticated administrator operation can decide whether to cancel.
M3.1 admin authentication and its protected namespace remain unchanged. There is
no public request listing, explanation lookup, private link, or request-review API.

Eligibility means an active reservation whose end is still in the future using
Europe/Kyiv civil date/time, including bookings already in progress. The API
uses one conditional insert and the database partial unique index to enforce
eligibility and concurrency safety. A transactional follow-up lookup distinguishes
missing reservations without returning reservation or request details.

### API contract

`POST /api/reservations/:id/cancellation-requests` requires
`Content-Type: application/json` and exactly `{ "reason": "…" }`.
No authentication or idempotency header is required. Free text is trimmed and
must contain 10–1000 UTF-16 code units, at least one Unicode letter or number,
and no NUL characters. The database additionally bounds text to 1–1000 SQLite
characters. This checks basic substance; requester identity and the truth or
adequacy of the explanation must be assessed by the administrator.

HTTP 201 returns only `{ "status": "pending" }`. Errors follow the public API's
`{ "error": { "code": "…", "message": "…" } }` shape:

| HTTP | Code                          | Meaning                                                          |
| ---- | ----------------------------- | ---------------------------------------------------------------- |
| 400  | INVALID_REASON                | Missing, blank, short, oversized, malformed or unsupported input |
| 404  | RESERVATION_NOT_FOUND         | No matching reservation                                          |
| 409  | CANCELLATION_REQUEST_CONFLICT | Already pending or reservation is cancelled/ended                |
| 405  | METHOD_NOT_ALLOWED            | Only POST supported; includes Allow: POST                        |
| 415  | UNSUPPORTED_MEDIA_TYPE        | JSON required                                                    |
| 500  | INTERNAL_ERROR                | Generic server failure                                           |

Duplicate/ineligible conflicts deliberately share feedback without exposing
request history, explanations, review timestamps, or administrative data. Retrying
an uncertain submission cannot create a second pending row; it returns 409 if
the first succeeded. Success disables further submissions in the mounted form.
The UI refreshes availability after success/conflict and preserves confirmed
success if that refresh fails. POST is independent of GET cancellation.

### Verification and manual checklist

Automated tests cover local ephemeral D1 migrations/constraints, successful and
invalid input, missing/cancelled/ended bookings, Kyiv/DST end boundaries,
duplicate and 20 competing submissions, preserved history, unchanged reservation
rows/availability and continued overlap rejection. React DOM tests cover inline
validation, loading/duplicate locking, trimmed payload, success, uncertain retry,
and Ukrainian conflict/not-found feedback. Run the full validation commands above.

Worker type generation is independent of local secrets as of M4.1; use
`npm run typecheck` with or without `.dev.vars`.

For manual verification (local only):

- Apply migrations and start the local Worker and Vite with Node 24.
- Open a date with an active reservation on a mobile-width screen. Expand
  **Запросити скасування** and check the label, explanation, and active-booking notice.
- Submit blank/short text; verify Ukrainian validation. Enter your identity and
  reason, submit, and verify loading controls and confirmation.
- Confirm the booking remains marked **Зайнято**, including after reload, and
  that an overlapping booking is still rejected.
- Submit for the same reservation from another tab; verify conflict feedback.
- Simulate an offline POST and retry after reconnecting. Verify text is retained
  and only one pending row exists in local D1. Fail the follow-up availability
  refresh and verify the confirmed request message remains.
- Check keyboard focus and textarea usability. Verify public responses contain
  no request explanation, history, review details, or administrator data.

Limitations: requester identity is self-reported; there is no ownership proof,
rate limiting, notification, durable browser submission state, or review UI.
A visitor can occupy the one pending request for a booking; administrator review
is required to resolve it in M3.3. Form confirmation is in memory and disappears
when navigating away/reloading; subsequent submissions remain database-protected.
No deployment or remote resources are part of M3.2.

## M3.3 — Cancellation review

The existing `/admin` page lists pending cancellation requests after login.
It shows Kyiv booking date/time, the existing combined name/apartment field,
private explanation, and creation time in Europe/Kyiv. Approval asks for native
browser confirmation; both actions disable review controls while processing,
remove successful requests, refresh the list, and show Ukrainian feedback.
A failed refresh preserves confirmed success. Use **Оновити список** to retry
loading or see requests submitted by other visitors/processed by another admin.

### Protected API contracts

All routes reuse `requireAdmin`, private no-store responses, and the existing
session cookie. POST routes require the configured Origin and JSON Content-Type;
the frontend sends `{}` and no review payload fields are needed.

- `GET /api/admin/cancellation-requests` → 200 `{ "requests": [...] }`.
  Each pending entry contains `id`, `reservationId`, `date`, `startTime`,
  `endTime`, `nameOrApartment`, `reason`, and UTC Unix seconds `createdAt`.
  Entries are ordered by creation time, then ID; an empty queue returns `[]`.
- `POST /api/admin/cancellation-requests/:id/approve` → 200
  `{ "request": { "id": "…", "status": "approved", "reviewedAt": 123 } }`.
- `POST /api/admin/cancellation-requests/:id/reject` → the same shape with
  `"status": "rejected"`. `reviewedAt` is UTC Unix seconds.

Errors reuse the admin `{ "error": "…" }` shape: 401 unauthenticated,
403 Origin/transport failure, 415 non-JSON mutation, 404 missing request,
409 opposite prior decision or pending request with inactive reservation,
405 unsupported method (with Allow), and generic 500 database failure.
Existing authentication configuration checks can return 503.

No migration is needed. A conditional pending-request update checks that the
reservation is active. Approval updates the reservation to `cancelled` in the
same D1 batch transaction; SQLite `changes()` gates this update on the request
transition. Concurrent decisions serialize in the database. Identical retries
return the original decision without changing either timestamp; opposite retries
return 409. Rejection leaves the reservation untouched. Failed transactions roll
back both changes. Booking payloads, consumed idempotency keys, request history,
and public API fields are preserved. Existing active-only availability and
booking conflict queries automatically free approved time and retain rejected time.

### Verification and limitations

Focused integration tests cover authentication, CSRF, listing, both decisions,
immutable retries, opposite decisions, competing reviews, missing/inactive rows,
availability, safe database errors, and rollback after an injected SQLite failure.
React DOM tests cover loading/details, empty state, approval confirmation,
rejection, disabled actions, refresh, errors/retry, session expiry, and confirmed
success when refresh fails. Browser testing is performed manually by the owner.

Use Node 24 for the project tools. Worker type generation is independent of
local secrets as of M4.1. No dependencies, remote resources, or deployment are
added. The schema has one combined name/apartment field, so separate name and
apartment values cannot be displayed. The queue refreshes on load and after a
successful review, or manually; it has no polling or live updates. Requester
identity remains self-reported. There are no notifications or other admin actions.

Manual browser checklist (local Worker/Vite, migrations applied):

1. Log in at `/admin` and verify unauthenticated visitors see the login form.
2. Create a public cancellation request and view its private details in the queue.
3. Reject the request; check loading controls, success feedback, and its removal.
4. Verify the reservation remains active and overlapping booking remains blocked.
5. Create another cancellation request for that reservation; refresh the queue.
6. Approve it, first declining and then accepting the confirmation.
7. Verify the calendar frees the time and a new booking can use it.
8. Reload `/admin` and the public booking page.
9. Verify processed requests remain absent and the booking state persists.
10. Log out; verify direct queue GET and both review POSTs are denied without a
    session (POST checks use the correct Origin and JSON Content-Type).

## M3.4 — Admin booking controls

`/admin` retains cancellation review and adds active booking controls and technical
blocks. Lists include every active row, ordered by Kyiv date/time (including past
rows still marked active); there is no polling. Name/apartment remains the existing
combined field, rather than introducing separate personal-data fields.

Migration `0004_reservation_kind.sql` adds `kind` (`booking` or `block`) to
`reservations`, defaulting existing rows to `booking`. Apply locally with
`npm run db:migrate:local`. Blocks reuse `worker/reservations.ts` normalization,
Kyiv 31-day horizon, 08:00–22:00 half-hour boundaries, consumed UUID idempotency
keys, and **the same atomic conditional insert** as public bookings. Both kinds
participate in its overlap predicate, so concurrent writes cannot occupy the same
time. Adjacent ranges are allowed. Blocks store their optional internal reason in
`description` (trimmed, maximum 1000 UTF-16 units).

Protected endpoints (existing session cookie, no-store responses):

| Method | Endpoint                             | Behavior                                                                             |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------ |
| GET    | `/api/admin/reservations`            | Active bookings with existing name/apartment and description                         |
| POST   | `/api/admin/reservations/:id/cancel` | Soft-cancel; atomically approve any pending cancellation request                     |
| GET    | `/api/admin/blocks`                  | Active blocks, internal description and UTC Unix creation timestamp                  |
| POST   | `/api/admin/blocks`                  | Create from `{ date, startTime, endTime, reason? }`; requires UUID `Idempotency-Key` |
| DELETE | `/api/admin/blocks/:id`              | Soft-cancel a block                                                                  |

All mutations reuse the configured Origin and JSON content-type CSRF guard,
including DELETE (`{}` body). Repeated cancellation/removal returns 200 without
changing timestamps; missing or wrong-kind IDs return 404. No booking payload,
consumed key, or history is deleted. Manual cancellation and pending-request
resolution share a D1 transaction and roll back together. Existing approved and
rejected reviews remain unchanged.

Public availability keeps the existing booking representation. Blocks appear as
`Технічне блокування`, with null description and `isTechnicalBlock: true`; their
reasons are never exposed publicly. Public cancellation requests cannot target
blocks, and the public UI omits that control. Existing public booking fields remain
unchanged. Admin mutations refresh both booking/block lists and cancellation
review; confirmed success remains visible if refresh fails. Uncertain block
creation retries reuse the UUID for an identical form payload while mounted.

Files: `worker/bookingControls.ts` and its integration tests implement controls;
`worker/admin.ts` routes them; `worker/reservations.ts` shares insertion;
`worker/availability.ts` and `worker/cancellationRequests.ts` protect block privacy
and eligibility. Existing Worker integration suites now apply migration 0004.
`src/api/admin.ts`, `BookingControls.tsx` and its tests provide the admin form/lists;
`AdminPage.tsx`, `CancellationReview.tsx` coordinate refresh; `AdminPage.css` styles
the form. `src/types/reservation.ts`, `src/api/reservations.ts`, `BookingList.tsx`
and its test carry the public block marker. `AdminPage.test.tsx` covers the expanded
page. No dependencies, external services, or deployment changes were added.

### M3.4 automated verification

Use Node 24 (`nvm use`, or select an installed Node 24 binary). Node 18 cannot run
the installed Vite/Vitest tools. Run `npm run format` before final checks, then
`npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, and
`npm run format:check`. D1 integration tests need permission to bind localhost
sockets; all bindings are ephemeral/local with remote bindings disabled.

Worker type generation is independent of local secrets as of M4.1. The standard
`npm run typecheck` checks frontend, Vite, Worker, tests, and the Telegram script.

In a restricted filesystem, `WRANGLER_LOG_PATH=/tmp/lypa-wrangler.log` keeps
Wrangler logs in a writable directory. These alternatives do not change runtime
configuration. No browser testing is performed by the agent.

### M3.4 owner browser checklist

1. Apply local migrations, start the local Worker/Vite apps, sign in at `/admin`,
   and confirm bookings show date, time, name/apartment and description.
2. Cancel a booking after confirmation; repeat with a pending cancellation request
   and verify that request disappears from the review queue. Check declining the
   confirmation leaves the booking unchanged.
3. Return to the public page and confirm the cancelled interval is available.
4. Create a future technical block with a private reason; verify its admin listing
   and that public availability shows a generic block with no reason or cancel form.
5. Attempt to book that interval (including from a stale public page); expect a conflict.
6. Remove the block with confirmation and verify it disappears from active blocks.
7. Book the newly available interval successfully.
8. Try booking/block and block/block overlaps, invalid or reversed ranges, and
   adjacent ranges. Overlaps must fail; adjacent ranges must succeed.
9. Reload both pages and verify persisted bookings, blocks and cancellations.
10. Log out or expire the session; protected lists and mutations must deny access.
    Try an absent/wrong Origin on mutations and confirm no database changes.

## M4.1 — Telegram bot and secrets

`worker/telegram.ts` provides a server-only native-fetch client:
`createTelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, text)`.
It sends plain text using Telegram's [sendMessage API](https://core.telegram.org/bots/api#sendmessage).
HTTP failures, API failures, invalid JSON/envelopes, and network failures reject
with sanitized errors. Raw fetch errors, Telegram descriptions, token-bearing
URLs, tokens, chat IDs, and message bodies are never logged by the client.
There are no automatic sends, public test endpoints, notifications, webhooks,
commands, retries, queues, scheduling, or database/frontend changes.

### Local configuration and delivery verification

Use Node 24. Add these fields to the existing root `.dev.vars`, preserving
`ADMIN_PASSWORD`, `ADMIN_ORIGIN`, and any other existing values. Replace these
placeholders locally; never commit real credentials or chat IDs:

```dotenv
TELEGRAM_BOT_TOKEN="replace-with-bot-token"
TELEGRAM_GROUP_CHAT_ID="replace-with-test-group-chat-id"
TELEGRAM_ADMIN_CHAT_ID="replace-with-administrator-private-chat-id"
```

`.dev.vars*` is already ignored by Git. Do not prefix these names with `VITE_`,
put them in frontend code, or place their values in `wrangler.jsonc`.
Wrangler loads `.dev.vars` for local Worker development. The local-only script
uses Node's native `--env-file=.dev.vars` loader; use simple `KEY="value"` entries.
Node gives existing shell environment variables precedence over this file, so
unset any stale `TELEGRAM_*` exports before testing. No Cloudflare login, running
Worker, database migration, or frontend server is needed for these commands.

Each command sends one fixed test message to the selected configured chat:

```sh
npm run telegram:test -- group
npm run telegram:test -- admin
```

Confirm the corresponding `Lypa Lounge M4.1: group delivery test.` or
`Lypa Lounge M4.1: admin delivery test.` message appears in Telegram. The script
prints acceptance only after a successful Telegram response; exit code 1 means
failure. API acceptance does not prove that a person has seen the message.
The bot must belong to the test group and be allowed to send messages; the
administrator must have started the bot privately. On HTTP 401 check the token;
on 400/403 check the selected chat ID, membership, send permissions, and whether
the administrator blocked the bot. Verify both chats manually; mocked unit tests
never contact Telegram. Network failure may occur after delivery; manually
rerunning the command can produce a duplicate.

### Production secrets (manual setup)

For the intended Cloudflare Worker/account, enter each value interactively:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_GROUP_CHAT_ID
npx wrangler secret put TELEGRAM_ADMIN_CHAT_ID
```

These commands change remote Worker secrets; run them only when configuring
production deliberately. They preserve existing secrets. No values belong in
source control or command-line arguments. This task does not run these commands,
provision resources, or deploy. The local verification script reads local
configuration only; production secret setup alone sends no messages.

`TelegramEnv` extends the Worker handler's existing `Env & AdminEnv` bindings
with optional Telegram secret fields, following the admin configuration pattern.
Missing Telegram configuration fails only when sending, leaving existing routes
usable. `npm run types:worker` uses an empty env file for deterministic generated
D1/runtime types without inferring required fields from developer credentials;
secret types remain explicit in `AdminEnv` and `TelegramEnv`. This changes type
generation only, not local or production runtime loading.

### Automated verification

```sh
npm run format
npm test
npm run typecheck
npm run build
npm run lint
```

Focused client tests: `npm test -- worker/telegram.test.ts`. The local script is
included in the Node-aware Worker test TypeScript project. No new dependencies
are required. Live delivery and production configuration require owner verification.

## M4.2 — Telegram booking notifications

A newly committed public booking sends one concise Ukrainian plain-text message
to `TELEGRAM_GROUP_CHAT_ID`, using the existing `TELEGRAM_BOT_TOKEN` and client.
For example:

```text
Нове бронювання альтанки
20.10.2026, 18:00–20:00 (Київ)
Квартира 12
```

Dates and times are the booking's Europe/Kyiv civil values. The message includes
only the date, time range and trimmed `nameOrApartment`; descriptions, internal
IDs and idempotency keys are excluded. The D1 batch's insert count identifies a
new row after commit, including during concurrent requests. Idempotent replays,
validation errors, conflicts and technical blocks never trigger notifications.
The M4.1 client and manual delivery scripts remain unchanged.

The Worker registers delivery with `ExecutionContext.waitUntil` so the booking
response does not wait for Telegram. Missing or blank token/group configuration
silently skips delivery. Telegram failures log only a fixed message without
error details, credentials, destinations or booking data. They never roll back
the booking or change its API response. There are no new variables, dependencies,
retries, queues or tables. Delivery is best effort: a crash or Telegram failure
can lose a notification, and retrying a successful booking does not resend it.
Telegram acceptance does not confirm that a person has read the message.
Cancellation/review notifications and production deployment are outside M4.2.

### Local test-group verification

1. Use Node 24 and configure `.dev.vars` as described in M4.1, with the local
   **test group** as `TELEGRAM_GROUP_CHAT_ID`. Ensure the bot can send there;
   `npm run telegram:test -- group` can verify connectivity independently.
2. Run `npm run db:migrate:local`, `npm run dev:worker` and `npm run dev`.
   Create a future public booking through the UI, including a private description.
   Confirm HTTP 201, persisted availability and exactly one group message with
   Kyiv date/time and name/apartment. Check that the description is absent.
3. In browser developer tools, copy that POST as fetch and repeat it with its
   original JSON and `Idempotency-Key`. Confirm the same HTTP 201/reservation
   and no second notification. Change its name with the same key; expect 409
   and no message. Never share copied requests containing personal data.
4. Submit an overlapping booking with a new key; expect 409 and no message.
   Submit invalid input; expect 400 and no message. At `/admin`, create a
   technical block in another free interval and verify no group notification.
5. Stop the Worker, temporarily remove either Telegram setting from `.dev.vars`,
   restart it and create a booking in a free interval. Confirm HTTP 201 and
   persistent availability, with no notification.
6. Set a deliberately invalid test token, restart the Worker and book another
   free interval. Confirm HTTP 201, persistent availability and only the fixed
   `Telegram booking notification failed` log. Replaying the POST must not resend.
   Restore the valid local test configuration and restart the Worker afterward.

Automated tests use mocked Telegram fetches and ephemeral local D1. They cover
committed delivery, nonblocking responses, sequential/concurrent replay deduplication,
validation/conflict/block suppression, missing configuration, safe failure logging
and persistence despite delivery/scheduling failure. Run `npm run format`,
`npm test`, `npm run typecheck`, `npm run build`, `npm run lint` and
`npm run format:check`. Live test-group verification is an owner manual check;
automated tests never contact Telegram.
