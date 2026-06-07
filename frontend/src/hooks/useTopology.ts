import { useQuery } from "@tanstack/react-query";
import { fetchTopology } from "@/lib/api";
import type { TopologyResponse } from "@librenms-dash/shared";

const STEADY_INTERVAL = 5 * 60 * 1000; // 5 min once data is complete
const LOADING_INTERVAL = 10 * 1000; // 10s while backend is still populating

function isDataIncomplete(data: TopologyResponse | undefined): boolean {
  if (!data) return true;
  return data.arpLinks.length === 0 && (data.arpDevices?.length ?? 0) === 0;
}

export function useTopology() {
  return useQuery({
    queryKey: ["topology"],
    queryFn: fetchTopology,
    refetchInterval: (query) => {
      return isDataIncomplete(query.state.data) ? LOADING_INTERVAL : STEADY_INTERVAL;
    },
    staleTime: 0,
  });
}
