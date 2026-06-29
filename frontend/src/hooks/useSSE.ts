import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AssetEvent, TopologyResponse } from "@librenms-dash/shared";

export function useSSE() {
  const queryClient = useQueryClient();
  const [allEvents, setAllEvents] = useState<AssetEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const addEventsRef = useRef<(events: AssetEvent[]) => void>();
  const isFirstOpen = useRef(true);

  const addEvents = useCallback((events: AssetEvent[]) => {
    setAllEvents(prev => {
      const merged = [...prev, ...events];
      return merged.length > 200 ? merged.slice(-200) : merged;
    });
  }, []);

  addEventsRef.current = addEvents;

  useEffect(() => {
    const es = new EventSource("/api/events/stream");

    es.addEventListener("init", (e) => {
      try {
        const events: AssetEvent[] = JSON.parse(e.data);
        if (events.length > 0) setAllEvents(events);
      } catch { /* ignore */ }
    });

    es.addEventListener("events", (e) => {
      try {
        const events: AssetEvent[] = JSON.parse(e.data);
        if (events.length > 0) addEventsRef.current?.(events);
      } catch { /* ignore */ }
    });

    es.addEventListener("topology-changed", (e) => {
      try {
        const payload = JSON.parse(e.data) as TopologyResponse;
        queryClient.setQueryData(["topology"], payload);
      } catch { /* ignore malformed events */ }
    });

    es.onopen = () => {
      setConnected(true);
      if (!isFirstOpen.current) {
        // SSE reconnected — resync in case events were missed while disconnected
        queryClient.invalidateQueries({ queryKey: ["topology"] });
      }
      isFirstOpen.current = false;
    };
    es.onerror = () => setConnected(false);
    return () => { es.close(); setConnected(false); isFirstOpen.current = true; };
  }, [queryClient]);

  return { allEvents, connected };
}
