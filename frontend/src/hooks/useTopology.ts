import { useQuery } from "@tanstack/react-query";
import { fetchTopology } from "@/lib/api";

export function useTopology() {
  return useQuery({
    queryKey: ["topology"],
    queryFn: fetchTopology,
    refetchInterval: 5 * 60 * 1000, // 5 min
    staleTime: 4 * 60 * 1000,
  });
}
