import { expect, it } from "vite-plus/test";
import {
  historicalMessages,
  historyFingerprints,
  prepareHandoff,
} from "./chatHandoff.ts";
import type { ChatMessage } from "@paws/contracts";

it("hands off only unseen history and preserves UI-event provenance without secret references", () => {
  const messages: ChatMessage[] = [
    { id: "user", role: "user", text: "Hello", createdAt: "2026-01-01" },
    {
      id: "card",
      role: "assistant",
      text: "Token",
      createdAt: "2026-01-01",
      interaction: {
        source: "paws",
        type: "secret_saved",
        eventId: "evt",
        messageId: "card",
        prompt: "Token",
        secretRef: "private-ref",
        action: { id: "save", label: "Token" },
        fields: [],
        delivery: "delivered",
      },
    },
    {
      id: "queued",
      role: "user",
      text: "Not sent yet",
      createdAt: "2026-01-01",
      delivery: "queued",
    },
  ];
  const seen = historyFingerprints(messages.slice(0, 1));
  const handoff = prepareHandoff(messages, seen);
  expect(handoff).not.toContain('"text":"Hello"');
  expect(handoff).not.toContain("Not sent yet");
  expect(handoff).not.toContain("private-ref");
  expect(handoff).toContain('"source":"paws"');
  expect(
    prepareHandoff(messages, historyFingerprints(messages)),
  ).toBeUndefined();
  expect(historicalMessages(messages)).toHaveLength(2);
});

it("bounds large transcripts while retaining the latest context", () => {
  const messages: ChatMessage[] = Array.from({ length: 20 }, (_, index) => ({
    id: `${index}`,
    role: "assistant",
    createdAt: "2026-01-01",
    text: `${index}:` + "a".repeat(8000),
  }));
  const handoff = prepareHandoff(messages, {})!;
  expect(handoff.length).toBeLessThan(49000);
  expect(handoff).toContain('"id":"19"');
  expect(handoff).not.toContain('"id":"0"');
  expect(handoff).toContain("older messages omitted");
});

it("bounds JSON expansion for a single oversized message", () => {
  const handoff = prepareHandoff(
    [
      {
        id: "large",
        role: "assistant",
        createdAt: "2026-01-01",
        text: "\u0000".repeat(100_000),
      },
    ],
    {},
  )!;
  expect(handoff.length).toBeLessThan(49_000);
  expect(handoff).toContain("Earlier content omitted");
});
