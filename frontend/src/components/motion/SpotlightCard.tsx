import { useRef } from "react";
import type { ButtonHTMLAttributes, CSSProperties, MouseEvent, ReactNode } from "react";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  children: ReactNode;
  /** colour of the light that follows the cursor (any CSS colour) */
  spotlightColor?: string;
};

/**
 * Card with a soft radial light that follows the pointer (React Bits
 * "SpotlightCard" idea). Pure CSS variables — no re-render on mouse move.
 */
export default function SpotlightCard({
  children,
  spotlightColor = "rgb(126 240 194 / 0.22)",
  className = "",
  style,
  onMouseMove,
  ...rest
}: Props) {
  const ref = useRef<HTMLButtonElement>(null);

  const handleMove = (e: MouseEvent<HTMLButtonElement>) => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--spot-x", `${e.clientX - r.left}px`);
      el.style.setProperty("--spot-y", `${e.clientY - r.top}px`);
    }
    onMouseMove?.(e);
  };

  return (
    <button
      ref={ref}
      onMouseMove={handleMove}
      style={{ ...style, "--spot-color": spotlightColor } as CSSProperties}
      className={[
        "group/spot relative isolate overflow-hidden text-left",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:opacity-0",
        "before:transition-opacity before:duration-300 hover:before:opacity-100",
        "before:bg-[radial-gradient(260px_circle_at_var(--spot-x,50%)_var(--spot-y,50%),var(--spot-color),transparent_70%)]",
        className,
      ].join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
