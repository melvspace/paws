import { useState } from "react";
import { Button } from "./button.tsx";
import "./sensitive-text.css";

export function SensitiveText({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const action = revealed
    ? `Click to hide ${label}`
    : `Click to reveal ${label}`;

  return (
    <Button
      className="sensitive-text"
      variant="ghost"
      title={action}
      aria-label={revealed ? `${value}. ${action}` : action}
      aria-pressed={revealed}
      onClick={() => setRevealed(!revealed)}
    >
      <span data-revealed={revealed} aria-hidden={!revealed}>
        {value}
      </span>
    </Button>
  );
}
