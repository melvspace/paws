# Paws

Paws manages agents with dedicated roles, workspaces, skills, tools, shells, and
browser profiles. Codex subscriptions are the first provider; keep orchestration
independent of provider protocols. Architecture adapted from T3 Code (MIT).

## Boundaries

- `apps/server`: thin HTTP/WebSocket transports calling Effect services. Owns
  persistence and agent lifecycle; remains authoritative for validation.
- `apps/web`: React UI. `apps/desktop`: sandboxed Electron wrapper for that UI.
- `packages/contracts`: Effect schemas for wire data; decode at trust boundaries.
- `packages/client-runtime`: transport and client state shared across surfaces.
- `packages/provider-core`: provider interfaces. Provider-specific behavior belongs
  in `packages/provider-*`; normalize it before exposing it to orchestration.
- `packages/runtime`: agent environment provisioning and execution boundaries.
  Separate directories are not security isolation. Execution must require a
  container runtime lease; keep credentials outside agent-readable mounts.
- `packages/shared`: small, environment-independent helpers.

Prefer SOLID, DRY, and KISS. Keep services reusable from transports and future MCP
tools. Use named `Effect.fn` operations for service tracing. Infer types where
possible, and validate unknown data instead of casting it. React effects own
external resources; derive other state during render or update it in handlers.

## Working here

Run `pnpm check` before handing back implementation work. Add meaningful tests
for persistence, provider translation, lifecycle, and isolation boundaries. Cover
failure and cleanup behavior. Keep web and desktop behavior aligned. Report any
unverified surface honestly.

Default application data to `$HOME/.paws` (`PAWS_HOME` overrides it). Use temporary
isolated roots for tests and `/tmp/codex/` for temporary harnesses and
scripts. Never point tests at live application data or read provider credentials
into logs. Stop only processes you started and tracked. Keep browser requests
same-origin through the dev proxy. Local development is loopback-only; remote
hosting requires authentication and origin enforcement first.

Keep only the root README (essential top-level module READMEs are allowed).
Write progress, handoffs, and summaries in chat. Add `docs/` content only when
explicitly requested as durable reader-facing documentation. Use `ci:` for CI
commits. Use MCP for YouTrack. Do not use question tools during grilling.

## UI conventions

Agent settings autosave: persist selections immediately, text on blur, and flush
pending edits before dismissal. Keep failed edits visible with actionable errors;
show feedback only for pending work or failures, without Save/Apply buttons. Creation and destructive
actions remain explicit. Put management controls in the existing Settings dialog,
and keep sidebar controls compact. Use the original agent settings as the visual
baseline: hide its title accessibly, use concise field labels, and omit redundant
prose, placeholders, status slogans, and repeated headings. Group related rows in
one container with dividers, not separate rounded cards. Hide empty Unassigned;
keep actual teams available as drop targets. Allow dragging idle agents between team sections; preserve
unrelated memberships and validate moves on the server.

Keep the compact Paws glossary in `packages/provider-core/src/glossary.ts` current
when domain terms or their meaning change; use neutral definitions, not behavior
rules or mandatory vocabulary.

## Formatting and visuals

Separate logical steps and inner functions with exactly one blank line. Add one
before unrelated `if`/`for`/`while`/`switch` blocks and final returns, throws, or
exits following other statements. Keep `else`, `catch`, `finally`, and chain
continuations attached. Wrap long chains with each dot/operator starting an
indented continuation. For calls with more than two arguments or over roughly
80 characters, put each argument on its own line with trailing commas.

Do not use teal, midnight blue, or warm amber. Avoid continuous repainting
animations; expose loading, disconnected, empty, and error states explicitly.
