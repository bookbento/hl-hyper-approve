// src/components/Marker.tsx

import React, { useRef } from "react";
import { X } from "lucide-react";
import { useDraggable } from "./Draggable";

const PAGE_WIDTH_PT = 595.28;

interface MarkerProps {
  pageRef: React.RefObject<HTMLDivElement | null>;
  pos: { fileIdx: number; pageInFile: number; x: number; y: number };
  onChange: (p: { x: number; y: number }) => void;
  onDelete?: () => void;
  text: string;
  pdfPt?: number;
  canvasKey: string;
  sizePct?: number;
  onResizeEnd: (newSizePct: number) => void;
  className?: string;
  style?: React.CSSProperties;
}

export const Marker: React.FC<MarkerProps> = ({
  pageRef,
  pos,
  onChange,
  onDelete,
  text,
  pdfPt = 16,
  canvasKey,
  sizePct = 100,
  onResizeEnd,
  className = "",
  style,
}) => {
  // drag
  const ref = useDraggable({
    pageRef,
    defaultPos: { xPct: pos.x, yPct: pos.y },
    onDragEnd: ({ xPct, yPct }) => onChange({ x: xPct, y: yPct }),
    canvasKey,
  }) as React.MutableRefObject<HTMLDivElement>;

  const frameRequested = useRef(false);
  const ProcessingPct = useRef(sizePct);

  // เก็บค่าตอนเริ่มลาก
  const startRef = useRef<{
    startX: number;
    startSize: number;
    startWidth: number;
  }>({
    startX: 0,
    startSize: sizePct,
    startWidth: 0,
  });

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    startRef.current = {
      startX: e.clientX,
      startSize: sizePct,
      startWidth: rect.width,
    };
    el.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startRef.current.startX;
      const rawPct =
    (startRef.current.startSize * (startRef.current.startWidth + dx)) /
    startRef.current.startWidth;
      // คำนวณขนาดใหม่แบบ proportional
      ProcessingPct.current = Math.max(20, Math.min(1000, rawPct));
      if (!frameRequested.current) {
        frameRequested.current = true;
        requestAnimationFrame(() => {
          onResizeEnd(ProcessingPct.current);
          frameRequested.current = false;
        });
      }
    };

    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // คำนวณขนาดฟอนต์จริงจาก pdfPt
  const canvasW = pageRef.current?.clientWidth ?? PAGE_WIDTH_PT;
  const basePx = pdfPt * (canvasW / PAGE_WIDTH_PT);
  const scale = sizePct / 100;

  return (
    <div
      ref={ref}
      style={{
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        position: "absolute",
        zIndex: 10,
        userSelect: "none",
        fontSize: basePx,
        fontFamily: "Allura",
        transform: `translate(-50%,0) scale(${scale})`,
        transformOrigin: "50% 0",
        border: "1px dashed #666",
        padding: "8px",
        willChange:      "transform",
        background: "rgba(0,0,0,0.04)",
        ...style,
      }}
      className={className}
    >
      {/* ลายเซ็น */}
      {typeof text === "string" && text.includes("T")
        ? text.slice(0, 10)
        : text}

      {/* รีไซส์ฮันเดิล */}
      <div
        onPointerDown={startResize}
        className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize bg-white border border-gray-400"
      />

      {/* ปุ่มลบ */}
      {onDelete && (
        <button
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute -top-2.5 -right-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500/90 text-white shadow-md hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-400"
        >
          <X className="h-3 w-3 stroke-[3]" />
        </button>
      )}
    </div>
  );
};
