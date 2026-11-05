// Each document is bound to one machine. Switching reloads the document so
// pending requests and component state cannot spill into another environment.
export function activeEnvironmentId() {
  return typeof window === "undefined"
    ? null
    : new URL(window.location.href).searchParams.get("environment");
}

export function environmentPath(path: string, id = activeEnvironmentId()) {
  return id ? `/api/environments/${encodeURIComponent(id)}/proxy${path}` : path;
}

export function environmentFetch(
  path: string,
  options?: RequestInit,
  environmentId = activeEnvironmentId(),
) {
  return fetch(environmentPath(path, environmentId), options);
}

export function environmentSocketUrl(
  path: string,
  environmentId = activeEnvironmentId(),
) {
  const url = new URL(
    environmentPath(path, environmentId),
    window.location.href,
  );
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  return url.href;
}
