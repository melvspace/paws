import { relative, resolve } from "node:path";

/** @param {unknown} message @param {string} root */
export function runtimeSetupRequest(message, root) {
  if (
    process.platform !== "linux" ||
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "runtime-setup-required" ||
    !("id" in message) ||
    typeof message.id !== "string" ||
    !("helper" in message) ||
    typeof message.helper !== "string" ||
    !("binary" in message) ||
    typeof message.binary !== "string"
  )
    return null;

  const directory = resolve(root, "runtime", "installation");
  const binary = relative(directory, resolve(message.binary));
  const version = /^([a-f0-9]{16})\/docker\/rootlesskit$/.exec(binary)?.[1];

  if (
    !version ||
    relative(directory, resolve(message.helper)) !==
      `${version}/setup/paws-runtime-setup`
  )
    return null;

  return { id: message.id, helper: message.helper, binary: message.binary };
}
