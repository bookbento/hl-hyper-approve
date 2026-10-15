// Short-lived GET cache + in-flight de-duplication for a few read-mostly endpoints.
//
// /api/me is requested from ~11 components, business units / departments from
// 5–6 pages, and the memo page asked for the same /api/users/basic-info three
// times in parallel. Instead of rewriting each call site, the axios adapter
// serves those from memory: concurrent identical GETs share one request, and a
// fresh copy is reused for a short time (same idea as malinmarket's
// SlotStatusCache: TTL + single in-flight promise).
//
// Any successful non-GET request clears the whole cache, so an edit (profile,
// BU, department, login/logout…) is visible on the next read. A page reload
// starts empty. Pass `{ cache: false }` in the request config to bypass it.
import axios from "axios";
import type {
  AxiosAdapter,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

declare module "axios" {
  interface AxiosRequestConfig {
    /** false = never serve this GET from the in-memory cache */
    cache?: boolean;
  }
}

type Rule = { path: string; ttlMs: number };

const RULES: Rule[] = [
  { path: "/api/me", ttlMs: 30_000 },
  { path: "/api/business-units", ttlMs: 5 * 60_000 },
  { path: "/api/departments", ttlMs: 5 * 60_000 },
  { path: "/api/users/basic-info", ttlMs: 60_000 },
];

type Entry = { at: number; response: AxiosResponse };

const fresh = new Map<string, Entry>();
const inFlight = new Map<string, Promise<AxiosResponse>>();

export function clearHttpCache(): void {
  fresh.clear();
}

function resolveUrl(config: InternalAxiosRequestConfig): URL | null {
  try {
    const base = config.baseURL || window.location.origin;
    return new URL(config.url ?? "", base.endsWith("/") ? base : `${base}/`);
  } catch {
    return null;
  }
}

function sortedParams(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const obj = params as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(obj)
      .sort()
      .map((k) => [k, obj[k]])
  );
}

function cacheKey(config: InternalAxiosRequestConfig, url: URL): string {
  return `${url.pathname}?${url.search}|${sortedParams(config.params)}`;
}

/** Each caller gets its own copy: some pages sort/mutate response arrays in place. */
function copyFor(entry: AxiosResponse, config: InternalAxiosRequestConfig): AxiosResponse {
  return { ...entry, data: structuredClone(entry.data), config };
}

function withCache(adapter: AxiosAdapter): AxiosAdapter {
  return async (config) => {
    const method = (config.method ?? "get").toLowerCase();

    if (method !== "get") {
      const res = await adapter(config);
      clearHttpCache();
      return res;
    }

    const url = config.cache === false ? null : resolveUrl(config);
    const rule = url && RULES.find((r) => r.path === url.pathname);
    if (!url || !rule) return adapter(config);

    const key = cacheKey(config, url);
    const hit = fresh.get(key);
    if (hit && Date.now() - hit.at < rule.ttlMs) return copyFor(hit.response, config);

    let pending = inFlight.get(key);
    if (!pending) {
      pending = adapter(config).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      pending
        .then((res) => {
          if (res.status >= 200 && res.status < 300) fresh.set(key, { at: Date.now(), response: res });
        })
        .catch(() => {});
    }
    return copyFor(await pending, config);
  };
}

export function installHttpCache(instance: AxiosInstance): void {
  const base = axios.getAdapter(instance.defaults.adapter);
  instance.defaults.adapter = withCache(base);
}
