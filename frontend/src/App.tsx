import { useTopology } from "@/hooks/useTopology";
import { useSSE } from "@/hooks/useSSE";
import { useAuth } from "@/context/AuthContext";
import { TopologyMap } from "@/components/TopologyMap";
import { LoginPage } from "@/components/LoginPage";
import { AuthScreen } from "@/components/AuthScreen";

function AuthLoadingScreen({ message }: { message: string }) {
  return (
    <AuthScreen>
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-gray-400 text-sm">{message}</p>
      </div>
    </AuthScreen>
  );
}

function Dashboard() {
  const { data, isLoading, error, warming } = useTopology();
  const sse = useSSE();

  if (isLoading || warming) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-gray-950">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400 text-sm">
            {warming ? "Server is starting up — waiting for cache..." : "Loading topology from LibreNMS..."}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-gray-950">
        <div className="text-center max-w-md px-4">
          <p className="text-red-400 text-lg font-semibold mb-2">Failed to load topology</p>
          <p className="text-gray-400 text-sm">{(error as Error).message}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return <TopologyMap data={data} sse={sse} />;
}

export function App() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen message="Checking session..." />;
  }

  if (!user) {
    return (
      <AuthScreen>
        <LoginPage />
      </AuthScreen>
    );
  }

  return <Dashboard />;
}
