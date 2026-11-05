import { readFile, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export async function webAssets(
  request: IncomingMessage,
  response: ServerResponse,
  directory: string | undefined,
) {
  if (!directory || !["GET", "HEAD"].includes(request.method ?? ""))
    return false;

  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (pathname.startsWith("/api/") || pathname === "/ws") return false;

  const root = resolve(directory);
  let file = resolve(root, `.${decodeURIComponent(pathname)}`);

  if (!file.startsWith(`${root}${sep}`) && file !== root) {
    response.writeHead(403).end();

    return true;
  }

  if (!(await stat(file).catch(() => null))?.isFile()) {
    if (extname(pathname)) {
      response.writeHead(404).end();

      return true;
    }

    file = resolve(root, "index.html");
  }

  const body = await readFile(file);
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : body);

  return true;
}
