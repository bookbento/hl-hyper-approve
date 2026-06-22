// useDraggable.ts
import { useEffect, useRef, type RefObject } from "react";

interface PosPct {
  xPct: number;
  yPct: number;
}

interface UseDragOpts {
  pageRef: RefObject<HTMLDivElement | null>;
  defaultPos: PosPct;
  onDragEnd: (pos: PosPct) => void;
  canvasKey: string;
}

// Draggable.tsx -----------------------------------------
export function useDraggable({
  pageRef,
  defaultPos,
  onDragEnd,
  canvasKey,
}: UseDragOpts) {
  const markerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = markerRef.current;
    const page = pageRef.current;
    if (!el || !page) return;

    const canvas = page.querySelector<HTMLCanvasElement>("canvas");
    if (!canvas) {
      const id = requestAnimationFrame(() => {
        onDragEnd({ xPct: defaultPos.xPct, yPct: defaultPos.yPct });
      });
      return () => cancelAnimationFrame(id);
    }

    el.style.left = `${(defaultPos.xPct / 100) * canvas.clientWidth}px`;
    el.style.top = `${(defaultPos.yPct / 100) * canvas.clientHeight}px`;

    /* ----------- dragging ------------- */
    let offsetX = 0,
      offsetY = 0;

    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      const rect = el.getBoundingClientRect();
      // ต่างจากกึ่งกลาง
      offsetX = e.clientX - (rect.left + rect.width / 2);
      offsetY = e.clientY - rect.top;
      el.setPointerCapture(e.pointerId);
    };

    const move = (e: PointerEvent) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const rect = canvas.getBoundingClientRect();

      const cx = e.clientX - rect.left - offsetX; // center-X
      const cy = e.clientY - rect.top - offsetY; // center-Y

      // clamp ให้ไม่หลุดผืน
      el.style.left = `${Math.min(rect.width, Math.max(0, cx))}px`;
      el.style.top = `${Math.min(rect.height, Math.max(0, cy))}px`;
    };

    const up = (e: PointerEvent) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.releasePointerCapture(e.pointerId);

      const rect = canvas.getBoundingClientRect();
      onDragEnd({
        xPct: (parseFloat(el.style.left) / rect.width) * 100,
        yPct: (parseFloat(el.style.top) / rect.height) * 100,
      });
    };

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
  }, [pageRef, defaultPos, onDragEnd, canvasKey]);

  return markerRef;
}
