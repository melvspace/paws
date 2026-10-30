import { BotIcon } from "lucide-react";
import type { ProviderDriver } from "@paws/contracts";
import { CodexIcon } from "../workspace/CodexIcon.tsx";
import { providerIcons } from "./icons.ts";

export function ProviderIcon({
  driver,
}: {
  driver?: ProviderDriver | undefined;
}) {
  if (driver === "codex") return <CodexIcon />;
  if (driver === "antigravity")
    return (
      <svg viewBox="0 0 128 128" aria-hidden>
        <image
          href="/provider-icons/antigravity.png"
          width="128"
          height="128"
          style={{ filter: "grayscale(1)" }}
        />
      </svg>
    );

  const icon = driver ? providerIcons[driver] : undefined;

  return icon ? (
    <svg viewBox={icon.viewBox} fill="currentColor" aria-hidden>
      {icon.paths.map((path) => (
        <path key={path} d={path} fillRule="evenodd" />
      ))}
    </svg>
  ) : (
    <BotIcon size={18} aria-hidden />
  );
}
