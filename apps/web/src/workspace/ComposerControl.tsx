// Adapted from T3 Code chat/ComposerControl.tsx (MIT).
import type { ComponentProps } from "react";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
import "./composer-controls.css";

export function ComposerControl({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return <Button className={cn("composer-control", className)} {...props} />;
}
