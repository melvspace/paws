import { expect, it } from "vite-plus/test";
import type { ChatHandoff, ChatMessage } from "@paws/contracts";
import { handoffPresentation } from "./handoffPresentation.ts";

const first = { providerId: "first", modelId: "model", name: "First" };
const second = { providerId: "second", modelId: "model", name: "Second" };
const message = (id: string, model?: typeof first): ChatMessage => ({
  id,
  role: model ? "assistant" : "user",
  text: "Example",
  createdAt: "2026-01-01T00:00:00Z",
  ...(model ? { model } : {}),
});
const event = (id: string, to: typeof first): ChatHandoff => ({
  id,
  beforeMessageId: id,
  from: [first, second],
  to,
  status: "pending",
});

it("repairs legacy mixed-history restoration while preserving real switches in both directions", () => {
  const result = handoffPresentation(
    [event("switch", second), event("restore", second), event("back", first)],
    [
      message("initial:reply", first),
      message("switch"),
      message("switch:reply", second),
      message("restore"),
      { ...message("restore:reply", second), streaming: true },
      message("back"),
    ],
  );
  expect(
    result.map(({ kind, from, status }) => ({ kind, from, status })),
  ).toEqual([
    { kind: "provider-switch", from: [first, second], status: "pending" },
    { kind: "session-restoration", from: [first, second], status: "pending" },
    { kind: "provider-switch", from: [first, second], status: "pending" },
  ]);
});

it("uses the preceding handoff destination when a turn completed silently", () => {
  const result = handoffPresentation(
    [event("switch", second), event("restore", second), event("back", first)],
    [
      message("initial:reply", first),
      message("switch"),
      message("restore"),
      message("back"),
    ],
  );
  expect(result.map(({ kind }) => kind)).toEqual([
    "provider-switch",
    "session-restoration",
    "provider-switch",
  ]);
});

it("preserves explicit session boundaries even when message order suggests another source", () => {
  const handoff: ChatHandoff = {
    ...event("switch", first),
    kind: "provider-switch",
    from: [second],
  };
  expect(
    handoffPresentation([handoff], [message("old", first), message("switch")]),
  ).toEqual([handoff]);
});

it("hides a failed restoration after a later successful restoration to that provider", () => {
  const failed: ChatHandoff = {
    ...event("old-missing-message", second),
    kind: "session-restoration",
    status: "failed",
  };
  const restored: ChatHandoff = {
    ...event("retry", second),
    kind: "session-restoration",
    status: "completed",
  };
  expect(handoffPresentation([failed, restored], [message("retry")])).toEqual([
    restored,
  ]);
});

it.each(["pending", "failed"] as const)(
  "keeps the warning when a later restoration is %s",
  (status) => {
    const failed: ChatHandoff = {
      ...event("failed", second),
      kind: "session-restoration",
      status: "failed",
    };
    const retry: ChatHandoff = {
      ...event("retry", second),
      kind: "session-restoration",
      status,
    };
    expect(handoffPresentation([failed, retry], [])).toEqual([failed, retry]);
  },
);

it("keeps failures for another provider and real provider-switch history", () => {
  const failed: ChatHandoff = {
    ...event("failed", first),
    kind: "session-restoration",
    status: "failed",
  };
  const switched: ChatHandoff = {
    ...event("switch", second),
    kind: "provider-switch",
    status: "failed",
  };
  const restored: ChatHandoff = {
    ...event("retry", second),
    kind: "session-restoration",
    status: "completed",
  };
  expect(handoffPresentation([failed, switched, restored], [])).toEqual([
    failed,
    switched,
    restored,
  ]);
});
