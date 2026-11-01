<img src="assets/icon.svg" width="64" height="64" alt="">

# Paws

Your agents, each with a place of their own.

Paws is a local-first app for working with AI agents. Give each agent a name and
its own workspace, choose a provider and model, and pick up the conversation
whenever you need it. Chats and files stay on your machine; model requests go to
the provider you choose.

Inspired by [T3 Code](https://github.com/pingdotgg/t3code), with a focus on
persistent agents and their individual workspaces.

## What you can do

- **Keep a team of agents.** Create agents with separate conversations and working
  folders. History survives app restarts.
- **Choose how each agent works.** Pick a provider, model, and available reasoning
  options. Connect multiple accounts and switch providers within a conversation.
- **Keep a conversation moving.** Send follow-ups while an agent works, steer a
  running reply when supported, queue the next message, or stop the turn.
- **Respond right in chat.** Agents can send buttons and forms, or request a
  secret through a private input instead of a chat message.
- **Give agents room to work.** Commands and file edits run in Docker containers
  with access to the agent's own workspace.

## Getting started

Paws is early software. For now, run it from source on Linux with Docker.
Other operating systems have not been verified, and packaged desktop downloads
are not available yet.

You'll need:

- Node.js **24.14 or newer** and **pnpm 12.14.0**.
- Docker installed and running, with permission to start containers.
- At least one supported provider installed and authenticated on your machine.
  Codex also supports sign-in from Paws.

```sh
git clone https://github.com/melvspace/paws.git
cd paws
pnpm install
pnpm runtime:build
pnpm dev
```

Open [localhost:5173](http://localhost:5173). Keep the terminal running while you
use Paws. Build the runtime image once before your first chat, and rebuild it
when the runtime changes.

In **Settings → Providers**, enable your provider and refresh its models. Create
an agent, choose a model, and send your first message.

### Providers

Paws includes integrations for Codex, Claude, Cursor, OpenCode, Pi, Muse Code,
Grok, fx, Antigravity, and installed ACP agents. Available models and features
vary by provider and account.

Use **Settings → Providers** to configure an executable, add another provider
instance, or manage which models appear in the picker. Most integrations use
their provider's existing CLI or SDK login. Antigravity requires its official ACP
runtime and authentication environment; generic ACP agents must already be
installed.

Codex and OpenCode have been tested with live conversations and switching between
providers. The other integrations have varying test coverage and have not all
been verified with live accounts. Provider installation, sign-in, or account
restrictions may need to be resolved outside Paws.

### Desktop app

The Electron app currently uses the same local server as the browser app. With
`pnpm dev` running, open another terminal in the repository and run:

```sh
pnpm dev:desktop
```

If Electron's binary is missing on first launch, install it with:

```sh
node node_modules/.pnpm/electron@44.10.0/node_modules/electron/install.js
```

## Your data and agent access

Paws stores its application state in `$HOME/.paws/` by default. Set `PAWS_HOME` before
starting the app to use another location. Each agent's working folder is at
`$HOME/.paws/agents/<uuid>/workspace`.

Deleting an agent removes it and its conversation from Paws, but preserves its
workspace and home files. Back up your state directory if you want to keep your
agents and conversations safe.

Agents can run commands and edit files in their containers without approval
prompts. Containers have outbound network access. Provider credentials remain
outside agent workspaces, but provider executables run on the host, so use ones
you trust. Secrets entered through private inputs are delivered as temporary
files for the agent to use; they are not saved in chat.

Paws is intended for local use. Authentication for remote hosting is not
implemented; do not expose it to the internet.

## Still in progress

File browsing, the interactive terminal, skills configuration, browser control,
and approval workflows are not connected yet. Some workspace panels are UI
placeholders. Standalone desktop packaging is also still in progress.

## Development

To run the full checks, install the browser used by the tests once, then run:

```sh
pnpm --filter @paws/web exec playwright install chromium
pnpm check
```

This checks formatting, lint, types, unit and browser tests, and the web build.
Use a separate state directory for development experiments; never run tests
against your real application data.

## License and acknowledgments

Paws is [MIT licensed](LICENSE). Parts of its UI, provider integrations, workspace
controls, and repository structure are adapted from
[T3 Code](https://github.com/pingdotgg/t3code), copyright 2026 T3 Tools Inc.
The original copyright notice is preserved in [LICENSE](LICENSE).
