# lypa-lounge

Мінімальний сервіс бронювання спільної альтанки **Lypa Lounge**.
React frontend and API are served by one Cloudflare Worker with Static Assets and D1.

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
  Unknown API paths return JSON 404; unsupported health methods return 405. Unexpected
  failures are logged server-side and return a generic JSON 500.
- `wrangler.jsonc` — Worker entry point, compatibility date, local port, and D1
  binding `DB` for `lypa-lounge-db`, frontend build and Static Assets routing.
  The all-zero database ID is a local-only
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
`/api` requests to `http://127.0.0.1:8787`. Both servers must be running for frontend
hot reload. Wrangler also builds and serves `dist/` at port 8787; this is a build
snapshot, while Vite remains the usual local frontend. Keep local `ADMIN_ORIGIN`
at `http://localhost:5173` when using Vite.

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

### Remote D1 provisioning

See [Production deployment](#production-deployment-m51a) for the complete owner-run
procedure. Local and remote databases are independent; local migrations/data are
never uploaded automatically.

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

### Production admin configuration

Follow [Production deployment](#production-deployment-m51a) to configure the
server-only password and exact HTTPS origin. Keep local and production passwords
separate. Secrets are managed as described in
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

A newly committed public booking sends one concise Ukrainian HTML message
to `TELEGRAM_GROUP_CHAT_ID`, using the existing `TELEGRAM_BOT_TOKEN` and client.
For example:

```text
🌿 Липа Lounge | Нове бронювання

📅 Дата: вівторок, 20 жовтня 2026 р.
🕒 Час: 18:00–20:00
👤 Ім’я / квартира: Квартира 12
```

The message includes only the booking date, time range and trimmed `nameOrApartment`; descriptions, internal
IDs and idempotency keys are excluded. The D1 batch's insert count identifies a
new row after commit, including during concurrent requests. Idempotent replays,
validation errors, conflicts and technical blocks never trigger notifications.
`worker/telegramMessages.ts` formats messages independently of delivery, with a
shared HTML escaping helper available for future M4.3 cancellation messages.
The header and labels are bold, the date includes the Ukrainian weekday, and all
dynamic text is escaped before sending with `parse_mode: HTML`. The client accepts
an optional `{ parseMode: 'HTML' }` argument; existing manual scripts still send
plain text by default.

The existing `ADMIN_ORIGIN` is documented as the public frontend origin. When it
is a valid exact HTTPS origin, the message includes **Відкрити календар**, linking
to the public calendar at `/`. Missing, malformed, non-HTTPS, credential-bearing
and local development origins omit the link. No new configuration is introduced;
links are never derived from request headers. If public and admin frontend origins
are separated in the future, this source must be revisited.

The Worker registers delivery with `ExecutionContext.waitUntil` so the booking
response does not wait for Telegram. Missing or blank token/group configuration
skips delivery with a safe `telegram.skipped` event. Telegram failures emit
`telegram.failed` with a fixed delivery/scheduling reason, without raw error
details, credentials, destinations or booking data (see M5.4 below). They never roll back
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
   a bold header/labels, emojis, Ukrainian weekday/date, time range and name/apartment.
   Check that the description is absent. Try a name such as `Олена & <12>` and
   confirm it appears literally. A valid public HTTPS `ADMIN_ORIGIN` adds the
   calendar link; local development configuration omits it.
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
   `telegram.failed` event with `reason: delivery`. Replaying the POST must not resend.
   Restore the valid local test configuration and restart the Worker afterward.

Automated tests use mocked Telegram fetches and ephemeral local D1. They cover
committed delivery, nonblocking responses, sequential/concurrent replay deduplication,
validation/conflict/block suppression, missing configuration, safe failure logging
and persistence despite delivery/scheduling failure. Run `npm run format`,
`npm test`, `npm run typecheck`, `npm run build`, `npm run lint` and
`npm run format:check`. Live test-group verification is an owner manual check;
automated tests never contact Telegram.

If the Node test script succeeds but an app booking fails to notify, inspect
`telegram.skipped` versus `telegram.failed` (see M5.4 below). Check configured
credentials, the group and bot permissions without logging secrets. Restart the
local Worker after changing `.dev.vars`. Create a new booking for each delivery
check; replaying a persisted booking never resends the notification. Never log
raw fetch errors or Telegram response bodies while investigating.

The Telegram client uses `redirect: 'manual'`: Cloudflare Workers does not
support `redirect: 'error'`, even though Node fetch does. Redirect responses
are rejected as HTTP failures without following their destination. This keeps
Node-script and Worker delivery compatible while preserving redirect protection.

## M4.3 — Telegram cancellation notifications

A newly persisted resident cancellation request schedules one private Ukrainian
HTML message to `TELEGRAM_ADMIN_CHAT_ID`. It includes the booking date, time range,
name/apartment and trimmed cancellation reason. A valid public HTTPS
`ADMIN_ORIGIN` adds a link to `/admin`; absent, local or invalid origins omit it.
The reason is sent only to the configured admin destination, never to the group.
Keep `TELEGRAM_ADMIN_CHAT_ID` set to the administrator's private chat, distinct from
the residents' group.

Example private message (rendered HTML):

```text
🌿 Липа Lounge | Запит на скасування

📅 Дата: вівторок, 20 жовтня 2026 р.
🕒 Час: 18:00–20:00
👤 Ім’я / квартира: Квартира 12
📝 Причина: Змінилися плани, просимо скасувати.

🔐 Переглянути запити
```

An actual booking cancellation schedules one message to `TELEGRAM_GROUP_CHAT_ID`,
for both approval of a resident's request and direct administrator cancellation.
It includes only the date, time range, availability statement and optional public
calendar link. It excludes the reason, name/apartment, description and internal IDs.
Rejection sends no notification. Removing a technical block sends none either.

Example group message (rendered HTML):

```text
🌿 Липа Lounge | Бронювання скасовано

📅 Дата: вівторок, 20 жовтня 2026 р.
🕒 Час: 18:00–20:00

✅ Цей час знову доступний для бронювання.

📆 Відкрити календар
```

Both messages reuse `worker/telegramMessages.ts`, its HTML escaping, Ukrainian civil
date formatting and public-origin validation. Delivery reuses `worker/telegram.ts`
and `ExecutionContext.waitUntil`. The existing D1 batches retain their conditional
writes and transaction ordering; their write counts gate notifications after commit.
Concurrent/repeated requests and overlapping approval/direct cancellation calls
schedule at most one message for each actual transition. A new request after a
rejection is a new transition and may notify the administrator again. Existing
HTTP status codes, response shapes, authentication and CSRF checks are unchanged.
No migrations, dependencies, frontend changes or notification channels are added.

Missing/blank token or destination skips that notification. Telegram and scheduling
failures cannot change successful API responses or committed D1 state. Structured logs contain
only safe event fields (see M5.4), never credentials, chat IDs, private reasons or names.
Delivery remains best effort: there is no outbox, queue, retry or recovery after a
crash between commit and scheduling. Network failure can also leave delivery
uncertain. Replaying an operation does not resend its notification, even if the
original delivery failed. Telegram acceptance does not guarantee a person read it.

### Local owner verification

1. Apply local migrations with `npm run db:migrate:local`. In `.dev.vars`, set the
   bot token, `TELEGRAM_GROUP_CHAT_ID` to the dedicated **test group**, and
   `TELEGRAM_ADMIN_CHAT_ID` to your private admin chat. Start/open the bot in the
   private chat first. Keep real residents' chat IDs out of local testing.
   Use `npm run telegram:test -- admin` and `npm run telegram:test -- group`
   for explicit connectivity tests if needed.
2. Start `npm run dev:worker` and `npm run dev`. Create a future booking, then
   request cancellation with an explanation containing `<`, `>`, `&` and quotes.
   Confirm one private admin message with literal text, the right date, time and
   name/apartment. Confirm the test group receives no cancellation reason.
   The existing new-booking notification is expected when creating the booking.
3. Repeat the cancellation request POST: expect 409 and no additional private
   message. Log in at `/admin`, approve the request, and confirm one group message
   stating the interval is available again. Repeat approval and direct cancellation
   of the same booking: expect their existing responses and no additional message.
4. Create another booking/request, reject it and confirm no group notification and
   that the booking stays active. Directly cancel it afterward: confirm one group
   notification without any private details. Also directly cancel a booking with
   a pending request; the request becomes approved and only one group message is sent.
5. Local HTTP `ADMIN_ORIGIN` omits both links. Verify `/admin` and `/` links only
   with a valid public HTTPS frontend origin configured for your test setup; links
   never come from request headers. Do not change production settings for this test.
6. Restart with a missing token/admin/group destination and confirm the relevant
   operation still succeeds without delivery. A deliberately invalid test token
   should log `telegram.failed` while preserving the request/cancellation.
   Restore `.dev.vars` afterward. Repeated operations must not resend.

Automated tests use mocked Telegram fetches and ephemeral local D1, without live
Telegram messages. They cover concurrency across both paths, repeated operations,
rejection, validation/conflicts, rollback, authorization/CSRF, configuration absence,
delivery/scheduling failure isolation, HTML escaping and group privacy. Browser and
live test-group verification remain owner checks; no production deployment is needed.

## Production deployment (M5.1a)

Preparation only: no Cloudflare resources have been created or deployed by this
task. The following commands are for the owner to run when launch is authorized.
Run from the repository root with Node 24+ and `npm ci` completed.

### Configuration decisions

Use the existing `lypa-lounge-api` Worker and one `lypa-lounge-db` D1 database in
the default Wrangler configuration; there are no named environments or staging.
Wrangler runs `npm run build` and uploads only `dist/` as Static Assets alongside
the Worker. SPA navigation, including direct `/admin` loads, serves `index.html`.
`/api` and `/api/*` always run the Worker, including browser navigations and
unknown API routes, so API errors remain JSON. No asset binding or Worker code
changes are needed. See [Cloudflare Static Assets routing](https://developers.cloudflare.com/workers/static-assets/binding/).

| Binding / value          | Classification                           | Required in production                                                               | Configuration                                                                                      |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `DB`                     | D1 binding, non-secret resource metadata | Yes, for all API storage                                                             | Existing `d1_databases` entry in `wrangler.jsonc`; replace the zero UUID after creation            |
| `ADMIN_ORIGIN`           | Ordinary server configuration            | Yes, for admin authentication and mutations; also enables Telegram links             | Add `vars.ADMIN_ORIGIN` in `wrangler.jsonc`: exact public HTTPS origin, no path or trailing slash  |
| `ADMIN_PASSWORD`         | Secret                                   | Yes, for admin login (16–1024 characters)                                            | Interactive `wrangler secret put` below; generate a unique random password with a password manager |
| `TELEGRAM_BOT_TOKEN`     | Secret                                   | Optional for the API; required for all Telegram delivery                             | Interactive `wrangler secret put`                                                                  |
| `TELEGRAM_GROUP_CHAT_ID` | Private destination, stored as a secret  | Optional for the API; required with the token for booking/cancellation group notices | Interactive `wrangler secret put`; residents' group where the bot may send                         |
| `TELEGRAM_ADMIN_CHAT_ID` | Private destination, stored as a secret  | Optional for the API; required with the token for cancellation-request notices       | Interactive `wrangler secret put`; administrator's private chat, distinct from the group           |

Missing Telegram configuration skips the affected notification without failing
the booking operation. Configure all three Telegram secrets for the intended
launch behavior. The administrator must start the bot privately; add the bot to
the residents' group and grant send permission. Delivery is best effort, without
automatic retries. `ADMIN_PASSWORD` missing/invalid fails authentication closed.

Production uses Wrangler configuration and Cloudflare secrets, never `.dev.vars`.
That ignored file remains local-only, including for `npm run telegram:test`;
that script does **not** verify deployed secrets. Never copy it into `dist/`,
upload it as an asset, or use it to bulk-populate production secrets. Never put
secrets or private chat IDs in `vars`, frontend source, `VITE_*`, logs, shell
arguments, screenshots or Git. No frontend environment variables are required:
the frontend fetches same-origin `/api/*`.

### Owner-run launch sequence (remote changes)

1. Authenticate and confirm the intended Cloudflare account has Workers and D1
   permissions:

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

   If you have multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` in your shell to the
   chosen account's actual ID for all commands in this session. It is account
   selection metadata, not an application binding. Do not invent identifiers.
   In Cloudflare's Workers & Pages dashboard, confirm/configure the account's
   `workers.dev` subdomain. The initial public origin will be
   `https://lypa-lounge-api.<your-actual-subdomain>.workers.dev`.

2. Create the single production database **once**:

   ```sh
   npx wrangler d1 create lypa-lounge-db
   ```

   In the existing `d1_databases` entry in `wrangler.jsonc`, replace only the
   all-zero `database_id` with the returned UUID. Keep binding `DB`, name
   `lypa-lounge-db`, and `migrations_dir: "migrations"`. Do not append a second
   database or deploy with the placeholder. Add a top-level `vars` object with
   `ADMIN_ORIGIN` set to the actual HTTPS origin determined in step 1. Review
   these non-secret configuration changes before deploying; they may be committed
   once the resources and origin exist. Keep local overrides in `.dev.vars`.

3. Review all four checked-in migrations (`0001`–`0004`), confirm the target
   database UUID/account, then list and apply pending migrations **remotely**:

   ```sh
   npx wrangler d1 migrations list DB --remote
   npx wrangler d1 migrations apply DB --remote
   npx wrangler d1 migrations list DB --remote
   ```

   For comparison, `npm run db:migrate:local` and
   `npx wrangler d1 migrations list DB --local` affect only local state. Local
   migrations and test bookings are not transferred to production. Never use
   local fixtures/seed SQL against production. Migrations change live schema/data:
   review SQL and back up existing production data before later migrations.
   Do not delete/recreate D1, drop tables, reset data, or run ad hoc cleanup SQL
   as a deployment step. Cancellation preserves history and consumed keys.

4. Configure server secrets interactively for `lypa-lounge-api`:

   ```sh
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_GROUP_CHAT_ID
   npx wrangler secret put TELEGRAM_ADMIN_CHAT_ID
   ```

   Enter each production value only at its prompt. These commands change remote
   state and can deploy a new Worker version. On first use, Wrangler may prompt
   to create the not-yet-deployed Worker; confirm the exact Worker/account before
   accepting. This establishes secrets before the application goes live. Do not
   share the URL until setup and verification are complete. Secrets persist
   across normal deployments; configuration in `vars` is managed by the file.
   See [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

5. Validate locally, then deploy the Worker and frontend together:

   ```sh
   npm run format
   npm test
   npm run typecheck
   npm run lint
   npm run build
   npm run format:check
   npx wrangler deploy
   ```

   `wrangler deploy` rebuilds the frontend via the configured build command.
   It is a **remote write**. The output reports the deployed `workers.dev` URL;
   confirm it exactly matches `vars.ADMIN_ORIGIN`. If different, correct the
   origin in `wrangler.jsonc` and redeploy before using admin functionality.
   No custom domain, separate frontend host, staging, or CI/CD is required.

### Production verification (owner)

Use the actual deployment URL below; replace the example before running:

```sh
LYPA_URL='https://lypa-lounge-api.<your-actual-subdomain>.workers.dev'
curl -i "$LYPA_URL/api/health"
curl -i -H 'Sec-Fetch-Mode: navigate' "$LYPA_URL/api/unknown"
```

Expect health HTTP 200 with `{"status":"ok"}` (D1 connectivity), and unknown API
HTTP 404 JSON even with navigation headers. Then verify in a browser:

- Open `/` on mobile, load the calendar, select dates, create a clearly labelled
  future test booking in an agreed free slot, and reload to confirm persistence.
  Check static JS/CSS load and API responses are JSON in the network panel.
- Load `/admin` directly and reload it. Before login, admin data must be denied;
  an incorrect password must fail. Log in with the production password, check
  the booking list, create/remove a technical block in another free slot, and
  confirm public availability updates without exposing the internal block reason.
- Request cancellation of the test booking with a harmless test reason. Confirm
  one private admin Telegram notice with the reason and `/admin` link; the group
  must not receive that reason. Approve in `/admin`: confirm the slot becomes
  free and one group cancellation notice contains only date/time, availability
  text and the calendar link, without name, reason, description or internal IDs.
- Confirm the original new-booking group notice included date/time and
  name/apartment, with no description. Check links use the production HTTPS
  origin. If testing direct admin cancellation or rejection, use another labelled
  booking: direct cancellation sends one group notice; rejection sends none and
  keeps the booking active. Removing a technical block sends none.
- Log out and confirm admin access is denied again. Existing same-origin JSON
  mutation checks, HttpOnly/SameSite session cookies and HTTPS Secure cookies
  remain unchanged. Do not weaken origin checks to resolve setup errors.

Coordinate these tests with residents: production writes persist and send real
messages. Cancel test bookings via admin; retain their rows/history. If Telegram
does not deliver, verify token, destinations, bot membership/send permission and
private chat initiation. Review only sanitized failure messages; do not log
credentials or payloads. Replaying a successful booking/cancellation does not
resend a failed notification. Live Cloudflare, browser and Telegram checks remain
owner actions after deployment; automated tests use ephemeral local D1 and mocked
Telegram delivery.

## Observability & Analytics (M5.4)

Preparation only: these settings take effect on a later owner-authorized deployment.
No remote Cloudflare resources, settings, secrets or production data were changed.
The installed Wrangler 4.151.1 supports the checked-in settings; no upgrade is needed.

In the Cloudflare account dashboard:

| View              | Location / purpose                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers Analytics | **Workers & Pages → Worker → Metrics**: existing native requests, errors and CPU metrics; no extra binding or analytics code required.                                                                                                                         |
| Workers Logs      | **Workers & Pages → Worker → Observability → Logs**: invocation logs and structured console events. Filter by `event` and severity.                                                                                                                            |
| Workers Issues    | **Workers & Pages → Worker → Issues**: grouped errors, failed invocations and HTTP 5xx responses. Only new traffic is processed after enabling.                                                                                                                |
| D1 metrics        | **Storage & databases → D1 → lypa-lounge-db → Metrics**: rows read/written, query volume/duration and database storage. The database overview also shows size. Use **Query Insights**, when available, for per-query execution time, frequency and row counts. |
| Web Analytics     | Account **Web Analytics → site**: page views, visits and Core Web Vitals after beacon setup.                                                                                                                                                                   |

`wrangler.jsonc` enables persisted Workers Logs, invocation logs and Issues with
100% head sampling, plus query-string redaction. Workers Analytics remains native
and unchanged. No traces, SDK, export destination or custom SQL metrics tables
are added. The original configuration had no explicit observability or source-map
settings; existing Dashboard settings were not inspected or changed remotely.
See [Wrangler observability configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#observability),
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
[Issues](https://developers.cloudflare.com/workers/observability/issues/) and
[D1 analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).

Live inspection (owner, authenticated Cloudflare account):

```sh
npx wrangler tail lypa-lounge
```

**Confirm the Worker name before deployment or tailing.** The supplied production
URL uses `lypa-lounge`, but this repository still configures `lypa-lounge-api`.
If the latter is the intended deployed Worker, use `npx wrangler tail lypa-lounge-api`.
This preparation does not rename either Worker or resolve the mismatch remotely.

Application logs use native `console.info`, `console.warn` and `console.error`:

| Events                                                                      | Severity and meaning                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reservation.created`, `technical_block.created`, `technical_block.removed` | INFO, `outcome: success`; one committed insert/removal, never an idempotent replay.                                                                                                                                                     |
| `reservation.conflict`                                                      | WARN, `outcome: conflict`; unavailable interval or reuse of a booking key with different input.                                                                                                                                         |
| `cancellation.requested`, `cancellation.approved`, `cancellation.rejected`  | INFO, `outcome: success`; committed request/review transition. Direct admin cancellation also logs approval when it actually resolves a pending request. Direct cancellation without a pending request has no review transition to log. |
| `database.error`, `api.unexpected_error`                                    | ERROR, `outcome: failure`; fixed safe events, without caught error objects or messages. Database-operation handler failures use the former; outer routing/authentication failures use the latter.                                       |
| `telegram.sent`                                                             | INFO, `outcome: success`; Telegram accepted the API request, not proof anyone read it.                                                                                                                                                  |
| `telegram.failed`                                                           | ERROR, `outcome: failure`, fixed `reason: delivery` or `scheduling`; no raw Telegram responses or URLs.                                                                                                                                 |
| `telegram.skipped`                                                          | WARN, `outcome: skipped`, fixed `reason: missing_configuration` or `missing_context`; distinct from attempted delivery failure.                                                                                                         |

Telegram events include only `notificationType`: `reservation_created`,
`cancellation_requested` or `reservation_cancelled`. Existing `waitUntil` delivery
remains best effort, without retries or an outbox. Logging exceptions are swallowed.
Business events use existing committed D1 write counts, with no extra queries.
There is no application log for every successful GET. These logs are diagnostic,
not a durable audit ledger: a crash between commit and logging can lose an event.

Application console fields exclude resident names/apartments, descriptions,
cancellation reasons, IDs, idempotency keys, credentials, destinations, cookies,
headers, bodies, database records, IP addresses and request URLs. Prior raw D1
error logging and fixed Telegram failure text have been replaced by safe events.
Cloudflare platform observability independently records request metadata; invocation
paths can contain IDs even with query strings redacted. Restrict dashboard/tail
access and do not share raw platform logs. No operational logs are exposed by APIs.

`upload_source_maps: true` lets Wrangler generate Worker maps alongside its bundle
and upload them on a future deployment. Maps stay outside public `dist/`; frontend
source maps remain disabled. Local packaging verifies TypeScript mappings, but
live Cloudflare stack remapping remains an owner check after deployment. Caught
errors deliberately omit their raw messages/stacks for privacy, so these structured
error events alone cannot provide original exception stacks. Uncaught runtime
exceptions can use the uploaded maps. See [source maps](https://developers.cloudflare.com/workers/observability/source-maps/).

### Web Analytics setup (owner)

1. After merging, open account **Web Analytics → Add a site**, enter the actual
   production hostname, then open **Manage site** and copy the public `token`
   from the official JavaScript snippet. Use manual snippet installation; avoid
   automatic injection as well as this integration, which would double-count.
   See [Cloudflare setup](https://developers.cloudflare.com/web-analytics/get-started/).
2. Store `VITE_CLOUDFLARE_WEB_ANALYTICS_TOKEN` in the Git-tracked `.env.production`
   file at the repository root. The token is a **public browser identifier**,
   embedded by Vite during production builds, so it is safe to commit. This makes
   the analytics configuration reproducible when building and deploying manually
   with Wrangler from any computer after cloning the repository and installing
   dependencies. Keep only this public token in `.env.production`; never add
   passwords, Telegram settings or other secrets. `.env.local`, local production
   overrides and `.dev.vars` remain ignored. Avoid local or shell overrides of
   this token when building the shared production configuration. Worker secrets
   remain managed separately through Cloudflare.
3. Rebuild and deploy only when separately authorized. The official deferred
   `https://static.cloudflareinsights.com/beacon.min.js` script is loaded once
   in production builds only, when the token is a valid 32-character hexadecimal
   value. Missing/blank/malformed values load no script and make no beacon request.
   Vite development mode does not enable analytics.
4. Visit the deployed site, check the browser Network panel for the beacon script
   and a successful request to Cloudflare's analytics endpoint, then wait a few
   minutes and verify page views in **Web Analytics → site**. Core Web Vitals need
   real supported browser traffic; blockers may prevent collection. No booking
   form values, resident identity or custom business events are sent by the app.
   The official beacon needs no analytics cookies. Page URLs/referrers are still
   analytics metadata: never put resident details in URLs.

After merging, the owner must reconcile the Worker name, optionally configure the
Web Analytics site/token, authorize a normal deployment, and confirm Logs/Issues
are enabled in that Worker's Dashboard. No separate Issues Dashboard toggle is
required by this Wrangler version, but availability and ingestion must be checked
there. Inspect a normal booking's safe events and confirm existing D1 metrics.
Do not intentionally crash production to test source maps; use a separately
approved nonproduction diagnostic if live verification is needed.

Free-plan limits are finite: as documented in October 2026, Workers Logs includes
200,000 events/day with three-day retention; invocation and console events both
consume capacity. Issues is currently free during beta. D1 daily row-read/write
and storage limits still apply; excess usage can fail queries. Web Analytics can
be blocked and is not an exact visitor census. Review current
[Logs limits/pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing)
and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) before
changing sampling or plans; Cloudflare documents a Logs pricing change for
December 1, 2026. 100% sampling is the initial setting, not a guarantee of complete
retention or delivery.
