import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import * as Device from "expo-device";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Schema } from "effect";
import {
  EnvironmentIdentity,
  type DiscoveredEnvironment,
  type PairingOffer,
  type PairingTicket,
} from "@paws/contracts";
import {
  cancelEnvironmentPairing,
  claimEnvironmentPairing,
  pairEnvironment,
  parsePairingQr,
  requestEnvironmentPairing,
  resolvePairingOffer,
} from "@paws/client-runtime/pairing";
import { cancelDiscovery, discoverComputers } from "./discovery.ts";
import { errorText, type Workspace } from "./useWorkspace.ts";

async function deviceIdentity() {
  const saved = await SecureStore.getItemAsync("paws.device");

  if (saved)
    return Schema.decodeUnknownSync(EnvironmentIdentity)(JSON.parse(saved));

  const identity = {
    id: Crypto.randomUUID(),
    name: (Device.deviceName ?? Device.modelName ?? "Android phone").slice(
      0,
      80,
    ),
    platform: "android",
  };
  await SecureStore.setItemAsync("paws.device", JSON.stringify(identity));

  return identity;
}

export function usePairing(workspace: Workspace) {
  const [peers, setPeers] = useState<readonly DiscoveredEnvironment[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [pending, setPending] = useState<{
    peer: DiscoveredEnvironment;
    ticket: PairingTicket;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const operation = useRef<AbortController | null>(null);
  const searchGeneration = useRef(0);
  const locked = useRef(false);
  const connect = workspace.connect;
  const connectRef = useRef(connect);
  connectRef.current = connect;

  const scan = useCallback(async () => {
    const generation = ++searchGeneration.current;
    cancelDiscovery();
    setSearching(true);
    setError(null);

    try {
      const found = await discoverComputers();

      if (searchGeneration.current === generation) setPeers(found);
    } catch (cause) {
      if (searchGeneration.current === generation) setError(errorText(cause));
    } finally {
      if (searchGeneration.current === generation) {
        setSearching(false);
        setSearched(true);
      }
    }
  }, []);

  const readQr = useCallback((value: string) => {
    try {
      const next = parsePairingQr(value);
      operation.current?.abort();
      operation.current = null;
      locked.current = false;
      setBusy(false);
      setPending(null);
      setOffer(next);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const receive = (url: string | null | undefined) => {
      if (active && url?.startsWith("paws://pair")) readQr(url);
    };
    void Linking.getInitialURL()
      .then(receive)
      .catch(() => {});
    const links = Linking.addEventListener("url", ({ url }) => receive(url));
    const app = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );

    return () => {
      active = false;
      links.remove();
      app.remove();
      operation.current?.abort();
      searchGeneration.current++;
      cancelDiscovery();
    };
  }, [readQr]);

  useEffect(() => {
    if (!foreground) {
      searchGeneration.current++;
      cancelDiscovery();
      setSearching(false);

      return;
    }

    void scan();
  }, [foreground, scan]);

  useEffect(() => {
    if (!pending || !foreground) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function check() {
      if (!pending || controller.signal.aborted) return;

      try {
        if (Date.parse(pending.ticket.expiresAt) <= Date.now())
          throw new Error(
            "Pairing request expired. Tap the computer to try again.",
          );

        const result = await claimEnvironmentPairing(
          pending.peer,
          pending.ticket,
          controller.signal,
        );

        if (controller.signal.aborted) return;

        if (result.status === "denied")
          throw new Error(
            "Connection declined on the computer. You can try again.",
          );

        if (result.status === "approved") {
          await connectRef.current(
            {
              origin: pending.peer.url,
              session: result.token,
              kind: "environment",
              identity: result.identity,
            },
            controller.signal,
          );

          return;
        }

        timer = setTimeout(() => void check(), 1000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(errorText(cause));
          setPending(null);
        }
      }
    }

    void check();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pending, foreground]);

  useEffect(() => {
    if (!pending) return;

    return () => {
      void cancelEnvironmentPairing(pending.peer, pending.ticket).catch(
        () => {},
      );
    };
  }, [pending]);

  async function request(peer: DiscoveredEnvironment) {
    if (locked.current) return;

    locked.current = true;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);

    try {
      const identity = await deviceIdentity();
      controller.signal.throwIfAborted();
      const ticket = await requestEnvironmentPairing(
        peer,
        identity,
        controller.signal,
      );

      if (!controller.signal.aborted) setPending({ peer, ticket });
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorText(cause));
    } finally {
      if (operation.current === controller) {
        locked.current = false;

        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  async function confirmQr() {
    if (!offer || locked.current) return;

    locked.current = true;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);

    try {
      const address = await resolvePairingOffer(offer, controller.signal);
      const identity = await deviceIdentity();
      const connection = await pairEnvironment(
        address,
        offer,
        identity,
        controller.signal,
      );
      await connectRef.current(connection, controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorText(cause));
    } finally {
      if (operation.current === controller) {
        locked.current = false;

        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  return {
    peers,
    searching,
    searched,
    scan,
    readQr,
    offer,
    pending,
    busy,
    error,
    foreground,
    request,
    confirmQr,
    clearOffer: () => setOffer(null),
    cancel: () => setPending(null),
  };
}
