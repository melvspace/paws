// Adapted from T3 Code chat/ContextWindowMeter.tsx (MIT).
import type { ContextUsage } from "@paws/contracts";
import { Minimize2Icon } from "lucide-react";
import { ComposerControl } from "./ComposerControl.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Popover,
  PopoverTrigger,
  PopoverPopup,
} from "../components/ui/popover.tsx";
import "./context-window.css";

function tokens(value: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  })
    .format(value)
    .toLowerCase();
}

export function ContextWindowMeter({
  usage,
  modelName,
  onCompact,
  disabled,
  compacting,
}: {
  usage?: ContextUsage | undefined;
  modelName?: string | undefined;
  onCompact?: () => void;
  disabled?: boolean;
  compacting?: boolean;
}) {
  const percentage = usage?.maxTokens
    ? Math.min(100, Math.max(0, (usage.usedTokens / usage.maxTokens) * 100))
    : null;
  const label =
    percentage === null
      ? usage
        ? `${tokens(usage.usedTokens)} tokens used`
        : "Context usage unavailable"
      : `${Math.round(percentage)}% context used`;
  const circumference = 2 * Math.PI * 9.75;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <ComposerControl
            className="composer-context-meter"
            aria-label={label}
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <circle cx="12" cy="12" r="9.75" fill="none" strokeWidth="3" />
              <circle
                cx="12"
                cy="12"
                r="9.75"
                fill="none"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - (percentage ?? 0) / 100)}
                transform="rotate(-90 12 12)"
                style={{
                  stroke:
                    percentage !== null && percentage > 90
                      ? "var(--destructive)"
                      : "var(--muted-foreground)",
                }}
              />
            </svg>
          </ComposerControl>
        }
      />
      <PopoverPopup className="context-window-popup">
        <div className="context-window-heading">
          <span>Context Window</span>
          <span>
            {usage ? (
              <>
                {percentage !== null && `${Math.round(percentage)}% · `}
                {tokens(usage.usedTokens)}
                {usage.maxTokens ? `/${tokens(usage.maxTokens)}` : " tokens"}
              </>
            ) : (
              "Not reported yet"
            )}
          </span>
        </div>
        {percentage !== null && (
          <div
            className="context-window-track"
            role="progressbar"
            aria-label="Context window usage"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percentage)}
          >
            <div style={{ width: `${percentage}%` }} />
          </div>
        )}
        <p>
          Context{modelName ? ` for ${modelName}` : ""} compacts automatically
          when needed.
        </p>
        <Button
          variant="outline"
          disabled={disabled || !onCompact || compacting}
          onClick={onCompact}
        >
          <Minimize2Icon size={14} aria-hidden />
          {compacting ? "Compacting…" : "Compact context"}
        </Button>
      </PopoverPopup>
    </Popover>
  );
}
