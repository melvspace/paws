import { ChatExecutionError, type ChatTurn } from "@paws/provider-core";

const communication = new Set([
  "paws_send_message",
  "request_secret",
  "paws_finish_turn",
]);
const hardLimit = 100;
const wrapUpAt = 80;
const reportAt = 90;
const checkpoint = `Paws progress checkpoint: send the user a short update now with what succeeded, what failed, and your next concrete approach. If the user can resolve the blocker, ask for their help. You may continue after the update when you know what to try. Do not repeat failing approaches or expand the task. The hard limit is ${hardLimit} work tool calls; deliver a final status report before reaching it.`;
const finalReport = `Paws final status report required: ${reportAt} of ${hardLimit} work tool calls have been used. Before any more work tools, deliver a final status report using paws_send_message or a completed text reply. State what was completed, share available files or partial results, explain failures and blockers, and say what remains or what help you need. Do not claim unverified success. End the turn after the report unless a final cleanup is essential. Do not begin another approach.`;
const wrapUp = `Paws tool budget warning: the ${hardLimit}-call hard limit is approaching. Wrap up now. Deliver a final status report with completed work, files or partial results, failures, blockers, and remaining work or help needed. A final report is required before further work after call ${reportAt}. End the turn before the hard limit; do not start new approaches.`;

// Count actual harness calls, including calls hidden inside provider batches.
export function guardChatTools(turn: ChatTurn): ChatTurn {
  const abort = new AbortController();
  let total = 0;
  let quiet = 0;
  let failures = 0;
  let blocked = 0;
  let reportDelivered = false;
  const texts = new Map<string, string>();
  const visible = () => {
    quiet = 0;
    failures = 0;
    blocked = 0;
  };

  const stop = (message: string): never => {
    const error = new ChatExecutionError(message);
    abort.abort(error);

    throw error;
  };

  return {
    ...turn,
    signal: AbortSignal.any([turn.signal, abort.signal]),
    onText(id, text, complete) {
      if (text.trim() && texts.get(id) !== text) {
        texts.set(id, text);
        visible();
      }

      turn.onText(id, text, complete);

      if (total >= reportAt && text.trim() && complete) reportDelivered = true;
    },
    async onMessage(id, card, attachments) {
      await turn.onMessage(id, card, attachments);
      visible();

      if (total >= reportAt && card.text.trim()) reportDelivered = true;
    },
    onTool(name, status) {
      turn.signal.throwIfAborted();
      abort.signal.throwIfAborted();

      if (status === "running" && !communication.has(name)) {
        if (total >= hardLimit) {
          stop(
            `Stopped after reaching the ${hardLimit}-call tool limit for this reply. Review the final status report above. Ask for partial results, provide guidance, or narrow the task to continue.`,
          );
        }

        const needsReport = total >= reportAt && !reportDelivered;

        if (needsReport || failures >= 2 || quiet >= 8) {
          blocked++;

          if (blocked >= 3)
            stop(
              "Paused because the agent kept requesting tools without reporting its progress or blocker. Further tool calls were blocked. Ask for partial results or send guidance to continue.",
            );

          return needsReport ? finalReport : checkpoint;
        }

        total++;
        quiet++;
      }

      turn.onTool?.(name, status);

      if (status === "running" || communication.has(name)) return;

      failures = status === "failed" ? failures + 1 : 0;

      if (total >= reportAt && !reportDelivered) return finalReport;
      if (total >= wrapUpAt) return wrapUp;
      if (failures >= 2 || quiet >= 8) return checkpoint;
    },
  };
}
