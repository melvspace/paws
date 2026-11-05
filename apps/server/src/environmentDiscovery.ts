import { createSocket } from "node:dgram";
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { Schema } from "effect";
import {
  EnvironmentIdentity,
  type DiscoveredEnvironment,
} from "@paws/contracts";

const group = "239.255.43.10";
const discoveryPort = 4313;
const Advertisement = Schema.Struct({
  protocol: Schema.Literal("paws-environment-v1"),
  identity: EnvironmentIdentity,
  port: Schema.Number,
});
const TailscaleStatus = Schema.Struct({
  BackendState: Schema.String,
  Peer: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        Online: Schema.optional(Schema.Boolean),
        TailscaleIPs: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
});

export function tailscaleAddresses(input: unknown) {
  const status = Schema.decodeUnknownSync(TailscaleStatus)(input);

  if (status.BackendState !== "Running")
    throw new Error("Tailscale is not connected.");

  return [
    ...new Set(
      Object.values(status.Peer ?? {})
        .filter((peer) => peer.Online)
        .flatMap((peer) => peer.TailscaleIPs ?? [])
        .filter((address) => isIP(address)),
    ),
  ];
}

export function localEnvironmentAddresses(port: number) {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => !address.internal && address.family === "IPv4")
    .map((address) => `http://${address.address}:${port}`);
}

export function makeEnvironmentDiscovery(
  identity: () => EnvironmentIdentity,
  advertisedPort: () => number | undefined,
  readTailscale = async () =>
    JSON.parse(
      (
        await promisify(execFile)("tailscale", ["status", "--json"], {
          timeout: 3000,
          maxBuffer: 2 * 1024 * 1024,
        })
      ).stdout,
    ),
) {
  let socket: ReturnType<typeof createSocket> | undefined;
  let error: string | null = null;
  let nextTailscaleIndex = 0;
  const peers = new Map<
    string,
    { value: DiscoveredEnvironment; seen: number }
  >();

  const advertise = (port: number, address: string) => {
    const sharedPort = advertisedPort();

    if (!socket || !sharedPort) return;

    const data = Buffer.from(
      JSON.stringify({
        protocol: "paws-environment-v1",
        identity: identity(),
        port: sharedPort,
      }),
    );
    socket.send(data, port, address, () => {});
  };

  const start = () => {
    if (socket) return;

    socket = createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", () => {
      error = "LAN discovery is unavailable. You can still enter an address.";
    });
    socket.on("message", (message, sender) => {
      if (message.length > 2048) return;

      if (message.toString() === "paws-environment-query-v1") {
        advertise(sender.port, sender.address);

        return;
      }

      try {
        const data = Schema.decodeUnknownSync(Advertisement)(
          JSON.parse(message.toString()),
        );

        if (
          data.identity.id === identity().id ||
          !Number.isInteger(data.port) ||
          data.port < 1 ||
          data.port > 65535
        )
          return;
        if (peers.size >= 256 && !peers.has(data.identity.id)) return;

        peers.set(data.identity.id, {
          value: {
            ...data.identity,
            url: `http://${sender.address}:${data.port}`,
            source: "lan",
          },
          seen: Date.now(),
        });
      } catch {
        /* Ignore unrelated or malformed datagrams. */
      }
    });
    socket.bind(discoveryPort, "0.0.0.0", () => {
      try {
        // Join each interface so discovery also works on multi-homed machines.
        let joined = false;

        for (const url of localEnvironmentAddresses(1)) {
          try {
            socket?.addMembership(group, new URL(url).hostname);
            joined = true;
          } catch {
            /* An interface may disappear during enumeration. */
          }
        }

        if (!joined)
          error =
            "LAN multicast is unavailable. You can still enter an address.";

        socket?.setMulticastTTL(1);
        socket?.setMulticastLoopback(false);
      } catch {
        error = "LAN multicast is unavailable. You can still enter an address.";
      }
    });
  };

  const discover = async () => {
    const warnings: string[] = [];

    if (error) warnings.push(error);

    const lan = socket;

    if (lan) {
      for (const url of localEnvironmentAddresses(1)) {
        try {
          lan.setMulticastInterface(new URL(url).hostname);
          await new Promise<void>((resolve, reject) => {
            lan.send(
              "paws-environment-query-v1",
              discoveryPort,
              group,
              (failure) => (failure ? reject(failure) : resolve()),
            );
          });
        } catch {
          if (!warnings.includes("LAN discovery is unavailable."))
            warnings.push("LAN discovery is unavailable.");
        }
      }
    }

    const tailnet: DiscoveredEnvironment[] = [];
    const tailscale = (async () => {
      try {
        const addresses = tailscaleAddresses(await readTailscale());
        // Bound concurrency and time; never sweep the surrounding IP ranges.
        const startIndex = nextTailscaleIndex;
        let scanned = 0;
        const deadline = Date.now() + 4000;
        await Promise.all(
          Array.from({ length: Math.min(8, addresses.length) }, async () => {
            while (scanned < addresses.length && Date.now() < deadline) {
              const index = (startIndex + scanned++) % addresses.length;
              const address = addresses[index]!;
              nextTailscaleIndex = (index + 1) % addresses.length;
              const url = `http://${isIP(address) === 6 ? `[${address}]` : address}:4312`;

              try {
                const response = await fetch(`${url}/identity`, {
                  signal: AbortSignal.timeout(700),
                  redirect: "error",
                });

                if (!response.ok) continue;

                const peer = Schema.decodeUnknownSync(EnvironmentIdentity)(
                  await response.json(),
                );

                if (peer.id !== identity().id)
                  tailnet.push({ ...peer, url, source: "tailscale" });
              } catch {
                /* Online Tailscale peers need not run Paws. */
              }
            }
          }),
        );

        if (scanned < addresses.length)
          warnings.push(
            "Tailscale discovery is incomplete. Discover again to scan the remaining peers.",
          );
      } catch {
        warnings.push(
          "Tailscale discovery is unavailable. Install Tailscale and connect, or enter an address.",
        );
      }
    })();
    await Promise.all([
      tailscale,
      new Promise((resolve) => setTimeout(resolve, 800)),
    ]);
    const results = new Map<string, DiscoveredEnvironment>();

    for (const [id, peer] of peers) {
      if (Date.now() - peer.seen > 30_000) peers.delete(id);
      else results.set(id, peer.value);
    }

    for (const peer of tailnet) results.set(peer.id, peer);

    return { environments: [...results.values()], warnings };
  };

  return {
    start,
    discover,
    error: () => error,
    close: () => {
      try {
        socket?.close();
      } catch {
        /* A failed bind has no open socket. */
      }

      socket = undefined;
    },
  };
}
