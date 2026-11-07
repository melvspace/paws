import { DevicePairing } from "./DevicePairing.tsx";
import { AddEnvironmentDialog } from "./AddEnvironmentDialog.tsx";
import { RenameEnvironmentDialog } from "./RenameEnvironmentDialog.tsx";
import { EnvironmentRow } from "./EnvironmentRow.tsx";
import { useEffect, useRef, useState } from "react";
import type { DiscoveredEnvironment, EnvironmentState } from "@paws/contracts";
import { useAtomValue } from "@effect/atom-react";
import { MoreHorizontalIcon, PlusIcon, RadarIcon } from "lucide-react";
import {
  configureEnvironment,
  createEnvironmentPairing,
  discoverEnvironments,
  loadEnvironments,
  removeEnvironment,
  activeEnvironmentId,
  agentsAtom,
  environmentRostersAtom,
  setEnvironmentEnabled,
} from "@paws/client-runtime";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../components/ui/menu.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { environmentDestination } from "../environmentNavigation.ts";
import "./environments.css";

export function EnvironmentSettings({
  page = "Environments",
  onSharing,
}: {
  page?: "Environments" | "Sharing & access";
  onSharing?: () => void;
}) {
  const { rosters } = useAtomValue(environmentRostersAtom);
  const active = useAtomValue(agentsAtom);
  const [adding, setAdding] = useState(false);
  const [addTarget, setAddTarget] = useState<DiscoveredEnvironment | null>(
    null,
  );
  const [peers, setPeers] = useState<readonly DiscoveredEnvironment[] | null>(
    null,
  );
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const addReturnFocus = useRef<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const [state, setState] = useState<EnvironmentState | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const localActionsRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState("");
  const [pairing, setPairing] = useState<{
    code: string;
    expiresAt: string;
  } | null>(null);

  function accept(next: EnvironmentState) {
    setState(next);
    window.dispatchEvent(new Event("paws-environments-changed"));
  }

  function failed(cause: unknown) {
    setError(
      cause instanceof Error
        ? cause.message
        : "Could not update environments. Retry.",
    );
  }

  useEffect(() => {
    let disposed = false;
    void loadEnvironments()
      .then((next) => {
        if (disposed) return;

        setState(next);
      })
      .catch((cause: unknown) => {
        if (!disposed) failed(cause);
      });

    return () => {
      disposed = true;
    };
  }, []);

  async function perform(
    action: () => Promise<void>,
    label = "Updating connections…",
  ) {
    try {
      setError("");
      setBusy(true);
      setOperation(label);
      await action();
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
      setOperation("");
    }
  }

  const availablePeers = peers?.filter(
    (peer) => !state?.linked.some((linked) => linked.id === peer.id),
  );

  if (!state)
    return (
      <p role={error ? "alert" : "status"}>
        {error || "Loading environments…"}
      </p>
    );

  function connectionStatus(id: string | null) {
    const roster = rosters.find((item) => item.id === id);
    const connection = id === activeEnvironmentId() ? active : roster;

    return connection?.connected
      ? "Connected"
      : connection?.error
        ? "Offline"
        : "Connecting…";
  }

  return (
    <section className="environment-settings" aria-label={page}>
      <div className="environment-page-heading">
        <h2>{page}</h2>
        {page === "Environments" && (
          <div className="environment-page-actions">
            <Button
              variant="ghost"
              aria-label="Discover"
              disabled={busy}
              onClick={() => {
                void perform(async () => {
                  const result = await discoverEnvironments();
                  setPeers(result.environments);
                  setWarnings(result.warnings);
                }, "Discovering computers…");
              }}
            >
              <RadarIcon size={16} strokeWidth={1.5} aria-hidden />
              Discover
            </Button>
            <Button
              ref={addButtonRef}
              variant="ghost"
              disabled={busy}
              onClick={() => {
                addReturnFocus.current = addButtonRef.current;
                setAddTarget(null);
                setAdding(true);
              }}
            >
              <PlusIcon size={16} strokeWidth={1.5} aria-hidden />
              Add environment
            </Button>
          </div>
        )}
      </div>
      {page === "Environments" ? (
        <>
          <ul className="environment-machines" aria-label="Environments">
            <li>
              <EnvironmentRow
                label={state.local.name}
                subtitle={<>This computer · {connectionStatus(null)}</>}
              >
                <Menu>
                  <Button
                    variant="ghost"
                    ref={localActionsRef}
                    className="environment-more"
                    aria-label={`More options for ${state.local.name}`}
                    disabled={busy}
                    render={<MenuTrigger />}
                  >
                    <MoreHorizontalIcon
                      size={16}
                      strokeWidth={1.5}
                      aria-hidden
                    />
                  </Button>
                  <MenuPopup side="bottom">
                    <MenuItem onClick={() => setRenaming(true)}>
                      Rename
                    </MenuItem>
                    {onSharing && (
                      <MenuItem onClick={onSharing}>
                        Sharing &amp; access
                      </MenuItem>
                    )}
                  </MenuPopup>
                </Menu>
              </EnvironmentRow>
            </li>
            {state.linked.map((peer) => (
              <li key={peer.id}>
                <EnvironmentRow
                  kind={
                    /macbook|laptop|notebook/i.test(peer.name)
                      ? "laptop"
                      : "desktop"
                  }
                  label={peer.name}
                  subtitle={
                    <>
                      Remote ·{" "}
                      {peer.enabled === false
                        ? "Disabled"
                        : connectionStatus(peer.id)}
                    </>
                  }
                  dimmed={peer.enabled === false}
                  detail={
                    details === peer.id ? (
                      <div className="environment-connection-details">
                        <span>Address</span>
                        <code>{peer.url}</code>
                      </div>
                    ) : undefined
                  }
                >
                  <Switch
                    aria-label={`Enable ${peer.name}`}
                    checked={peer.enabled !== false}
                    disabled={busy}
                    onCheckedChange={(enabled) => {
                      void perform(async () => {
                        accept(await setEnvironmentEnabled(peer.id, enabled));

                        if (!enabled && activeEnvironmentId() === peer.id)
                          window.location.assign(environmentDestination(null));
                      });
                    }}
                  />
                  <Menu>
                    <Button
                      variant="ghost"
                      className="environment-more"
                      aria-label={`More options for ${peer.name}`}
                      disabled={busy}
                      render={<MenuTrigger />}
                    >
                      <MoreHorizontalIcon
                        size={16}
                        strokeWidth={1.5}
                        aria-hidden
                      />
                    </Button>
                    <MenuPopup side="bottom">
                      <MenuItem
                        onClick={() =>
                          setDetails((current) =>
                            current === peer.id ? null : peer.id,
                          )
                        }
                      >
                        Connection details
                      </MenuItem>
                      <MenuItem
                        variant="destructive"
                        aria-label={`Forget ${peer.name}`}
                        onClick={() => {
                          void perform(async () => {
                            accept(await removeEnvironment("links", peer.id));

                            if (activeEnvironmentId() === peer.id)
                              window.location.assign(
                                environmentDestination(null),
                              );
                          });
                        }}
                      >
                        Forget
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </EnvironmentRow>
              </li>
            ))}
          </ul>
          {peers !== null && (
            <section aria-label="Nearby environments">
              <h3>Nearby environments</h3>
              {availablePeers?.length === 0 && (
                <p className="environment-feedback">
                  No other environments found. Enable sharing on the other
                  computer or enter its address.
                </p>
              )}
              {!!availablePeers?.length && (
                <ul className="environment-machines">
                  {availablePeers.map((peer) => (
                    <li key={peer.id}>
                      <EnvironmentRow
                        label={peer.name}
                        subtitle={
                          <>
                            {peer.source === "lan" ? "LAN" : "Tailscale"} ·{" "}
                            {peer.url}
                          </>
                        }
                      >
                        <Button
                          variant="ghost"
                          aria-label={`Pair with ${peer.name}`}
                          disabled={busy}
                          onClick={(event) => {
                            addReturnFocus.current = event.currentTarget;
                            setAddTarget(peer);
                            setAdding(true);
                          }}
                        >
                          Pair
                        </Button>
                      </EnvironmentRow>
                    </li>
                  ))}
                </ul>
              )}
              {[
                ...(state.discoveryError ? [state.discoveryError] : []),
                ...warnings,
              ].map((warning) => (
                <p key={warning} className="environment-feedback" role="status">
                  {warning}
                </p>
              ))}
            </section>
          )}
        </>
      ) : (
        <>
          <div className="environment-rows">
            <div className="environment-row">
              <label htmlFor="environment-sharing">
                Share on LAN and Tailscale
              </label>
              <Switch
                id="environment-sharing"
                checked={state.sharing}
                disabled={busy}
                onCheckedChange={(sharing) => {
                  void perform(async () => {
                    accept(await configureEnvironment({ sharing }));
                    setPairing(null);
                  });
                }}
              />
            </div>
            {state.sharing && (
              <>
                <div className="environment-row environment-addresses">
                  <span>Addresses</span>
                  <ul
                    className="environment-address-list"
                    aria-label="Environment addresses"
                    tabIndex={0}
                  >
                    {state.addresses.map((address) => (
                      <li key={address}>
                        <code>{address}</code>
                      </li>
                    ))}
                    {state.addresses.length === 0 && (
                      <li>No network addresses available</li>
                    )}
                  </ul>
                </div>
                <div className="environment-row environment-pairing">
                  <span>Pairing code</span>
                  <div className="environment-pairing-controls">
                    {pairing && (
                      <>
                        <Input
                          aria-label="Pairing code for this computer"
                          readOnly
                          value={pairing.code}
                        />
                        <small>
                          Single use · expires{" "}
                          {new Date(pairing.expiresAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </small>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      aria-label="Create pairing code"
                      disabled={busy}
                      onClick={() => {
                        void perform(
                          async () =>
                            setPairing(await createEnvironmentPairing()),
                          "Creating pairing code…",
                        );
                      }}
                    >
                      {pairing ? "New QR code" : "Show pairing QR"}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
          {state.sharing && (
            <DevicePairing
              state={state}
              pairing={pairing}
              onChange={setState}
            />
          )}
          {!!state.connections.length && (
            <>
              <h3>Allowed devices</h3>
              <div className="environment-rows">
                {state.connections.map((peer) => (
                  <div className="environment-row" key={peer.id}>
                    <span>
                      {peer.name}
                      <small>Access granted</small>
                    </span>
                    <Button
                      variant="ghost"
                      aria-label={`Revoke ${peer.name}`}
                      disabled={busy}
                      onClick={() => {
                        void perform(async () =>
                          accept(
                            await removeEnvironment("connections", peer.id),
                          ),
                        );
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {renaming && (
        <RenameEnvironmentDialog
          name={state.local.name}
          onChanged={accept}
          onDismiss={() => setRenaming(false)}
          finalFocus={localActionsRef}
        />
      )}
      {adding && (
        <AddEnvironmentDialog
          environment={addTarget}
          onLinked={accept}
          onDismiss={() => setAdding(false)}
          finalFocus={() =>
            addReturnFocus.current?.isConnected
              ? addReturnFocus.current
              : addButtonRef.current
          }
        />
      )}
      {busy && (
        <p className="environment-feedback" role="status">
          {operation}
        </p>
      )}
      {error && (
        <p className="environment-feedback" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
