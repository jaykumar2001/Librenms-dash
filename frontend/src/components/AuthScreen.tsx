import type { ReactNode } from "react";

/** Full-viewport shell for auth flows — uses screen size, not persisted layout/zoom. */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-gray-950 overflow-auto p-4">
      {children}
    </div>
  );
}
