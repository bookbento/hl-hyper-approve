import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "framer-motion";

type Props = {
  to: number;
  /** seconds */
  duration?: number;
  className?: string;
};

/**
 * Number that counts from its previous value to `to` (React Bits "CountUp").
 * Writes textContent directly, so the parent doesn't re-render every frame.
 */
export default function CountUp({ to, duration = 0.9, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) {
      el.textContent = to.toLocaleString();
      from.current = to;
      return;
    }
    const controls = animate(from.current, to, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        el.textContent = Math.round(v).toLocaleString();
      },
    });
    from.current = to;
    return () => controls.stop();
  }, [to, duration, reduce]);

  return (
    <span ref={ref} className={["tabular-nums", className].filter(Boolean).join(" ")}>
      {reduce ? to.toLocaleString() : "0"}
    </span>
  );
}
