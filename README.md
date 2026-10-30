<img src="assets/icon.svg" width="64" height="64" alt="">

# Paws

A local-first app for managing a team of agents, each with a name and its own
workspace, skills, tools, shell, and browser environment. Provider setup and model catalogs support Codex, Claude, Cursor, Grok, fx,
OpenCode, Antigravity, Muse, Pi, and installed ACP agents.

## Development

Use Node 24.14+ and pnpm 12.14.0 (`npx pnpm@12.14.0` also works).

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173. The Node service listens on loopback port 4310; Vite
proxies HTTP and WebSocket traffic. Agent records persist in `.paws/state.sqlite`.
Set `PAWS_HOME` to move application state. Never point tests at your real state.

```sh
pnpm --filter @paws/web exec playwright install chromium # once, for browser tests
pnpm check          # format, lint, types, unit/browser tests, web production build
pnpm dev:desktop   # Electron wrapper; run pnpm dev first
```

Electron 44 ships its binary separately. Before the first desktop launch, run
`node node_modules/.pnpm/electron@44.10.0/node_modules/electron/install.js`.
The desktop shell currently loads the development web server; standalone desktop
packaging and a bundled server are not implemented.

## Architecture

Inspired by [T3 Code](https://github.com/pingdotgg/t3code), inspected at commit
`e2d9d9a7bb968ee8dfc33787dcfe4d5f54116da0`. Uses its current core stack:
pnpm workspaces, Vite+ (Vite, testing, linting, formatting), strict TypeScript,
React 19, TanStack Router with generated file routes, Base UI, CVA, tailwind-merge,
Tailwind CSS 4, Effect 4 schemas/services and React atom bindings, Inter Variable,
Node HTTP/WebSocket, SQLite, and Electron. This is a focused foundation, not a
copy of T3 Code's mobile, cloud, or full coding-agent feature set.

| Location                   | Responsibility                                                  |
| -------------------------- | --------------------------------------------------------------- |
| `apps/web`                 | Agent roster and creation UI                                    |
| `apps/server`              | Agent service, SQLite persistence, HTTP and WebSocket transport |
| `apps/desktop`             | Sandboxed Electron shell sharing the web app                    |
| `packages/contracts`       | Validated agent and transport schemas                           |
| `packages/client-runtime`  | Connection lifecycle and shared client state                    |
| `packages/provider-core`   | Provider/session abstractions                                   |
| `packages/provider-codex`  | Codex app-server discovery and device-code sign-in              |
| `packages/provider-native` | Native SDK/CLI discovery and model capability translation       |
| `packages/runtime`         | Workspace provisioning and container lease contract             |
| `packages/shared`          | Shared validation helpers                                       |

Clients consume contracts; the server owns lifecycle and persistence. Runtime
isolation and provider communication are separate concerns. Adding a provider
should not require rewriting agent management or exposing its protocol to the UI.

## Current capabilities and execution boundary

You can create, rename, and delete agents, see updates over WebSocket, and recover the roster
after a restart.
Selecting an agent opens its chat workspace, with independently collapsible
files sidebar and terminal panel. Drafts and panel preferences are saved per
agent in browser storage. Chat sending, file browsing, and terminal execution
remain unavailable until their runtime integrations are connected.
Deleting an agent removes its record but preserves its workspace files on disk.
Each agent gets dedicated workspace, home, Codex home, skills, and browser
profile directories under `.paws/agents/<uuid>/`.

These directories provide organization, **not a security sandbox**. No agent
commands run yet. The next execution layer must supply a container per agent,
explicit filesystem mounts, a filtered shell environment, tool grants, and an
isolated browser process/profile. The runtime lease is the contract for that
boundary. Skills installation, tool configuration, browser control, conversations, approvals, and run history are not implemented.

## Providers

Open Settings → Providers to enable an integration, configure its executable and
arguments, refresh its model catalog, or add another instance. Only installed
providers appear initially; use + to add other providers for setup. Providers can
be disabled but not removed through the app. Model visibility, favorites, and order
are saved locally and shared with the composer picker. Model identities
include the instance ID, so accounts can expose the same model without collisions.
The composer reads reasoning, service-tier, and other options from the selected
model; unavailable selections remain visible until replaced.

Codex uses its app-server protocol and ChatGPT device-code sign-in. Cursor uses
its SDK and stores sign-in credentials separately for each instance. Other native
providers use their installed CLI/SDK and native authentication; install and sign
in on the server host before refreshing. Antigravity requires its official ACP
runtime and authentication environment. Generic ACP entries accept an installed
agent executable and launch arguments; automatic registry installation is not
implemented.

New Codex, Claude, and Pi instances get dedicated configuration directories.
The initial Codex instance uses the existing CLI login. Environment overrides are
stored in the owner-only server database and are write-only through the API.
Provider discovery runs bounded helper processes, does not submit prompts, and
rejects client tool requests. ACP catalog discovery creates a temporary native
session on explicit refresh; native startup behavior belongs to the installed agent.

Chat turn execution, conversation persistence, approvals, and credential brokerage
into container-isolated agent runtimes remain unimplemented. Provider setup and
model discovery do not enable host agent execution.

## Attribution

Shared UI primitives, theme previews, and the model picker adapt T3 Code's
Base UI components. Provider registry, capability translation, and native probes
adapt its provider drivers. Model choices and options are saved per agent.

Workspace layout and controls adapt T3 Code's `ChatView.tsx`,
`chat/PanelLayoutControls.tsx`, `ChatRightPanel.tsx`, `RightPanelTabs.tsx`,
`RightPanelSheet.tsx`, and `ThreadTerminalDrawer.tsx`. The pointer resize engine
is ported from `hooks/useResizeDrag.ts`, extended for vertical resizing. Panel
width limits and composer lane sizing follow the same source. Resize with the
panel edges or arrow keys on a focused divider; double-click resets its size.

Repository boundaries and agent guidance were adapted from T3 Code, copyright
2026 T3 Tools Inc., under the MIT license. See `LICENSE.t3code`. Paws retains its
own branding and does not include T3 Code's product assets.
