import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchTopology, ServerWarmingError } from "@/lib/api";
import type { TopologyResponse } from "@librenms-dash/shared";

const STEADY_INTERVAL = 5 * 60 * 1000;
const LOADING_INTERVAL = 10 * 1000;

function isDataIncomplete(data: TopologyResponse | undefined): boolean {
  if (!data) return true;
  return data.arpLinks.length === 0 && (data.arpDevices?.length ?? 0) === 0;
}

export function useTopology() {
  const queryClient = useQueryClient();
  const [warming, setWarming] = useState(false);

  const query = useQuery({
    queryKey: ["topology"],
    queryFn: fetchTopology,
    refetchInterval: (q) => {
      if (q.state.error instanceof ServerWarmingError) return false;
      return isDataIncomplete(q.state.data) ? LOADING_INTERVAL : STEADY_INTERVAL;
    },
    retry: (failureCount, error) => {
      if (error instanceof ServerWarmingError) return false;
      return failureCount < 3;
    },
    staleTime: 0,
  });

  const isWarming = query.error instanceof ServerWarmingError;

  useEffect(() => {
    if (!isWarming) {
      setWarming(false);
      return;
    }
    setWarming(true);

    const es = new EventSource("/api/health/stream");

    es.addEventListener("ready", () => {
      es.close();
      setWarming(false);
      queryClient.invalidateQueries({ queryKey: ["topology"] });
    });

    es.onerror = () => {
      es.close();
      const timer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["topology"] });
      }, 3000);
      return () => clearTimeout(timer);
    };

    return () => es.close();
  }, [isWarming, queryClient]);

  return { ...query, warming };
}
