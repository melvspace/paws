import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  makeAgentProfileService,
  profileEvidence,
  profileInstructions,
  type ProfileSource,
} from "./AgentProfileService.ts";

const agent = {
  id: "agent",
  name: "Ada",
  provider: "codex",
  status: "configured",
  createdAt: "2026-11-12",
} as const;

async function fixture() {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-profile-test-");
  let source: ProfileSource = {
    agent,
    instructions: "Review API contracts",
    routines: [],
    messages: [],
  };
  let now = 1000;
  const generate = vi.fn(async () => ({
    role: "API reviewer",
    description: "Reviews API contracts.",
  }));
  const save = vi.fn(async () => {});
  const dependencies = {
    sources: () => [source],
    selection: () => ({ model: "luna" }),
    generate,
    save,
    changed: vi.fn(),
    now: () => now,
  };
  const service = makeAgentProfileService(root, dependencies);

  return {
    root,
    service,
    dependencies,
    generate,
    save,
    source: () => source,
    change: (patch: Partial<ProfileSource>) => {
      source = { ...source, ...patch };
    },
    advance: () => {
      now += 300_001;
    },
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("inferred agent profiles", () => {
  it("persists fingerprints across restarts and refreshes changed instructions", async () => {
    const f = await fixture();

    try {
      await f.service.tick();
      expect(f.save).toHaveBeenCalledWith("agent", {
        role: "API reviewer",
        description: "Reviews API contracts.",
      });
      await f.service.close();
      const restarted = makeAgentProfileService(f.root, f.dependencies);

      try {
        await restarted.tick();
        expect(f.generate).toHaveBeenCalledTimes(1);
        f.change({ instructions: "Review database migrations" });
        await restarted.tick();
        expect(f.generate).toHaveBeenCalledTimes(2);
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("clears inferred metadata when its supporting evidence is removed", async () => {
    const f = await fixture();

    try {
      await f.service.tick();
      f.change({ instructions: "" });
      await f.service.tick();
      expect(f.save).toHaveBeenLastCalledWith("agent", {
        role: "",
        description: "",
      });
      expect(f.generate).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it("preserves prior profiles on failure, backs off and retries", async () => {
    const f = await fixture();

    try {
      f.generate.mockRejectedValueOnce(
        new Error("secret provider diagnostics"),
      );
      await f.service.tick();
      await f.service.tick();
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.save).not.toHaveBeenCalled();
      expect(JSON.stringify(f.service.errors())).not.toContain("secret");
      f.advance();
      await f.service.tick();
      expect(f.save).toHaveBeenCalledTimes(1);
      expect(f.service.errors()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("discards stale results and serializes overlapping refreshes", async () => {
    const f = await fixture();
    let finish = () => {};
    f.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ role: "Old", description: "Old" });
        }),
    );

    try {
      const first = f.service.tick();
      const second = f.service.tick();
      f.change({ instructions: "New instructions" });
      finish();
      await Promise.all([first, second]);
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.save).not.toHaveBeenCalled();
      await f.service.tick();
      expect(f.save).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it("aborts active work and prevents saves during shutdown", async () => {
    const f = await fixture();
    f.generate.mockImplementationOnce(
      (_prompt?: string, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );

    const pending = f.service.tick();
    await f.service.close();
    await pending;
    expect(f.save).not.toHaveBeenCalled();
    await rm(f.root, { recursive: true, force: true });
  });

  it("uses bounded human evidence and ignores peer, routine and secret interactions", async () => {
    const f = await fixture();

    try {
      const message = {
        id: "m",
        role: "user",
        text: "Review API",
        createdAt: "now",
      } as const;
      const source = { ...f.source(), instructions: "", messages: [message] };
      expect(profileEvidence(source).sufficient).toBe(false);
      expect(
        profileEvidence({ ...source, messages: [message, message, message] })
          .sufficient,
      ).toBe(true);
      const evidence = profileEvidence({
        ...source,
        messages: [
          {
            ...message,
            interaction: {
              source: "paws",
              type: "secret_declined",
              prompt: "",
              action: { id: "a", label: "a" },
              fields: [],
              eventId: "e",
              messageId: "m",
            },
            text: "SECRET",
          },
        ],
      });
      expect(evidence.prompt).not.toContain("SECRET");
      expect(evidence.sufficient).toBe(false);
      await mkdir(join(f.root, "agents", "agent", "workspace"), {
        recursive: true,
      });
      await writeFile(join(f.root, "outside"), "PRIVATE");
      await symlink(
        join(f.root, "outside"),
        join(f.root, "agents", "agent", "workspace", "AGENTS.md"),
      );
      expect(profileInstructions(f.root, "agent")).toBe("");
    } finally {
      await f.close();
    }
  });
});
