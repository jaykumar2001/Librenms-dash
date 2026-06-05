import { useQuery } from "@tanstack/react-query";
import type { DeviceOverview } from "@librenms-dash/shared";
import { fetchDeviceOverview } from "@/lib/api";

export function useDeviceDetail(hostname: string | null) {
  return useQuery<DeviceOverview>({
    queryKey: ["device-overview", hostname],
    queryFn: () => fetchDeviceOverview(hostname!),
    enabled: !!hostname,
    staleTime: 5 * 60 * 1000,
  });
}
