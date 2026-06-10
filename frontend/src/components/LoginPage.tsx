import { useState, type FormEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import { Logo } from "./Logo";

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await login(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-sm mx-auto">
        <div className="text-center mb-8">
          <Logo size={72} className="mx-auto mb-3" />
          <h1 className="text-xl font-semibold text-white mb-2">
            <span style={{ color: "#74b743" }}>LibreNMS</span> Dash
          </h1>
          <p className="text-gray-400 text-sm">Sign in to view the topology dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm text-gray-400 mb-1.5">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-md bg-gray-900 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm text-gray-400 mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-md bg-gray-900 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {isSubmitting ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <div className="mt-8 text-center text-[10px] text-gray-500">
          <span>© {new Date().getFullYear()} GPLv3</span>
          <span className="text-gray-700 mx-1">·</span>
          <a
            href="https://github.com/jaykumar2001/Librenms-dash"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-gray-300 transition-colors underline underline-offset-2"
          >
            GitHub
          </a>
        </div>
    </div>
  );
}
