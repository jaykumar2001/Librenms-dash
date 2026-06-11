import { useState, useEffect, useRef, useCallback } from "react";
import type { AssetEvent } from "@librenms-dash/shared";
import { fetchEvents } from "@/lib/api";

const POLL_MS = 30_000;
const TOAST_DURATION_MS = 5_000;
const TOAST_GAP_MS = 1_500;
const MAX_QUEUE = 5;

function eventIcon(action: string) {
  return action === "added" ? "+" : "-";
}

function eventColor(action: string) {
  return action === "added" ? "text-emerald-400" : "text-red-400";
}

function formatTs(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

export function AssetEventToast() {
  const [allEvents, setAllEvents] = useState<AssetEvent[]>([]);
  const [queue, setQueue] = useState<AssetEvent[]>([]);
  const [toast, setToast] = useState<AssetEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const hovered = useRef(false);
  const lastSeenId = useRef(0);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inGap = useRef(false);

  const clearDismiss = useCallback(() => {
    if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null; }
  }, []);

  const dismissToast = useCallback(() => {
    clearDismiss();
    setVisible(false);
    setTimeout(() => {
      setToast(null);
      inGap.current = true;
      gapTimer.current = setTimeout(() => { inGap.current = false; }, TOAST_GAP_MS);
    }, 300);
  }, [clearDismiss]);

  // Poll backend for new events
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const { events } = await fetchEvents(lastSeenId.current);
        if (!mounted || events.length === 0) return;
        lastSeenId.current = events[events.length - 1].id;
        setAllEvents(prev => [...prev, ...events].slice(-200));
        setQueue(prev => {
          const merged = [...prev, ...events];
          if (merged.length > MAX_QUEUE) {
            return merged.slice(-MAX_QUEUE);
          }
          return merged;
        });
      } catch { /* ignore fetch errors */ }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  // Show next toast from queue
  useEffect(() => {
    if (toast || queue.length === 0 || inGap.current) return;
    const next = queue[0];
    setQueue(prev => prev.slice(1));
    setToast(next);
    setVisible(true);
  }, [toast, queue]);

  // Auto-dismiss timer — restarts when toast changes or hover state changes
  useEffect(() => {
    if (!toast || !visible) return;
    if (hovered.current) return;
    clearDismiss();
    dismissTimer.current = setTimeout(dismissToast, TOAST_DURATION_MS);
    return clearDismiss;
  }, [toast, visible, dismissToast, clearDismiss]);

  // Retry showing next toast after gap
  useEffect(() => {
    if (toast || queue.length === 0) return;
    const id = setInterval(() => {
      if (!inGap.current) {
        clearInterval(id);
        setQueue(prev => [...prev]);
      }
    }, 200);
    return () => clearInterval(id);
  }, [toast, queue]);

  const handleMouseEnter = useCallback(() => {
    hovered.current = true;
    clearDismiss();
  }, [clearDismiss]);

  const handleMouseLeave = useCallback(() => {
    hovered.current = false;
    if (toast && visible) {
      dismissTimer.current = setTimeout(dismissToast, TOAST_DURATION_MS);
    }
  }, [toast, visible, dismissToast]);

  const handleToastClick = useCallback(() => {
    clearDismiss();
    setVisible(false);
    setTimeout(() => setToast(null), 300);
    setLogOpen(true);
  }, [clearDismiss]);

  return (
    <>
      {/* Toast */}
      {toast && (
        <div
          className={`absolute bottom-8 right-2 z-20 max-w-[340px] cursor-pointer transition-all duration-300 ease-out ${
            visible ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"
          }`}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={handleToastClick}
        >
          <div className="bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg px-3 py-2 shadow-lg flex items-start gap-2">
            <span className={`font-mono font-bold text-sm leading-none mt-0.5 ${eventColor(toast.action)}`}>
              {eventIcon(toast.action)}
            </span>
            <div className="min-w-0">
              <div className="text-[11px] text-gray-300 leading-snug truncate">
                <span className="text-gray-500 capitalize">{toast.category}</span>{" "}
                <span className={eventColor(toast.action)}>{toast.action}</span>
              </div>
              <div className="text-[11px] text-gray-400 leading-snug truncate" title={toast.asset}>
                {toast.asset}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Event count badge — click to open log */}
      {allEvents.length > 0 && !logOpen && (
        <button
          onClick={() => setLogOpen(true)}
          className="absolute bottom-8 right-2 z-20 bg-gray-900/90 backdrop-blur border border-gray-700 rounded-full px-2 py-0.5 text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
          style={toast ? { display: "none" } : undefined}
          title="Asset change log"
        >
          {allEvents.length} event{allEvents.length !== 1 ? "s" : ""}
        </button>
      )}

      {/* Full event log panel */}
      {logOpen && (
        <div className="absolute bottom-8 right-2 z-30 w-[460px] max-h-[420px] bg-gray-900/98 backdrop-blur border border-gray-700 rounded-lg shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
            <span className="text-xs font-semibold text-gray-300">Asset Change Log ({allEvents.length})</span>
            <button
              onClick={() => setLogOpen(false)}
              className="text-gray-500 hover:text-gray-200 text-sm leading-none px-1"
            >
              &times;
            </button>
          </div>
          <div className="overflow-y-auto flex-1 scrollbar-thin">
            {allEvents.length === 0 ? (
              <div className="p-4 text-center text-xs text-gray-500">No events yet</div>
            ) : (
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-gray-900">
                  <tr>
                    <th className="py-1 px-2 text-left text-gray-500 font-semibold">Time</th>
                    <th className="py-1 px-2 text-left text-gray-500 font-semibold">Action</th>
                    <th className="py-1 px-2 text-left text-gray-500 font-semibold">Category</th>
                    <th className="py-1 px-2 text-left text-gray-500 font-semibold">Asset</th>
                  </tr>
                </thead>
                <tbody>
                  {[...allEvents].reverse().map((e) => (
                    <tr key={e.id} className="border-t border-gray-800 hover:bg-gray-800/50">
                      <td className="py-1 px-2 text-gray-500 whitespace-nowrap font-mono">{formatTs(e.timestamp)}</td>
                      <td className={`py-1 px-2 whitespace-nowrap font-semibold ${eventColor(e.action)}`}>
                        {e.action}
                      </td>
                      <td className="py-1 px-2 text-gray-400 whitespace-nowrap capitalize">{e.category}</td>
                      <td className="py-1 px-2 text-gray-300 break-all max-w-[200px]" title={e.asset}>{e.asset}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  );
}
