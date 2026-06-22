// useStableSize.tsx
import { useLayoutEffect, useRef, useState, useCallback, type DependencyList } from "react";

interface RefLike<E extends HTMLElement> { current: E | null; }

export function useStableSize<E extends HTMLElement>(
  ref: RefLike<E>,
  deps: DependencyList = [],
  opts: { stableFrames?: number; minWidth?: number } = {}
) {
  const needStable = opts.stableFrames ?? 2;
  const minWidth = opts.minWidth ?? 200;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const rafRef = useRef<number | null>(null);
  const ticking = useRef(false);

  const measureNow = useCallback(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setSize({ width: Math.round(r.width), height: Math.round(r.height) });
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (typeof window === "undefined" || !el) return;

    let prevW = -1, prevH = -1, stable = 0;
    const settle = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);

      if (w < minWidth) { // ยังเล็กอยู่ -> รอต่อ
        stable = 0;
        rafRef.current = requestAnimationFrame(settle);
        return;
      }
      stable = (w === prevW && h === prevH) ? stable + 1 : 0;
      prevW = w; prevH = h;

      if (stable >= needStable) setSize({ width: w, height: h });
      else rafRef.current = requestAnimationFrame(settle);
    };
    // double rAF ให้ข้ามเฟรมแรก
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(settle);
    });

    let ro: ResizeObserver | null = null;
    if ("ResizeObserver" in window) {
      ro = new ResizeObserver((entries) => {
        if (ticking.current) return;
        ticking.current = true;
        requestAnimationFrame(() => {
          for (const entry of entries) {
            if (entry.target === el) {
              const { width, height } = entry.contentRect;
              if (width >= minWidth) {
                setSize({ width: Math.round(width), height: Math.round(height) });
              }
              break;
            }
          }
          ticking.current = false;
        });
      });
      ro.observe(el);
    }

    const onEnd = () => measureNow();
    el.addEventListener("transitionend", onEnd);

    if ((document as any).fonts?.ready) {
      (document as any).fonts.ready.then(measureNow);
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro?.disconnect();
      el.removeEventListener("transitionend", onEnd);
    };
  }, [ref, needStable, minWidth, measureNow, ...deps]);

  return { ...size, recalc: measureNow };
}
