import { useSyncExternalStore } from "react";
import { favoritesStorageKey, readModelFavorites } from "./models.ts";

const preferencesKey = "paws.model-preferences";
const eventName = "paws-model-preferences";

function read(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Keep provider settings usable when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(eventName));
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(eventName, listener);

  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(eventName, listener);
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function useModelPreferences() {
  const saved = useSyncExternalStore(
    subscribe,
    () => read(preferencesKey),
    () => "",
  );
  const savedFavorites = useSyncExternalStore(
    subscribe,
    () => read(favoritesStorageKey),
    () => "",
  );
  let hidden: string[] = [];
  let order: string[] = [];

  try {
    const parsed: unknown = JSON.parse(saved || "{}");

    if (parsed && typeof parsed === "object") {
      hidden = stringList("hidden" in parsed ? parsed.hidden : undefined);
      order = stringList("order" in parsed ? parsed.order : undefined);
    }
  } catch {
    // Invalid saved preferences fall back to the provider's catalog.
  }
  const favorites = readModelFavorites({ getItem: () => savedFavorites });

  return {
    hidden,
    order,
    favorites,
    setHidden: (next: string[]) =>
      write(preferencesKey, { hidden: next, order }),
    setOrder: (next: string[]) =>
      write(preferencesKey, { hidden, order: next }),
    toggleFavorite(id: string) {
      write(
        favoritesStorageKey,
        favorites.includes(id)
          ? favorites.filter((favorite) => favorite !== id)
          : [...favorites, id],
      );
    },
  };
}
