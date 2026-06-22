export const MEMO_DASHBOARD_REFRESH_EVENT = "hl:memo-dashboard-refresh";

type MemoDashboardRefreshPayload = {
  ts: number;
  sourceId: string;
  reason?: string;
  method?: string;
  url?: string;
};

const STORAGE_KEY = "hl:memo-dashboard-refresh";
const sourceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    channel = null;
    return channel;
  }
  channel = new BroadcastChannel(MEMO_DASHBOARD_REFRESH_EVENT);
  return channel;
}

export function broadcastMemoDashboardRefresh(
  detail: Omit<MemoDashboardRefreshPayload, "ts" | "sourceId"> = {}
) {
  if (typeof window === "undefined") return;

  const payload: MemoDashboardRefreshPayload = {
    ...detail,
    ts: Date.now(),
    sourceId,
  };

  window.dispatchEvent(
    new CustomEvent<MemoDashboardRefreshPayload>(MEMO_DASHBOARD_REFRESH_EVENT, {
      detail: payload,
    })
  );

  try {
    getChannel()?.postMessage(payload);
  } catch {
    // ignore cross-tab notification failures
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage fallback failures
  }
}

export function subscribeMemoDashboardRefresh(
  handler: (payload: MemoDashboardRefreshPayload) => void
): () => void {
  if (typeof window === "undefined") return () => {};

  const onLocalEvent = (event: Event) => {
    const payload = (event as CustomEvent<MemoDashboardRefreshPayload>).detail;
    if (payload) handler(payload);
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const payload = JSON.parse(event.newValue) as MemoDashboardRefreshPayload;
      if (payload.sourceId !== sourceId) handler(payload);
    } catch {
      // ignore malformed storage payloads
    }
  };

  const bc = getChannel();
  const onMessage = (event: MessageEvent<MemoDashboardRefreshPayload>) => {
    const payload = event.data;
    if (payload?.sourceId !== sourceId) handler(payload);
  };

  window.addEventListener(MEMO_DASHBOARD_REFRESH_EVENT, onLocalEvent);
  window.addEventListener("storage", onStorage);
  bc?.addEventListener("message", onMessage);

  return () => {
    window.removeEventListener(MEMO_DASHBOARD_REFRESH_EVENT, onLocalEvent);
    window.removeEventListener("storage", onStorage);
    bc?.removeEventListener("message", onMessage);
  };
}
