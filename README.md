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
- **Give agents room to work.** Team members share a persistent Docker environment.
  Standalone agents run on the host or in an optional private sandbox.

## Getting started

Paws is early software. For now, run it from source on Linux with Docker.
Desktop packaging targets Linux, macOS, and Windows. Linux packaging has been
checked locally; macOS and Windows still need verification on their CI runners.

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

Build installers on the target operating system with `pnpm build:desktop`.
Output is in `release/desktop/`. Packaged apps start their own bundled Node
backend and web client, without a development server or system Node installation.
Port 4310 must be available. Docker and provider CLIs are still separate
prerequisites. Current desktop installers are unsigned and have no automatic
updater; operating-system security prompts may require manual approval.

### Container image

`pnpm build:image` builds the Linux amd64 server image as `paws:local`. Releases
publish the tested image to `ghcr.io/melvspace/paws:<version>` and `:latest`.
The image contains the production web UI, backend, Node runtime, and Docker CLI;
provider executables are installed separately, for example in a derived image.
It runs as the unprivileged `node` user (UID 1000).

```sh
mkdir -p "$HOME/.paws"
docker run --rm --init \
  --publish 127.0.0.1:4310:4310 \
  --env PAWS_HOME="$HOME/.paws" \
  --mount "type=bind,src=$HOME/.paws,dst=$HOME/.paws" \
  paws:local
```

Open `http://localhost:4310`. The state directory must be writable by UID 1000;
use `--user` with your host UID and GID when needed. Agent processes without
sandboxing execute inside the server container.

Teams and sandboxed agents need access to a Docker engine. Build the existing
`paws-team-runtime:1` image on that engine with `pnpm runtime:build`, then add
`--mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock` and
`--group-add "$(stat -c %g /var/run/docker.sock)"` to the run command on Linux.
Keep the state bind mount at the same absolute path on the host and in the
container: the Docker engine resolves agent bind mounts on the host. Docker
socket access grants control of that host engine.

The container sets `PAWS_HOST` and `PAWS_COMPANION_HOST` to `0.0.0.0` internally;
source and desktop defaults remain loopback. To use the Android companion,
configure its origin and token file, mount that file privately, and publish port
4311 on host loopback for an HTTPS reverse proxy. Keep port 4310 private.

### Android companion

`apps/mobile` is an Android WebView companion using the same web UI. Agents and
files remain on your computer. It requires Android 8 or newer and an HTTPS
connection to an authenticated Paws gateway.

To enable the gateway, generate a private connection-token file:

```sh
mkdir -p "$HOME/.paws"
(umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > "$HOME/.paws/companion-token")
```

Set `PAWS_COMPANION_ORIGIN` to your HTTPS origin, such as
`https://your-computer.example.ts.net`, and `PAWS_COMPANION_TOKEN_FILE` to that
file's absolute path before starting Paws. These variables also work when
launching the packaged desktop executable. The gateway listens only on
`127.0.0.1:4311`; forward it through an HTTPS reverse proxy, such as Tailscale
Serve. Forward WebSocket upgrades and preserve the browser's Origin header.
Keep port 4310 private. In source builds, run `pnpm build` and also set
`PAWS_WEB_ROOT` to the absolute path of `apps/web/dist`.

Enter the HTTPS address in the Android app, then enter the token on its sign-in
page. Sessions use secure, HttpOnly cookies. **Change computer / disconnect**
clears the app's cookies. Rotate the token file and restart Paws to revoke all
connections. Provider and MCP sign-in flows that require localhost should be
completed on the computer.

With Java 17 and the Android SDK installed, build a test APK using
`cd apps/mobile && ./gradlew lintDebug assembleDebug` (`gradlew.bat` on Windows).
The APK is under `app/build/outputs/apk/debug/`. The companion has not yet been
verified on a physical phone or emulator.

### Releases and CI

Pushes and PRs run `pnpm check`, build desktop installers, build a debug-signed
Android APK, and build and smoke-test the container image. You can also run
**Build apps** manually in GitHub Actions.
The build checks formatting, lint,
types, unit and browser tests, and the production web build before packaging.
Every desktop runner smoke-tests the packaged backend using an isolated data root.

Release Please uses Conventional Commits on `main` to maintain one release PR,
updating the root and desktop versions, Android version, and changelog. Merging
that PR creates a draft GitHub Release and invokes **Build apps** directly.
The release is published only after all platform builds succeed; it includes
installers, a signed Android APK, and SHA256 checksums. The tested container image
is published to GHCR before the GitHub Release becomes public. Android version codes are
derived from `major * 1000000 + minor * 1000 + patch`; keep minor and patch below 1000. CI changes should use `ci:` commits.

Release Please authenticates as a GitHub App so its release PRs trigger CI.
Install the app on this repository with **Contents: read and write** and
**Pull requests: read and write**, then configure `RELEASE_APP_ID` with its numeric
App ID and `RELEASE_APP_PRIVATE_KEY` with the complete PEM private key. The workflow
mints a short-lived installation token scoped to this repository; no personal
access token is required.

Release APK builds require these repository secrets:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded release keystore.
- `ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `ANDROID_KEY_ALIAS`: signing-key alias.
- `ANDROID_KEY_PASSWORD`: signing-key password.

Keep this signing key backed up; Android updates must use the same key. Test
builds use the debug key and must be uninstalled before installing a release.
Trusted push and manual builds use the four corresponding `ANDROID_DEBUG_*`
secrets when present: `ANDROID_DEBUG_KEYSTORE_BASE64`,
`ANDROID_DEBUG_KEYSTORE_PASSWORD`, `ANDROID_DEBUG_KEY_ALIAS`, and
`ANDROID_DEBUG_KEY_PASSWORD`. PR builds use a temporary default debug key and
receive no signing credentials. For local signed builds, set
`ANDROID_KEYSTORE_FILE` / `ANDROID_DEBUG_KEYSTORE_FILE` to the matching keystore
and supply the corresponding password and alias environment variables.
After a failed release, rerun the failed jobs, or dispatch **Build apps** with
the original release commit in `ref` and the existing draft tag in `release-tag`.
The workflow does not submit to Google Play.

## Your data and agent access

Paws stores its application state in `$HOME/.paws/` by default. Set `PAWS_HOME` before
starting the app to use another location. Each agent's working folder is at
`$HOME/.paws/agents/<uuid>/workspace`.

Deleting an agent removes it and its conversation from Paws, but preserves its
workspace and home files. Back up your state directory if you want to keep your
agents and conversations safe.

Each agent belongs to one team or is unassigned. A team owns a persistent container
created from its chosen template. Members share installed software, running
processes, and team files at `/team/files`, with personal homes and workspaces at
`/team/agents/<uuid>/`. Personal folders organize files; teammates can access them.
Use the ordinary shell for commands and `sudo` for system packages. Installed
software survives container and application restarts. Shared MCP connections are
managed through `paws_mcp`; local MCP commands use the same team environment.

Unassigned agents default to host execution (`sandbox: false`). Enable Sandbox in
agent settings for a private persistent container. Host agents have the access
of the account running Paws. Reassignment requires an idle agent and confirmation;
personal files move with it, shared team files stay behind, and provider sessions
restart with the conversation history. Move all members before deleting a team.

Remote MCP connections use the active harness when a native adapter is available
(currently Codex). Paws runs that client in an isolated helper with a private team
MCP home, without model turns or global provider credentials. Agents provide a
Paws sign-in link; approve access in the browser, then paste the final callback
URL into the private form when prompted. This uses Codex's supported no-browser
login and works when the provider only accepts a loopback callback. Keep callback
URLs out of chat. Settings → Teams → Integrations also offers **Sign in** after
the agent selects its harness. Login attempts survive chat turns for up to ten
minutes; shutdown cancels pending attempts. Saved credentials are reused by team
members using that harness. Other harnesses retain the generic HTTP OAuth/bearer
client; a service can still restrict which clients it accepts.

Templates are recorded in team settings. Installed software lives in retained
Docker container layers, while personal and shared files live in the state
directory. Back up both to retain a complete team environment. Rebuilding the
base template with `pnpm runtime:build` affects newly created environments.

Agents can run commands without approval prompts. Containers have outbound
network access. Paws keeps its database and provider authentication outside
container mounts. Host agents can access whatever the host account permits.
Use provider executables you trust. Secrets entered through private inputs are delivered as temporary
files for the agent to use; they are not saved in chat.

The primary API is intended for local use. For companion access, expose only the
authenticated HTTPS gateway described above. Its token grants full access to
your Paws instance; use a private network and share it only with trusted devices.

## Still in progress

File browsing, the interactive terminal, skills configuration, browser control,
and approval workflows are not connected yet. Some workspace panels are UI
placeholders. Desktop signing, automatic updates, and Android device verification
are still in progress.

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
