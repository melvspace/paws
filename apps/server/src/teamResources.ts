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

  // Pin each directory before descending. The descriptor paths keep operations
  // anchored even when an agent renames a directory during an upload.
  const descriptors: number[] = [];
  const descriptorRoot =
    process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";

  try {
    let directory = root;

    for (const part of ["", "teams", teamId, kind, ...parts.slice(0, -1)]) {
      if (part) directory = join(directory, part);

      if (create && !Fs.existsSync(directory)) {
        try {
          Fs.mkdirSync(directory, { mode: 0o700 });
        } catch (cause) {
          if (
            !(
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "EEXIST"
            )
          )
            throw cause;
        }
      }

      const descriptor = Fs.openSync(
        directory,
        Fs.constants.O_RDONLY |
          Fs.constants.O_DIRECTORY |
          Fs.constants.O_NOFOLLOW,
      );
      descriptors.push(descriptor);
      directory = join(descriptorRoot, String(descriptor));
    }

    return {
      path: parts.length ? join(directory, parts.at(-1)!) : directory,
      close() {
        for (const descriptor of descriptors.reverse())
          Fs.closeSync(descriptor);
      },
    };
  } catch (cause) {
    for (const descriptor of descriptors.reverse()) Fs.closeSync(descriptor);

    throw cause;
  }
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
  const resource = resourcePath(
    root,
    id,
    match[2]!,
    path,
    request.method === "PUT",
  );

  try {
    const file = resource.path;

    if (request.method === "GET") {
      const descriptor = Fs.openSync(
        file,
        Fs.constants.O_RDONLY |
          (path ? Fs.constants.O_NOFOLLOW : 0) |
          Fs.constants.O_NONBLOCK,
      );

      try {
        if (Fs.fstatSync(descriptor).isDirectory()) {
          response.end(
            JSON.stringify(
              Fs.readdirSync(
                `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${descriptor}`,
                { withFileTypes: true },
              )
                .filter((entry) => !entry.isSymbolicLink())
                .map((entry) => ({
                  name: entry.name,
                  directory: entry.isDirectory(),
                })),
            ),
          );
        } else {
          const stat = Fs.fstatSync(descriptor);

          if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
            throw new Error("File too large or not a regular file.");

          response.setHeader("Content-Type", "application/octet-stream");
          response.setHeader("Content-Disposition", "attachment");
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.end(Fs.readFileSync(descriptor));
        }
      } finally {
        Fs.closeSync(descriptor);
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
  } finally {
    resource.close();
  }
}
