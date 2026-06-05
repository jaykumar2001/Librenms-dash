import { useTopology } from "@/hooks/useTopology";
import { TopologyMap } from "@/components/TopologyMap";

export function App() {
  const { data, isLoading, error } = useTopology();

  if (isLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400 text-sm">Loading topology from LibreNMS...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-gray-950">
        <div className="text-center max-w-md">
          <p className="text-red-400 text-lg font-semibold mb-2">Failed to load topology</p>
          <p className="text-gray-400 text-sm">{(error as Error).message}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return <TopologyMap data={data} />;
}
