import { useCallback, useEffect, useRef } from "react";
import { animate, motionValue, useReducedMotion, type MotionValue } from "framer-motion";

/**
 * Jelly selection physics for a grid of cards, adapted from React Bits' JellyRadio
 * (David Haz, MIT + Commons Clause, see components/reactbits/LICENSE.md).
 *
 * The chosen card swells (wide before tall), the cards beside it in the same grid row
 * are shoved aside with a stagger, and everything springs back when the choice moves.
 * The grid itself is untouched: only transforms on each card's wrapper.
 */
export type JellyMV = { x: MotionValue<number>; scaleX: MotionValue<number>; scaleY: MotionValue<number> };

type Options = {
  swell?: number;
  barge?: number;
  jelly?: number;
  bounce?: number;
  stagger?: number;
  stiffness?: number;
};

const spring = (k: number, m: number, bounce: number) => ({
  type: "spring" as const,
  stiffness: k,
  damping: 2 * Math.sqrt(k * m) * (1 - bounce),
  mass: m,
});

export function useJellyGroup(
  count: number,
  selected: number,
  { swell = 0.05, barge = 4, jelly = 1, bounce = 0.3, stagger = 30, stiffness = 520 }: Options = {}
) {
  const reduce = useReducedMotion();
  const groupEl = useRef<HTMLDivElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const mvs = useRef<JellyMV[]>([]);
  const applied = useRef<number | null>(null);
  const cfg = useRef({ swell, barge, jelly, bounce, stagger, stiffness, reduce, count });
  cfg.current = { swell, barge, jelly, bounce, stagger, stiffness, reduce, count };

  const mvFor = useCallback((i: number): JellyMV => {
    let mv = mvs.current[i];
    if (!mv) {
      mv = { x: motionValue(0), scaleX: motionValue(1), scaleY: motionValue(1) };
      mvs.current[i] = mv;
    }
    return mv;
  }, []);

  const apply = useCallback(
    (sel: number, instant: boolean) => {
      const C = cfg.current;
      const kids = Array.from(groupEl.current?.children ?? []) as HTMLElement[];
      const selEl = sel >= 0 ? kids[sel] : undefined;
      // offsetTop/offsetWidth ignore transforms, so mid-animation measurements stay stable
      const row = selEl?.offsetTop;
      const push = selEl ? (selEl.offsetWidth * C.swell) / 2 + C.barge : 0;

      for (let i = 0; i < C.count; i++) {
        const mv = mvFor(i);
        const on = i === sel;
        const sameRow = selEl !== undefined && kids[i]?.offsetTop === row;
        const x = sameRow && !on ? Math.sign(i - sel) * push : 0;
        const s = on ? 1 + C.swell : 1;

        if (instant || C.reduce) {
          mv.x.jump(x);
          mv.scaleX.jump(s);
          mv.scaleY.jump(s);
          continue;
        }
        const far = sameRow ? Math.abs(i - sel) : 0;
        const k = C.stiffness * (1 - 0.12 * Math.min(far, 3));
        const inFlight = mv.x.isAnimating() || mv.scaleX.isAnimating() || mv.scaleY.isAnimating();
        const delay = inFlight ? 0 : (far * C.stagger) / 1000;
        const j = C.jelly;
        animate(mv.x, x, { ...spring(k, 0.9, C.bounce), delay });
        animate(mv.scaleX, s, {
          ...spring(k * (1 + 0.24 * j), 0.9 - 0.1 * j, Math.min(0.85, C.bounce + 0.3 * j)),
          delay,
        });
        animate(mv.scaleY, s, { ...spring(k * (1 - 0.14 * j), 0.9 + 0.05 * j, C.bounce), delay: delay + 0.05 * j });
      }
    },
    [mvFor]
  );

  // The grid may mount later than this hook (e.g. after a loading screen), so attach via a
  // callback ref: snap into place on mount and on every relayout (breakpoints re-flow rows).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const groupRef = useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      groupEl.current = el;
      if (!el) return;
      const settle = () => apply(applied.current ?? selectedRef.current, true);
      applied.current = selectedRef.current;
      settle();
      observer.current = new ResizeObserver(settle);
      observer.current.observe(el);
    },
    [apply]
  );

  // Selection changes: animate.
  useEffect(() => {
    if (applied.current === selected) return;
    applied.current = selected;
    apply(selected, false);
  }, [selected, apply]);

  useEffect(() => {
    const all = mvs.current;
    return () => {
      observer.current?.disconnect();
      all.forEach((mv) => {
        mv.x.destroy();
        mv.scaleX.destroy();
        mv.scaleY.destroy();
      });
    };
  }, []);

  return { groupRef, mvFor };
}
