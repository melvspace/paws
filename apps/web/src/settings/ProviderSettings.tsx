import { Form } from "@base-ui/react/form";
import {
  parseLaunchArguments,
  formatLaunchArguments,
} from "./launchArguments.ts";
import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Switch } from "@base-ui/react/switch";
import {
  ExternalLinkIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import type {
  ProviderConfig,
  ProviderSnapshot,
  UpdateProvider,
} from "@paws/contracts";
import { providerDriver, providerDrivers } from "@paws/provider-core";
import {
  changeProvider,
  loadProviders,
  providersAtom,
} from "@paws/client-runtime";
import { appAtomRegistry } from "../lib/atomRegistry.ts";
import { ProviderIcon } from "../providers/ProviderIcon.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Menu, MenuTrigger, MenuPopup } from "../components/ui/menu.tsx";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { ProviderModels } from "./ProviderModels.tsx";
import { SensitiveText } from "../components/ui/sensitive-text.tsx";
import {
  providerEmail,
  providerStatus,
  relativeChecked,
} from "./providerPresentation.ts";
import "./providers.css";

function ProviderCard({ provider }: { provider: ProviderSnapshot }) {
  const { config } = provider;
  const driver = providerDriver(config.driver);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);

    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not update provider.",
      );
    } finally {
      setBusy(false);
    }
  }

  const path = `/${encodeURIComponent(config.id)}`;
  const save = (patch: Partial<UpdateProvider>) =>
    perform(() =>
      changeProvider(appAtomRegistry, path, "PATCH", { ...config, ...patch }),
    );
  const checking = busy || provider.status === "checking";
  const email = providerEmail(provider);

  return (
    <div className="provider-panel">
      <header className="provider-panel-header">
        <h3>
          <ProviderIcon driver={config.driver} />
          {config.name}
        </h3>
        <span>{provider.version ? `v${provider.version}` : ""}</span>
      </header>
      <section className="provider-status-section">
        <h4>Status</h4>
        <p>
          {email ? (
            <>
              Authenticated as{" "}
              <SensitiveText
                key={`${config.id}:${email}`}
                value={email}
                label="email"
              />
              {provider.account?.label && (
                <>
                  <br />· {provider.account.label}
                </>
              )}
            </>
          ) : (
            providerStatus(provider)
          )}
        </p>
        {provider.message && <p role="status">{provider.message}</p>}
        {config.enabled &&
          provider.auth !== "authenticated" &&
          provider.status !== "missing" &&
          ["codex", "cursor"].includes(config.driver) && (
            <div className="provider-signin">
              {provider.signIn?.phase === "waiting" && provider.signIn.url ? (
                <>
                  <Button
                    variant="outline"
                    render={
                      <a
                        href={provider.signIn.url}
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    <ExternalLinkIcon size={14} />
                    Continue sign-in
                  </Button>
                  {provider.signIn.code && <code>{provider.signIn.code}</code>}
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void perform(() =>
                        changeProvider(
                          appAtomRegistry,
                          `${path}/cancel-signin`,
                          "POST",
                        ),
                      )
                    }
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  disabled={
                    checking ||
                    !config.enabled ||
                    provider.signIn?.phase === "starting"
                  }
                  onClick={() =>
                    void perform(() =>
                      changeProvider(appAtomRegistry, `${path}/signin`, "POST"),
                    )
                  }
                >
                  {provider.signIn?.phase === "starting"
                    ? "Starting sign-in…"
                    : "Sign in"}
                </Button>
              )}
              {provider.signIn?.phase === "error" && (
                <p role="alert">Sign-in failed or expired. Try again.</p>
              )}
            </div>
          )}
      </section>
      <div className="provider-details">
        <div className="provider-setting-row">
          <label htmlFor={`provider-name-${config.id}`}>Display name</label>
          <Input
            key={config.name}
            id={`provider-name-${config.id}`}
            defaultValue={config.name}
            maxLength={80}
            readOnly={busy}
            onBlur={(event) => {
              const name = event.target.value.trim();

              if (name !== config.name) void save({ name });
            }}
          />
        </div>
        {config.driver !== "cursor" && (
          <ProviderExecutable
            key={`${config.binaryPath}:${config.homePath ?? ""}:${JSON.stringify(config.args)}`}
            config={config}
            busy={busy}
            onSave={save}
          />
        )}
        {(provider.status === "missing" || provider.status === "needs-auth") &&
          !["codex", "cursor"].includes(config.driver) && (
            <div className="provider-setting-row">
              <span>Setup</span>
              <Button
                variant="outline"
                render={
                  <a href={driver.setupUrl} target="_blank" rel="noreferrer" />
                }
              >
                <ExternalLinkIcon size={14} />
                Setup guide
              </Button>
            </div>
          )}
        {provider.status === "missing" && config.driver === "codex" && (
          <div className="provider-setting-row">
            <span>Install Codex</span>
            <Button
              variant="outline"
              render={
                <a href={driver.setupUrl} target="_blank" rel="noreferrer" />
              }
            >
              <ExternalLinkIcon size={14} />
              Setup guide
            </Button>
          </div>
        )}
        {config.driver === "acpRegistry" && (
          <p className="provider-note">
            Use the executable and arguments from your installed ACP agent.
          </p>
        )}
        {config.driver === "antigravity" && (
          <p className="provider-note">
            Use the official Antigravity ACP executable and its configured
            authentication environment.
          </p>
        )}
        <EnvironmentEditor provider={provider} busy={busy} perform={perform} />
        <ProviderModels provider={provider} />
      </div>
      {error && (
        <p className="provider-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ProviderExecutable({
  config,
  busy,
  onSave,
}: {
  config: ProviderConfig;
  busy: boolean;
  onSave: (patch: Partial<UpdateProvider>) => Promise<void>;
}) {
  const [args, setArgs] = useState(formatLaunchArguments(config.args));
  const [error, setError] = useState(false);

  return (
    <>
      <h4 className="provider-section-title">Runtime</h4>
      <div className="provider-setting-row">
        <div className="provider-setting-copy">
          <label htmlFor={`provider-path-${config.id}`}>Binary path</label>
          <p>
            Path to the {providerDriver(config.driver).name} binary used by this
            instance.
          </p>
        </div>
        <Input
          id={`provider-path-${config.id}`}
          defaultValue={config.binaryPath}
          placeholder={
            providerDriver(config.driver).command || "/path/to/agent"
          }
          readOnly={busy}
          onBlur={(event) => {
            if (event.target.value.trim() !== config.binaryPath)
              void onSave({ binaryPath: event.target.value });
          }}
        />
      </div>
      {["codex", "claudeAgent", "pi"].includes(config.driver) && (
        <div className="provider-setting-row">
          <div className="provider-setting-copy">
            <label htmlFor={`provider-home-${config.id}`}>
              {config.driver === "codex"
                ? "CODEX_HOME path"
                : "Config directory"}
            </label>
            <p>
              {config.driver === "codex"
                ? "Custom Codex home and config directory."
                : "Custom home and config directory for this instance."}
            </p>
          </div>
          <Input
            id={`provider-home-${config.id}`}
            defaultValue={config.homePath ?? ""}
            placeholder={config.driver === "codex" ? "~/.codex" : "Default"}
            readOnly={busy}
            onBlur={(event) => {
              if (event.target.value.trim() !== (config.homePath ?? ""))
                void onSave({ homePath: event.target.value.trim() });
            }}
          />
        </div>
      )}
      <div className="provider-setting-row">
        <label htmlFor={`provider-args-${config.id}`}>Launch arguments</label>
        <Input
          id={`provider-args-${config.id}`}
          value={args}
          readOnly={busy}
          aria-invalid={error}
          placeholder="--flag value"
          onChange={(event) => setArgs(event.target.value)}
          onBlur={() => {
            try {
              const parsed = parseLaunchArguments(args);

              setError(false);

              if (JSON.stringify(parsed) !== JSON.stringify(config.args))
                void onSave({ args: parsed });
            } catch {
              setError(true);
            }
          }}
        />
      </div>
      {error && (
        <p className="provider-error" role="alert">
          Close the quoted argument before saving.
        </p>
      )}
    </>
  );
}

function EnvironmentEditor({
  provider,
  busy,
  perform,
}: {
  provider: ProviderSnapshot;
  busy: boolean;
  perform: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const path = `/${encodeURIComponent(provider.config.id)}/environment`;

  return (
    <section className="provider-environment">
      <h4 className="provider-section-title">Environment</h4>
      <div className="provider-setting-row">
        <div className="provider-setting-copy">
          <span>Variables</span>
          <p>API keys, base URLs, and other per-instance CLI settings.</p>
        </div>
        <Button variant="outline" onClick={() => setEditing(!editing)}>
          <PlusIcon size={14} />
          Add variable
        </Button>
      </div>
      {(provider.environment ?? []).map((name) => (
        <div className="provider-setting-row" key={name}>
          <code>{name}</code>
          <span className="provider-env-set">Configured</span>
          <Button
            className="sidebar-icon-button"
            aria-label={`Remove ${name}`}
            disabled={busy}
            onClick={() =>
              void perform(() =>
                changeProvider(appAtomRegistry, path, "PATCH", {
                  name,
                  value: null,
                }),
              )
            }
          >
            <Trash2Icon size={14} />
          </Button>
        </div>
      ))}
      {editing && (
        <Form
          className="provider-env-form"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              await changeProvider(appAtomRegistry, path, "PATCH", {
                name,
                value,
              });
              setName("");
              setValue("");
              setEditing(false);
            });
          }}
        >
          <Input
            aria-label="Variable name"
            placeholder="API_KEY"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            maxLength={128}
          />
          <Input
            aria-label="Variable value"
            type="password"
            autoComplete="new-password"
            placeholder="Value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
          />
          <Button
            type="submit"
            variant="outline"
            disabled={busy || !name || !value}
          >
            Add
          </Button>
        </Form>
      )}
    </section>
  );
}

export function ProviderSettings() {
  const { providers, error } = useAtomValue(providersAtom);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const checkedAt = providers.reduce<string | null>(
    (latest, provider) =>
      provider.checkedAt && (!latest || provider.checkedAt > latest)
        ? provider.checkedAt
        : latest,
    null,
  );
  const refreshing =
    busy || providers.some((provider) => provider.status === "checking");
  const selected =
    providers.find((provider) => provider.config.id === selectedId) ??
    providers[0];

  useEffect(() => {
    void loadProviders(appAtomRegistry);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);

    return () => window.clearInterval(timer);
  }, []);

  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);

    try {
      await action();
    } catch {
      setActionError("Could not update providers. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const addMenu = (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="icon" />}
        disabled={busy}
        aria-label="Add provider"
      >
        <PlusIcon size={18} />
      </MenuTrigger>
      <MenuPopup aria-label="Add provider">
        {providerDrivers.map((driver) => (
          <BaseMenu.Item
            key={driver.id}
            className="ui-menu-radio-item"
            onClick={() =>
              void perform(async () => {
                const provider = await changeProvider(
                  appAtomRegistry,
                  "",
                  "POST",
                  { driver: driver.id },
                );

                if (provider) {
                  setSelectedId(provider.config.id);
                  await changeProvider(
                    appAtomRegistry,
                    `/${encodeURIComponent(provider.config.id)}/refresh`,
                    "POST",
                  );
                }
              })
            }
          >
            <ProviderIcon driver={driver.id} />
            {driver.name}
          </BaseMenu.Item>
        ))}
      </MenuPopup>
    </Menu>
  );

  return (
    <section className="providers-settings" aria-label="Providers">
      <div className="providers-page-heading">
        <div>
          <h3>Providers</h3>
          {addMenu}
        </div>
        <Button
          variant="ghost"
          className="provider-refresh"
          aria-label="Refresh provider status"
          title={
            checkedAt
              ? `Last checked ${new Date(checkedAt).toLocaleString()}`
              : "Refresh provider status"
          }
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={() =>
            void perform(async () => {
              await Promise.all(
                providers
                  .filter((provider) => provider.config.enabled)
                  .map((provider) =>
                    changeProvider(
                      appAtomRegistry,
                      `/${encodeURIComponent(provider.config.id)}/refresh`,
                      "POST",
                    ),
                  ),
              );
            })
          }
        >
          <RefreshCwIcon size={14} />
          {refreshing
            ? "Refreshing providers"
            : relativeChecked(checkedAt, now)}
        </Button>
      </div>
      {(error || actionError) && (
        <p role="alert" className="provider-error">
          {error || actionError}
          <Button
            variant="ghost"
            onClick={() => void loadProviders(appAtomRegistry)}
          >
            Retry
          </Button>
        </p>
      )}
      <div className="providers-layout">
        <nav className="providers-list" aria-label="Configured providers">
          {providers.map((provider) => (
            <div
              className="provider-list-row"
              key={provider.config.id}
              data-selected={provider.config.id === selected?.config.id}
            >
              <Button
                className="provider-list-select"
                aria-current={
                  provider.config.id === selected?.config.id
                    ? "true"
                    : undefined
                }
                onClick={() => setSelectedId(provider.config.id)}
              >
                <ProviderIcon driver={provider.config.driver} />
                <span>
                  <span className="provider-list-title">
                    <strong>{provider.config.name}</strong>
                    {provider.version && <code>v{provider.version}</code>}
                  </span>
                  <small>{providerStatus(provider)}</small>
                </span>
              </Button>
              <Switch.Root
                className="provider-switch"
                aria-label={`Enable ${provider.config.name}`}
                checked={provider.config.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  void perform(async () => {
                    const path = `/${encodeURIComponent(provider.config.id)}`;
                    await changeProvider(appAtomRegistry, path, "PATCH", {
                      ...provider.config,
                      enabled,
                    });

                    if (enabled)
                      await changeProvider(
                        appAtomRegistry,
                        `${path}/refresh`,
                        "POST",
                      );
                  })
                }
              >
                <Switch.Thumb className="provider-switch-thumb" />
              </Switch.Root>
            </div>
          ))}
        </nav>
        {selected ? (
          <ProviderCard key={selected.config.id} provider={selected} />
        ) : (
          <p className="provider-note">Add a provider to get started.</p>
        )}
      </div>
    </section>
  );
}
