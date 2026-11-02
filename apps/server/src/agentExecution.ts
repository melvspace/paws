import type { RunChatTurn } from "@paws/provider-core";

// A failed or cancelled turn must not poison later work for this agent.
export function serializeAgentExecution(run: RunChatTurn): RunChatTurn {
  const tails = new Map<string, Promise<void>>();

  return async (turn) => {
    const previous = tails.get(turn.agentId) ?? Promise.resolve();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    tails.set(turn.agentId, tail);

    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(turn.signal.reason);
        turn.signal.addEventListener("abort", abort, { once: true });
        previous.then(() => {
          turn.signal.removeEventListener("abort", abort);
          resolve();
        });

        if (turn.signal.aborted) abort();
      });
      turn.signal.throwIfAborted();
      turn.onExecutionStart?.();
      await run(turn);
    } finally {
      release();

      void tail.then(() => {
        if (tails.get(turn.agentId) === tail) tails.delete(turn.agentId);
      });
    }
  };
}
