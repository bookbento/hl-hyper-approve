// Popover.tsx
import { createPortal } from "react-dom";
import { useLayoutEffect, useState } from "react";

export function Popover({
  anchor, open, children,
}: {
  anchor: React.RefObject<HTMLElement>;
  open: boolean;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    // Use viewport-relative position for fixed positioning
    setPos({ top: r.top, left: r.right + 8 });
  }, [open, anchor]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed z-[10000] w-72 rounded-xl border border-gray-200 bg-white shadow-2xl"
      style={{ top: pos.top, left: pos.left }}
      role="dialog"
    >
      {children}
    </div>,
    document.body
  );
}
