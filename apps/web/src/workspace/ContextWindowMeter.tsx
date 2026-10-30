// Ring geometry adapted from T3 Code chat/ContextWindowMeter.tsx (MIT).
import { ComposerControl } from "./ComposerControl.tsx";

export function ContextWindowMeter() {
  return (
    <ComposerControl
      className="composer-context-meter"
      aria-label="Context usage unavailable"
      title="Context usage unavailable"
    >
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="9.75" fill="none" strokeWidth="3" />
      </svg>
    </ComposerControl>
  );
}
