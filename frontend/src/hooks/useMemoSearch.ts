import { useEffect, useMemo, useRef, useState } from "react";
import {
  searchMemos,
  isAbortError,
} from "../lib/api/memoSearch.api";
import type {
  SearchMemosRequest,
  SearchMemosResponse,
} from "../lib/api/memoSearch.types";

interface UseMemoSearchOptions {
  request: SearchMemosRequest;
  enabled?: boolean;       // for feature flag — when false, hook is inert
  debounceMs?: number;     // applied to all changes (default 350)
  immediateKeys?: (keyof SearchMemosRequest)[]; // changes to these fields skip debounce
}

interface UseMemoSearchResult {
  data: SearchMemosResponse | null;
  isLoading: boolean;     // true on first load
  isFetching: boolean;    // true any time a fetch is in-flight
  error: Error | null;
  refetch: () => void;
}

const DEFAULT_IMMEDIATE_KEYS: (keyof SearchMemosRequest)[] = [
  "page",
  "pageSize",
  "sortBy",
  "sortDir",
  "view",
  "status",
  "businessUnitId",
  "departmentId",
];

/**
 * Custom hook that fetches POST /api/memos/search with:
 *   - debounce (350ms default) for text-typing changes
 *   - immediate refetch for pagination / sort / view changes
 *   - AbortController to cancel stale in-flight requests
 *   - sequence number to ignore stale responses
 *   - retains previous data during refetch (no flicker)
 */
export function useMemoSearch({
  request,
  enabled = true,
  debounceMs = 350,
  immediateKeys = DEFAULT_IMMEDIATE_KEYS,
}: UseMemoSearchOptions): UseMemoSearchResult {
  const [data, setData] = useState<SearchMemosResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastImmediateRef = useRef<string>("");
  const refetchTickRef = useRef(0);
  const [refetchTick, setRefetchTick] = useState(0);

  const requestKey = useMemo(() => stableKey(request), [request]);

  // Detect if any immediate-key changed → skip debounce
  const immediateKey = useMemo(
    () =>
      JSON.stringify(
        immediateKeys.reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (request as Record<string, unknown>)[k as string];
          return acc;
        }, {})
      ),
    [request, immediateKeys]
  );
  const isImmediateChange = lastImmediateRef.current !== immediateKey;
  lastImmediateRef.current = immediateKey;

  useEffect(() => {
    if (!enabled) return;
    // refetchTick included so refetch() retriggers the effect
    void refetchTick;

    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsFetching(true);
    if (!data) setIsLoading(true);

    const delay = isImmediateChange ? 0 : debounceMs;

    const timer = window.setTimeout(async () => {
      try {
        const result = await searchMemos(request, controller.signal);
        if (seq !== seqRef.current) return; // stale
        setData(result);
        setError(null);
      } catch (e) {
        if (isAbortError(e)) return;
        if (seq !== seqRef.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (seq === seqRef.current) {
          setIsFetching(false);
          setIsLoading(false);
        }
      }
    }, delay);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled, debounceMs, refetchTick]);

  return {
    data,
    isLoading,
    isFetching,
    error,
    refetch: () => {
      refetchTickRef.current += 1;
      setRefetchTick(refetchTickRef.current);
    },
  };
}

// Stable JSON serialization with sorted keys — avoids spurious refetches
// when callers rebuild the request object with the same content but
// different key order.
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        if (obj[k] !== undefined) sorted[k] = obj[k];
      }
      return sorted;
    }
    return val;
  });
}
