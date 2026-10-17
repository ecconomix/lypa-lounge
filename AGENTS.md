# Lypa Lounge — Agent Instructions

## Project

A minimal web application for booking a shared
residential gazebo.

The primary target is mobile users.

## Tech Stack

- React
- TypeScript (strict)
- Vite
- Plain CSS
- npm
- Cloudflare Workers and D1 (M2 backend foundation)

## Engineering Principles

- Keep implementations simple and maintainable.
- Prefer native browser APIs.
- Avoid unnecessary abstractions.
- Avoid introducing dependencies unless justified.
- Follow existing project conventions.
- Use functional React components.
- Use semantic HTML and accessible controls.
- Prioritize mobile-first responsive design.

## Constraints

Do not introduce:

- Tailwind or UI component libraries
- React Router
- Redux, Zustand, or other state libraries
- Axios or TanStack Query
- Calendar libraries
- Backend functionality during M1

## Validation

Before completing a task:

- Run npm run format after implementation and before the final build and lint checks
- Run npm test
- Run npm run build
- Run npm run lint
- Run npm run typecheck after implementation to check frontend, Vite config, and Worker TypeScript types
- Verify the acceptance criteria
- Summarize changed files
- Report any known limitations

Do not modify unrelated files.
Do not commit or push unless explicitly requested.

## Backend

- Worker source lives in `worker/`; D1 migrations live in `migrations/`.
- Use `wrangler.jsonc` and generate runtime types with `npm run types:worker`.
- Local Worker and migration scripts must use `--local`.
- Booking dates and times use Europe/Kyiv; absolute timestamps use UTC Unix seconds.
- Reservation writes must use the atomic conditional insert in `worker/reservations.ts`;
  never check availability and insert as independent operations.
- Preserve consumed idempotency keys, including for cancelled rows. Booking payload
  fields remain immutable so stored fields can identify identical normalized retries.
  Future edit APIs must preserve the original payload before modifying these fields.
- Booking text limits after trimming: name 100, description 1000 UTF-16 code units.
- Do not provision remote Cloudflare resources or deploy without an explicit request.

## Testing

- Use Vitest for frontend and backend tests, with explicit imports from `vitest`.
- Colocate tests as `*.test.ts` or `*.test.tsx` beside the code under test.
- Run `npm test` once or `npm run test:watch` during development.
- Tests use the Node environment by default; mocks are restored before each test.
- Worker integration tests call the handler with ephemeral local D1 bindings
  (`persist: false`, `remoteBindings: false`) and the existing migration. Preserve
  this integration coverage; use Vitest mocks for targeted failure cases.
- Keep Node test types in `worker/tsconfig.test.json`, isolated from production
  Worker and frontend types. React component tests use a per-file jsdom directive;
  keep other tests in Node and use React act/native DOM events.

## Frontend API integration

- Use native fetch via `src/api/reservations.ts`; no runtime mock reservations.
- Availability is one Kyiv 31-day snapshot; date selection must not fetch.
- Deduplicate GETs and ignore aborted responses. Refresh after writes/conflicts,
  on visible-tab return and Kyiv day rollover; do not poll the API.
- Preserve confirmed POST success if refresh fails. Keep uncertain submission
  payloads/UUID keys for identical retries, including when time/availability changes.
  Never reuse a consumed key for a different booking. POSTs are not cancelled by GET cleanup.
- Frontend component tests opt into jsdom; run `npm test -- src` or all `npm test`.
