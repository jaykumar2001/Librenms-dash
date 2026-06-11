import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { AssetEvent } from "@librenms-dash/shared";

const TOAST_DURATION_MS = 5_000;
const TOAST_GAP_MS = 1_500;
const MAX_QUEUE = 5;
const PAGE_SIZE = 25;

function eventColor(action: string) {
  return action === "added" ? "text-emerald-400" : "text-red-400";
}

function eventBg(action: string) {
  return action === "added" ? "bg-emerald-500" : "bg-red-500";
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
  const [toastVisible, setToastVisible] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [newCount, setNewCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const toastHovered = useRef(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inGap = useRef(false);

  const clearDismiss = useCallback(() => {
    if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null; }
  }, []);

  const dismissToast = useCallback(() => {
    clearDismiss();
    setToastVisible(false);
    setTimeout(() => {
      setToast(null);
      inGap.current = true;
      setTimeout(() => { inGap.current = false; }, TOAST_GAP_MS);
    }, 300);
  }, [clearDismiss]);

  const addEvents = useCallback((events: AssetEvent[]) => {
    setAllEvents(prev => [...prev, ...events].slice(-200));
    setNewCount(prev => prev + events.length);
    setQueue(prev => {
      const merged = [...prev, ...events];
      return merged.length > MAX_QUEUE ? merged.slice(-MAX_QUEUE) : merged;
    });
  }, []);

  // SSE connection
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
        if (events.length > 0) addEvents(events);
      } catch { /* ignore */ }
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => { es.close(); setConnected(false); };
  }, [addEvents]);

  // Show next toast from queue
  useEffect(() => {
    if (toast || queue.length === 0 || inGap.current || panelOpen) return;
    const next = queue[0];
    setQueue(prev => prev.slice(1));
    setToast(next);
    setToastVisible(true);
  }, [toast, queue, panelOpen]);

  // Auto-dismiss
  useEffect(() => {
    if (!toast || !toastVisible) return;
    if (toastHovered.current) return;
    clearDismiss();
    dismissTimer.current = setTimeout(dismissToast, TOAST_DURATION_MS);
    return clearDismiss;
  }, [toast, toastVisible, dismissToast, clearDismiss]);

  // Drain queue after gap
  useEffect(() => {
    if (toast || queue.length === 0) return;
    const id = setInterval(() => {
      if (!inGap.current) { clearInterval(id); setQueue(prev => [...prev]); }
    }, 200);
    return () => clearInterval(id);
  }, [toast, queue]);

  const handleToastEnter = useCallback(() => { toastHovered.current = true; clearDismiss(); }, [clearDismiss]);
  const handleToastLeave = useCallback(() => {
    toastHovered.current = false;
    if (toast && toastVisible) dismissTimer.current = setTimeout(dismissToast, TOAST_DURATION_MS);
  }, [toast, toastVisible, dismissToast]);

  const handleToastClick = useCallback(() => {
    clearDismiss();
    setToastVisible(false);
    setTimeout(() => setToast(null), 300);
    setPanelOpen(true);
    setNewCount(0);
    setPage(0);
  }, [clearDismiss]);

  const togglePanel = useCallback(() => {
    setPanelOpen(prev => {
      if (!prev) { setNewCount(0); setPage(0); }
      return !prev;
    });
  }, []);

  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!panelOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [panelOpen]);

  // Pagination
  const reversed = useMemo(() => [...allEvents].reverse(), [allEvents]);
  const totalPages = Math.max(1, Math.ceil(reversed.length / PAGE_SIZE));
  const pageEvents = useMemo(() => reversed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [reversed, page]);

  const lastEvent = allEvents.length > 0 ? allEvents[allEvents.length - 1] : null;
  const recentEvent = lastEvent && (Date.now() - new Date(lastEvent.timestamp).getTime() < 5 * 60 * 1000) ? lastEvent : null;

  return (
    <>
      {/* Toast — slides in above the bar */}
      {toast && (
        <div
          className={`absolute bottom-14 right-2 z-30 max-w-[340px] cursor-pointer transition-all duration-300 ease-out ${
            toastVisible ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"
          }`}
          onMouseEnter={handleToastEnter}
          onMouseLeave={handleToastLeave}
          onClick={handleToastClick}
        >
          <div className="bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg px-3 py-2 shadow-lg flex items-start gap-2">
            <span className={`font-mono font-bold text-sm leading-none mt-0.5 ${eventColor(toast.action)}`}>
              {toast.action === "added" ? "+" : "−"}
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

      {/* Bar + panel wrapper — single column anchored at bottom-right */}
      <div ref={wrapperRef} className="absolute bottom-7 right-2 z-20 flex flex-col items-end">
        {/* Expanded event log panel — grows upward from bar */}
        <div
          className={`w-[500px] transition-all duration-300 ease-out origin-bottom overflow-hidden ${
            panelOpen ? "max-h-[460px] opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          <div className="bg-gray-900/98 backdrop-blur border border-gray-700 border-b-0 rounded-t-lg shadow-2xl flex flex-col" style={{ height: 420 }}>
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 shrink-0">
              <span className="text-xs font-semibold text-gray-300">
                Asset Change Log
                <span className="text-gray-500 ml-1.5 font-normal">{allEvents.length} total</span>
              </span>
              <button
                onClick={() => setPanelOpen(false)}
                className="text-gray-500 hover:text-gray-200 text-sm leading-none px-1"
              >&times;</button>
            </div>
            <div className="overflow-y-auto flex-1">
              {allEvents.length === 0 ? (
                <div className="p-6 text-center text-xs text-gray-500">No events yet — changes will appear after the next poll cycle.</div>
              ) : (
                <table className="w-full text-[11px] border-collapse">
                  <thead className="sticky top-0 bg-gray-900/95 backdrop-blur">
                    <tr>
                      <th className="py-1.5 px-2 text-left text-gray-500 font-semibold">Time</th>
                      <th className="py-1.5 px-2 text-left text-gray-500 font-semibold w-16">Action</th>
                      <th className="py-1.5 px-2 text-left text-gray-500 font-semibold">Category</th>
                      <th className="py-1.5 px-2 text-left text-gray-500 font-semibold">Asset</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageEvents.map((e) => (
                      <tr key={e.id} className="border-t border-gray-800/60 hover:bg-gray-800/40 transition-colors">
                        <td className="py-1 px-2 text-gray-500 whitespace-nowrap font-mono">{formatTs(e.timestamp)}</td>
                        <td className="py-1 px-2 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1 ${eventColor(e.action)}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${eventBg(e.action)}`} />
                            {e.action}
                          </span>
                        </td>
                        <td className="py-1 px-2 text-gray-400 whitespace-nowrap capitalize">{e.category}</td>
                        <td className="py-1 px-2 text-gray-300 truncate max-w-[180px]" title={e.asset}>{e.asset}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-3 py-1.5 border-t border-gray-700 shrink-0 text-[10px] text-gray-400">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-default transition-colors"
                >Newer</button>
                <span>Page {page + 1} / {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-default transition-colors"
                >Older</button>
              </div>
            )}
          </div>
        </div>

        {/* Persistent floating bar — always at the bottom of this wrapper */}
        <button
          onClick={togglePanel}
          className={`flex items-center gap-2 bg-gray-900/90 backdrop-blur border border-gray-700 px-2.5 py-1 text-[10px] transition-all duration-200 hover:bg-gray-800/90 ${
            panelOpen ? "w-[500px] rounded-b-lg rounded-t-none border-t-gray-800" : "rounded-lg"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${connected ? "bg-emerald-500" : "bg-gray-600"}`} />
          <span className="text-gray-400">
            {recentEvent
              ? <><span className="capitalize">{recentEvent.category}</span> <span className={eventColor(recentEvent.action)}>{recentEvent.action}</span></>
              : allEvents.length === 0
                ? "No events"
                : `${allEvents.length} events`
            }
          </span>
          {newCount > 0 && !panelOpen && (
            <span className="bg-blue-600 text-white text-[9px] font-bold rounded-full px-1.5 py-0 leading-relaxed animate-pulse">
              {newCount}
            </span>
          )}
          <span className={`text-gray-600 text-[9px] ml-auto transition-transform duration-200 ${panelOpen ? "rotate-180" : ""}`}>
            &#9650;
          </span>
        </button>
      </div>
    </>
  );
}
