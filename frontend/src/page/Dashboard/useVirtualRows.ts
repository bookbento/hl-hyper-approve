import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";

/**
 * Virtual list for the dashboard rows (table or cards). It follows the nearest
 * scrolling ancestor (the app layout scrolls inside <main>, not the window).
 *
 * Only the rows near the viewport are mounted (~20-40), so "All" with thousands
 * of memos costs the same DOM as a normal page. Rows keep their real, variable
 * height (approver lists expand) via measureElement.
 *
 * Rows play a short slide/fade (React Bits AnimatedList feel) when they mount,
 * i.e. on first paint and as they scroll into view, but not during a fast fling
 * where it would only flicker.
 */
type Options = {
  count: number;
  getKey: (index: number) => number | string;
  /** rough row height before it is measured */
  estimateSize: number;
  /** changes when the row set is replaced (new page / filter): decided again, and swapped in without animation */
  resetKey: unknown;
  /** the element that holds the rows (tbody / card list) */
  listRef: RefObject<HTMLElement | null>;
  overscan?: number;
};

type RowKey = VirtualItem["key"];
export type Enter = { className: string; style: CSSProperties | undefined };

const NO_ENTER: Enter = { className: "", style: undefined };
const FAST_PX_PER_MS = 1.5;

export function scrollParentOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    // must really overflow: overflow-x:auto wrappers compute overflow-y:auto too but
    // never scroll vertically. Re-checked every render, so once the list grows the
    // real scroller (<main>) is picked up.
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

export function useVirtualRows({ count, getKey, estimateSize, resetKey, listRef: listEl, overscan = 8 }: Options) {
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Where the list starts in the page. Content above it (stat cards, active
  // filter chips) can change height, so re-check after every render (one rect read).
  // Runs after every render on purpose; the >1px guard stops it from looping.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = listEl.current;
    if (!el) return;
    // Keep a real scroller once found (no flip back to the document when the list is
    // momentarily short, no ancestor walk on every scroll render); only search while
    // we are still on the document fallback.
    const cached =
      scrollEl && scrollEl !== document.documentElement && scrollEl !== document.scrollingElement && scrollEl.contains(el)
        ? scrollEl
        : null;
    const parent = cached ?? scrollParentOf(el);
    if (parent !== scrollEl) setScrollEl(parent);
    const top = el.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop;
    if (Math.abs(top - scrollMargin) > 1) setScrollMargin(top);
  });

  const virtualizer = useVirtualizer({
    getScrollElement: () => scrollEl,
    count,
    estimateSize: () => estimateSize,
    overscan,
    scrollMargin,
    getItemKey: getKey,
  });

  // Scroll speed, to skip the enter animation while flinging.
  const scroll = useRef({ y: 0, t: 0, speed: 0 });
  useEffect(() => {
    if (!scrollEl) return;
    scroll.current = { y: scrollEl.scrollTop, t: performance.now(), speed: 0 };
    const onScroll = () => {
      const now = performance.now();
      const s = scroll.current;
      s.speed = Math.abs(scrollEl.scrollTop - s.y) / Math.max(1, now - s.t);
      s.y = scrollEl.scrollTop;
      s.t = now;
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [scrollEl]);

  // Enter decision per mounted row: fixed while it stays mounted, fresh when it
  // scrolls back in. Reset with the row set so a new page staggers in again.
  const decided = useRef(new Map<RowKey, Enter>());
  const scrolledSinceReset = useRef(false);
  const lastReset = useRef<unknown>(resetKey);
  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    decided.current = new Map();
    scrolledSinceReset.current = false;
  }

  const items: VirtualItem[] = virtualizer.getVirtualItems();

  // forget rows that are no longer mounted
  const mounted = new Set(items.map((it) => it.key));
  for (const key of decided.current.keys()) {
    if (!mounted.has(key)) decided.current.delete(key);
  }

  const enterFor = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (key: RowKey, _index: number): Enter => {
      const known = decided.current.get(key);
      if (known) return known;
      const s = scroll.current;
      const recentlyScrolled = performance.now() - s.t < 150;
      if (recentlyScrolled) scrolledSinceReset.current = true;
      let enter: Enter;
      if (!scrolledSinceReset.current || (recentlyScrolled && s.speed > FAST_PX_PER_MS)) {
        // A new row set (filter, page, view) swaps in instantly: staggering it in from
        // transparent blanked the table on every click. Only rows scrolled into view slide in.
        enter = NO_ENTER;
      } else {
        enter = { className: "animate-rb-row-in-lite", style: undefined };
      }
      decided.current.set(key, enter);
      return enter;
    },
    []
  );

  const last = items[items.length - 1];
  const padTop = items.length ? items[0].start - scrollMargin : 0;
  const padBottom = last ? virtualizer.getTotalSize() - (last.end - scrollMargin) : 0;

  return {
    virtualizer,
    items,
    padTop: Math.max(0, padTop),
    padBottom: Math.max(0, padBottom),
    measureRef: virtualizer.measureElement,
    enterFor,
  };
}
