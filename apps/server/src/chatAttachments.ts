import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  realpath,
  writeFile,
  readFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import {
  join,
  relative,
  isAbsolute,
  resolve,
  basename,
  extname,
} from "node:path";
import type { ChatAttachment, ChatFileInput } from "@paws/contracts";
import { workspaceLayout } from "@paws/runtime";

function inside(root: string, path: string) {
  const suffix = relative(root, path);

  return suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix);
}

export async function saveGeneratedImage(
  root: string,
  agentId: string,
  savedPath: string,
): Promise<ChatAttachment> {
  const prefix = "/home/agent/.codex/generated_images/";

  if (!savedPath.startsWith(prefix))
    throw new Error("Invalid generated image path.");

  const home = await realpath(workspaceLayout(root, agentId).home);
  const directory = await realpath(join(home, ".codex/generated_images"));
  const source = await realpath(
    resolve(directory, savedPath.slice(prefix.length)),
  );

  if (!inside(home, directory) || !inside(directory, source))
    throw new Error("Invalid generated image path.");

  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data: Buffer;

  try {
    const stat = await file.stat();

    if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
      throw new Error("Invalid image size.");

    data = await file.readFile();
  } finally {
    await file.close();
  }

  const mediaType = data
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      ? "image/jpeg"
      : data.toString("ascii", 0, 4) === "RIFF" &&
          data.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : null;

  if (!mediaType) throw new Error("Unsupported generated image format.");

  const id = createHash("sha256").update(data).digest("hex");
  const destination = join(root, "chat-attachments", agentId);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await writeFile(join(destination, id), data, { mode: 0o600 });

  return {
    id,
    name: `Generated image.${mediaType === "image/jpeg" ? "jpg" : mediaType.slice(6)}`,
    mediaType,
  };
}

export async function readChatAttachment(
  root: string,
  agentId: string,
  attachment: ChatAttachment,
) {
  if (!/^[a-f0-9]{64}$/.test(attachment.id))
    throw new Error("Invalid attachment ID.");

  // Only the server writes this directory; it is never mounted in agent containers.
  return readFile(join(root, "chat-attachments", agentId, attachment.id));
}

function attachmentName(value: string) {
  return (
    basename(value)
      .split("")
      .map((character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        character === '"' ||
        character === "\\"
          ? "_"
          : character,
      )
      .join("")
      .slice(0, 200) || "Attachment"
  );
}

const maxFileBytes = 64 * 1024 * 1024;

export function fileMediaType(data: Buffer, name: string) {
  const extension = extname(name).toLowerCase();

  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6)))
    return "image/gif";
  if (data.toString("ascii", 0, 4) === "RIFF") {
    if (data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (data.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  }

  if (data.toString("ascii", 4, 8) === "ftyp")
    return extension === ".m4a" ? "audio/mp4" : "video/mp4";
  if (
    data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
    extension === ".webm"
  )
    return "video/webm";
  if (data.toString("ascii", 0, 4) === "OggS")
    return extension === ".ogv" ? "video/ogg" : "audio/ogg";
  if (
    data.toString("ascii", 0, 3) === "ID3" ||
    (extension === ".mp3" && data[0] === 255 && ((data[1] ?? 0) & 224) === 224)
  )
    return "audio/mpeg";
  if (data.toString("ascii", 0, 4) === "fLaC") return "audio/flac";
  if (data.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";

  // Documents and source files are downloads, never executable same-origin content.
  return "application/octet-stream";
}

export async function saveWorkspaceAttachments(
  root: string,
  agentId: string,
  files: readonly ChatFileInput[],
): Promise<ChatAttachment[]> {
  if (files.length > 4) throw new Error("Too many attachments.");
  if (!files.length) return [];

  const workspace = await realpath(workspaceLayout(root, agentId).workspace);
  const saved: { attachment: ChatAttachment; data: Buffer }[] = [];
  let total = 0;

  for (const file of files) {
    if (
      !file.path ||
      file.path.length > 4096 ||
      file.path.includes("\0") ||
      (isAbsolute(file.path) && !file.path.startsWith("/workspace/"))
    )
      throw new Error("Attach a file inside /workspace.");

    const source = await realpath(
      resolve(workspace, file.path.replace(/^\/workspace\//, "")),
    );

    if (!inside(workspace, source))
      throw new Error("Attachment outside workspace.");

    const handle = await open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );

    try {
      // Check the opened file too, so swapped parent symlinks cannot escape the mount.
      const opened = await realpath(`/proc/self/fd/${handle.fd}`);
      const stat = await handle.stat();

      if (
        !inside(workspace, opened) ||
        !stat.isFile() ||
        stat.size > maxFileBytes ||
        total + stat.size > 128 * 1024 * 1024
      )
        throw new Error("Invalid attachment file or size.");

      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;

      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );

        if (!bytesRead) break;

        length += bytesRead;
      }

      if (length !== stat.size)
        throw new Error("File changed while attaching. Try again.");

      const data = buffer.subarray(0, length);
      total += length;
      const name = attachmentName(file.name ?? file.path);
      saved.push({
        attachment: {
          id: createHash("sha256")
            .update(data)
            .update("\0")
            .update(name)
            .digest("hex"),
          name,
          mediaType: fileMediaType(data, file.path),
          size: length,
        },
        data,
      });
    } finally {
      await handle.close();
    }
  }

  const destination = join(root, "chat-attachments", agentId);
  await mkdir(destination, { recursive: true, mode: 0o700 });

  for (const { attachment, data } of saved)
    await writeFile(join(destination, attachment.id), data, { mode: 0o600 });

  return saved.map(({ attachment }) => attachment);
}

export async function saveUploadedAttachment(
  root: string,
  agentId: string,
  filename: string,
  data: Buffer,
): Promise<ChatAttachment> {
  if (!data.length || data.length > maxFileBytes)
    throw new Error("Use a non-empty file up to 64 MB.");

  const name = attachmentName(filename.replaceAll("\\", "/"));

  if (!name || name === "." || name === "..")
    throw new Error("Invalid filename.");

  const workspace = await realpath(workspaceLayout(root, agentId).workspace);
  const directory = await mkdtemp(join(workspace, ".paws-upload-"));

  try {
    const file = await open(
      join(directory, name),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );

    try {
      if (!inside(workspace, await realpath(`/proc/self/fd/${file.fd}`)))
        throw new Error("Upload outside workspace.");

      await file.writeFile(data);
    } finally {
      await file.close();
    }

    const attachment: ChatAttachment = {
      id: createHash("sha256")
        .update(data)
        .update("\0")
        .update(name)
        .digest("hex"),
      name,
      mediaType: fileMediaType(data, name),
      size: data.length,
      path: `/workspace/${basename(directory)}/${name}`,
    };
    const destination = join(root, "chat-attachments", agentId);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await writeFile(join(destination, attachment.id), data, { mode: 0o600 });

    return attachment;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });

    throw error;
  }
}

export async function resolveChatAttachment(
  root: string,
  agentId: string,
  attachment: ChatAttachment,
) {
  const materialized = await saveUploadedAttachment(
    root,
    agentId,
    attachment.name,
    await readChatAttachment(root, agentId, attachment),
  );

  return { ...attachment, path: materialized.path! };
}

export async function viewWorkspaceImage(
  root: string,
  agentId: string,
  path: string,
) {
  const [image] = await saveWorkspaceAttachments(root, agentId, [{ path }]);

  if (
    !image ||
    !/^image\/(png|jpeg|webp|gif)$/.test(image.mediaType) ||
    (image.size ?? 0) > 20 * 1024 * 1024
  )
    throw new Error("Use an image up to 20 MB inside /workspace.");

  return {
    mimeType: image.mediaType,
    data: (await readChatAttachment(root, agentId, image)).toString("base64"),
  };
}
