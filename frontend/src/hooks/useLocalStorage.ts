import { useState, useCallback } from "react";

/**
 * Drop-in replacement for useState that persists the value in localStorage.
 * The value is JSON-serialised on write and deserialised on read.
 * Falls back to `defaultValue` if the key is missing, unparseable, or storage
 * is unavailable (e.g. private-browsing incognito modes that block storage).
 */
export function useLocalStorage<T>(key: string, defaultValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return defaultValue;
      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setState((prev) => {
        const next = typeof value === "function" ? (value as (prev: T) => T)(prev) : value;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Storage full or blocked — silently continue with in-memory state.
        }
        return next;
      });
    },
    [key],
  );

  return [state, setValue];
}
