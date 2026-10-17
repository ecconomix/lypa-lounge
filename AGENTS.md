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
- Run npm run build
- Run npm run lint
- Run npm run typecheck:worker for backend changes
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
- Do not provision remote Cloudflare resources or deploy without an explicit request.
