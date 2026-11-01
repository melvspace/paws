import * as Fs from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertAgentId } from "@paws/shared";

// Reject links at every path segment, including parent directories. Never follow
// team-auth or other host paths from a shared directory.
function resourcePath(
  root: string,
  teamId: string,
  kind: string,
  path: string,
  create: boolean,
) {
  assertAgentId(teamId);
  const parts = path ? path.split("/") : [];

  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || /[\\\0]/.test(part),
    )
  )
    throw new Error("Invalid resource path.");

  let current = join(root, "teams", teamId, kind);
  const directories = [current];

  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    directories.push(current);
  }

  for (const directory of directories) {
    if (create && !Fs.existsSync(directory))
      Fs.mkdirSync(directory, { mode: 0o700 });
    if (!Fs.lstatSync(directory).isDirectory())
      throw new Error("Invalid directory.");
  }

  const result = parts.length ? join(current, parts.at(-1)!) : current;

  if (Fs.existsSync(result) && Fs.lstatSync(result).isSymbolicLink())
    throw new Error("Links cannot be accessed.");

  return result;
}

export async function teamResources(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  exists: (id: string) => Promise<boolean>,
) {
  const match =
    /^\/api\/teams\/([^/]+)\/resources\/(files|skills)(?:\/(.*))?$/.exec(
      request.url ?? "",
    );

  if (!match) return false;

  const id = match[1]!;

  if (!(await exists(id))) {
    response.writeHead(404).end(JSON.stringify({ error: "Team not found." }));

    return true;
  }

  const path = decodeURIComponent(match[3] ?? "");
  const file = resourcePath(
    root,
    id,
    match[2]!,
    path,
    request.method === "PUT",
  );

  if (request.method === "GET") {
    if (Fs.lstatSync(file).isDirectory()) {
      response.end(
        JSON.stringify(
          Fs.readdirSync(file, { withFileTypes: true })
            .filter((entry) => !entry.isSymbolicLink())
            .map((entry) => ({
              name: entry.name,
              directory: entry.isDirectory(),
            })),
        ),
      );
    } else {
      const descriptor = Fs.openSync(
        file,
        Fs.constants.O_RDONLY |
          Fs.constants.O_NOFOLLOW |
          Fs.constants.O_NONBLOCK,
      );

      try {
        const stat = Fs.fstatSync(descriptor);

        if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
          throw new Error("File too large or not a regular file.");

        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Disposition", "attachment");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.end(Fs.readFileSync(descriptor));
      } finally {
        Fs.closeSync(descriptor);
      }
    }
  } else if (request.method === "PUT" && path) {
    const chunks: Buffer[] = [];
    let size = 0;
    const limit = match[2] === "skills" ? 65536 : 16 * 1024 * 1024;

    for await (const chunk of request) {
      const data = Buffer.from(chunk);
      size += data.length;

      if (size > limit) {
        response
          .writeHead(413)
          .end(JSON.stringify({ error: "File too large." }));

        return true;
      }

      chunks.push(data);
    }

    const descriptor = Fs.openSync(
      file,
      Fs.constants.O_WRONLY |
        Fs.constants.O_CREAT |
        Fs.constants.O_NOFOLLOW |
        Fs.constants.O_NONBLOCK,
      0o600,
    );

    try {
      if (!Fs.fstatSync(descriptor).isFile())
        throw new Error("Not a regular file.");

      Fs.ftruncateSync(descriptor);
      Fs.writeFileSync(descriptor, Buffer.concat(chunks));
    } finally {
      Fs.closeSync(descriptor);
    }

    response.writeHead(204).end();
  } else if (request.method === "DELETE" && path) {
    Fs.unlinkSync(file);
    response.writeHead(204).end();
  } else {
    response.writeHead(405).end();
  }

  return true;
}
