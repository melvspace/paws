import { useSyncExternalStore } from "react";

const query = "(max-width: 640px)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);

  return () => media.removeEventListener("change", onChange);
}

export function useMobileLayout() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
