import { requireNativeModule } from "expo";
import { Schema } from "effect";
import { DiscoveredEnvironment } from "@paws/contracts";
import { environmentOrigin } from "@paws/client-runtime/pairing";

const native = requireNativeModule<{
  discover(): Promise<unknown>;
  cancel(): void;
}>("PawsDiscovery");

export async function discoverComputers() {
  const values = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
    await native.discover(),
  );
  const peers: DiscoveredEnvironment[] = [];

  for (const value of values) {
    try {
      const peer = Schema.decodeUnknownSync(DiscoveredEnvironment)(value);
      environmentOrigin(peer.url);
      peers.push(peer);
    } catch {
      // Ignore malformed advertisements without hiding valid computers.
    }
  }

  return peers;
}

export const cancelDiscovery = () => native.cancel();
