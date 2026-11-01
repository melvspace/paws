import type {
  ChatCard,
  ChatFileInput,
  ChatInteraction,
  ChatSelection,
  ContextUsage,
} from "@paws/contracts";

export interface ChatInteractionInput {
  interaction: ChatInteraction;
  consumeSecret?(reference: string): string;
}

// "queue" guarantees no input was accepted. Throw on ambiguous delivery failures.
export type ChatFollowUp =
  | ChatInteractionInput
  | { text: string; requestId: string };
export type SteerChat = (input: ChatFollowUp) => Promise<"accepted" | "queue">;

export interface ChatAttachmentFile {
  path: string;
  name: string;
  mediaType: string;
  size?: number | undefined;
}

export interface ChatTurn {
  memoryTool?(input: unknown): Promise<unknown>;
  teamTool?(input: unknown): Promise<unknown>;
  agentId: string;
  agentName: string;
  nativeThreadId: string | null;
  text: string;
  readAttachment?(id: string): Promise<ChatAttachmentFile>;
  viewImage?(path: string): Promise<{ mimeType: string; data: string }>;
  // Historical context from another provider session, never a user-authored message.
  handoff?: string;
  interaction?: ChatInteraction;
  // Server-only, one-use value access. Never serialize into provider context.
  consumeSecret?(reference: string): string;
  // Optional live capability; adapters clear it when their turn can no longer steer.
  onSteer?(steer: SteerChat | null): void;
  operation?: "compact";
  onUsage?(usage: ContextUsage): void;
  // Safe harness metadata only. A checkpoint on "running" denies execution
  // and is returned to the model; completion checkpoints accompany the result.
  onTool?(
    name: string,
    status: "running" | "completed" | "failed",
  ): string | void;
  selection: ChatSelection;
  signal: AbortSignal;
  onImage?(id: string, savedPath: string): Promise<void>;
  onThread(id: string): void;
  // The agent explicitly elects to finish without further user-visible output.
  onFinish?(options: { silent: true }): void;
  // Cumulative text; mark complete at a message boundary when the protocol exposes one.
  onText(id: string, text: string, complete?: boolean): void;
  onMessage(
    id: string,
    card: ChatCard,
    attachments?: readonly ChatFileInput[],
  ): void | Promise<void>;
}

export type RunChatTurn = (turn: ChatTurn) => Promise<void>;

// Adapters may expose only deliberately safe, user-facing execution errors.
export class ChatExecutionError extends Error {}

// The adapter refused resume before consuming any new input; a fresh handoff is safe.
export class ChatSessionUnavailableError extends Error {}

export type RecoveredChatEvent =
  | { type: "usage"; usage: ContextUsage }
  | { type: "image"; id: string; savedPath: string; createdAt: string };

export type RecoverChatHistory = (
  home: string,
  nativeThreadId: string,
) => AsyncIterable<RecoveredChatEvent>;
