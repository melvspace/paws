import { mkdtemp, mkdir, writeFile, symlink, rm, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { saveWorkspaceAttachments } from "./chatAttachments.ts";

it("refuses files outside the workspace, symlink escapes, directories and oversized files", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-attachment-test-");
  const agent = randomUUID();
  const workspace = `${root}/agents/${agent}/workspace`;
  await mkdir(workspace, { recursive: true });

  try {
    await writeFile(`${root}/private`, "private value");
    await symlink(`${root}/private`, `${workspace}/escape`);
    const large = await open(`${workspace}/large`, "w");
    await large.truncate(64 * 1024 * 1024 + 1);
    await large.close();

    for (const path of [
      "/tmp/paws-secrets/value",
      "../../../private",
      "/workspace/escape",
      "/workspace/large",
      "/workspace/",
    ])
      await expect(
        saveWorkspaceAttachments(root, agent, [{ path }]),
      ).rejects.toThrow();

    await expect(
      saveWorkspaceAttachments(
        root,
        agent,
        Array.from({ length: 5 }, () => ({ path: "file" })),
      ),
    ).rejects.toThrow("Too many");
    await writeFile(`${workspace}/note.txt`, "hello");
    const files = await saveWorkspaceAttachments(root, agent, [
      { path: "note.txt", name: 'hello\r\n"world.txt' },
    ]);
    expect(files[0]?.name).toBe("hello___world.txt");
    expect(files[0]?.size).toBe(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
