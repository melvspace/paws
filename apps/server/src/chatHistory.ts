import type { ProviderDriver } from "@paws/contracts";
import type { RecoverChatHistory } from "@paws/provider-core";
import { recoverCodexHistory } from "@paws/provider-codex";

const adapters: Partial<Record<ProviderDriver, RecoverChatHistory>> = {
  codex: recoverCodexHistory,
};

export async function* recoverProviderHistory(
  driver: ProviderDriver,
  home: string,
  nativeThreadId: string,
) {
  const recover = adapters[driver];

  if (recover) yield* recover(home, nativeThreadId);
}
