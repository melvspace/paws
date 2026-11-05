// Adapted from T3 Code settings/EnvironmentRow.tsx (MIT); see LICENSE.
import type { ReactNode } from "react";
import { LaptopIcon, MonitorIcon } from "lucide-react";

export function EnvironmentRow({
  kind = "desktop",
  label,
  subtitle,
  detail,
  dimmed = false,
  children,
}: {
  kind?: "desktop" | "laptop";
  label: string;
  subtitle: ReactNode;
  detail?: ReactNode;
  dimmed?: boolean;
  children?: ReactNode;
}) {
  const Icon = kind === "laptop" ? LaptopIcon : MonitorIcon;

  return (
    <div className="environment-machine" data-dimmed={dimmed || undefined}>
      <Icon
        className="environment-machine-icon"
        size={16}
        strokeWidth={1.5}
        aria-hidden
      />
      <div className="environment-machine-copy">
        <span className="environment-machine-name" title={label}>
          {label}
        </span>
        <div className="environment-machine-meta">{subtitle}</div>
      </div>
      <div className="environment-machine-actions">{children}</div>
      {detail && <div className="environment-entry-details">{detail}</div>}
    </div>
  );
}
