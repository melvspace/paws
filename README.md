<img src="assets/icon.svg" width="64" height="64" alt="">

# Paws

A local-first app for managing a team of agents, each with a name and its own
workspace, skills, tools, shell, and browser environment. Provider setup and model catalogs support Codex, Claude, Cursor, Grok, fx,
OpenCode, Antigravity, Muse, Pi, and installed ACP agents.

## Development

Use Node 24.14+ and pnpm 12.14.0 (`npx pnpm@12.14.0` also works).

```sh
pnpm install
pnpm runtime:build  # once, with Docker running, to enable Codex chat
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
| `packages/provider-codex`  | Codex discovery, sign-in, thread execution and messenger tools  |
| `packages/provider-native` | Native SDK/CLI discovery, execution and capability translation  |
| `packages/runtime`         | Workspace provisioning and per-agent Docker runtime leases      |
| `packages/shared`          | Shared validation helpers                                       |

Clients consume contracts; the server owns lifecycle and persistence. Runtime
isolation and provider communication are separate concerns. Adding a provider
should not require rewriting agent management or exposing its protocol to the UI.

## Current capabilities and execution boundary

You can create, rename, and delete agents, see updates over WebSocket, and recover the roster
after a restart.
Selecting an agent opens its chat workspace, with independently collapsible
files sidebar and terminal panel. Drafts and panel preferences are saved per
agent in browser storage. Conversations persist on the server and update over
WebSocket. Enter sends a message; Shift+Enter adds a newline; Stop cancels the
current reply. The first message creates a native provider session, and later messages
resume it, including after a server restart. Each agent has independent history
and a dedicated working folder at `.paws/agents/<uuid>/workspace`.

Agents can call `paws_send_message` to send short message bubbles, action buttons,
and forms with text, multiline, or select fields. Button clicks and validated form
submissions arrive as structured Paws harness events in the native session;
they do not create user-authored chat bubbles. The original card records the
response. Controls are plain data, never executable HTML. Each interactive
message accepts one response.
Duplicate HTTP retries do not start duplicate turns; only one turn runs per agent.

During a turn, messages and interactive responses can steer the running adapter
or wait in its queue. Steering is an optional capability of the shared provider
interface; adapters without it queue automatically. An explicit rejection falls
back to the queue, while uncertain delivery is never replayed. Stop cancels queued
work too. Queue and delivery states appear alongside messages and cards. Secret
responses queue for a fresh turn so their temporary files have a clear lifetime.
Choose the default in Settings → Chat → Follow-ups. The composer shows Stop with
an empty draft, and Steer or Queue when typing during a turn. Hold Ctrl/Cmd to
preview the opposite action; Ctrl/Cmd-click or Ctrl/Cmd+Enter sends it.

`request_secret` displays a private input with Save securely and Decline. Values
are not persisted in chat, broadcasts, or model input. A saved secret is delivered
through stdin to an owner-only file in the next turn's container tmpfs; the agent
receives only its path. The file disappears with that container. This explicitly
allows the agent to use the value in commands, so commands must not print or copy
it. Older native threads use a reserved `paws_secret` field on `paws_send_message`
to request the same private input without replacing their conversation history.

Chat execution requires Linux and Docker. Run `pnpm runtime:build` once to build
the runtime image. Codex additionally requires its native Linux distribution
(including adjacent tool helpers) and a ChatGPT subscription login stored by the
CLI in `auth.json`. Other adapters use their configured native SDK/CLI credentials;
OpenCode also offers free models without a provider login. Missing installations,
authentication requirements, and account restrictions must be resolved in the
provider itself. Other operating systems have not been verified.

Each turn leases a container with only that agent's workspace and home mounted,
plus read-only executables for Codex turns. Its working directory is `/workspace`. The
container has a read-only root filesystem, dropped Linux capabilities, resource
limits, and no Docker socket or host home mount. Provider credentials stay in the
host's private provider home; a host helper refreshes authentication without
receiving user prompts, and external tokens are supplied to the container harness
in memory. They are not mounted or placed in its environment. Containers retain
normal outbound network access. Within its container the agent can run commands
and edit its own files without approval prompts. Other native adapters keep their
SDK/CLI control process on the host and expose Paws tools backed by the same
container boundary. Built-in host tools are disabled or denied; ACP file and
terminal requests are routed to the container. Private session metadata stays
outside agent mounts. Use trusted provider executables: Paws does not sandbox the
host provider process itself.

Deleting an agent cancels its active reply and removes the app's conversation
record while preserving workspace and home files, including native thread logs.
Stopping or shutting down the server cleans up owned runtime containers. An
unexpected server crash marks an interrupted reply on the next startup; it does
not automatically replay the user message. File browsing, the interactive terminal,
skills configuration, browser control, and approval workflows remain unconnected.

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

Chat execution has adapters for Codex, Claude, Cursor, OpenCode, Pi, Muse Code,
Grok, fx, Antigravity, and generic ACP agents. Model options are translated by each
adapter; steering and manual compaction depend on its native capabilities.
Switching provider accounts transfers bounded conversation history to the new
session while preserving the agent's working folder. Switching back resumes that
account's session with only new or changed history. Queued switches wait for the
active reply, and unavailable sessions start fresh with a history handoff. An
uncertain delivery is never automatically replayed.

Live execution and a round-trip handoff have been verified with Codex 0.166.0 and
OpenCode 1.18.35 using a free model. Claude reached its API but the test account
required identity verification. The remaining adapters have protocol or SDK
coverage where available, but have not all been verified against live accounts.
Provider environment variables and host credentials are not copied into agent
containers.

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
