// src/components/Marker.tsx
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDraggable } from "./Draggable";

// ✅ ใช้เป็น fallback เท่านั้น (ถ้าไม่ได้ส่ง/ไม่ได้หา pageWidthPt ได้)
const FALLBACK_PAGE_WIDTH_PT = 595.28;

interface MarkerProps {
  pageRef: React.RefObject<HTMLDivElement | null>;
  pos: { fileIdx: number; pageInFile: number; x: number; y: number }; // x,y เป็น %
  onChange: (p: { x: number; y: number }) => void;
  onDelete?: () => void;
  text: string;
  imgSrc?: string;
  /** ถ้าไม่ส่งมา จะใช้ค่า default ตามชนิดให้ตรงกับ backend: sig=16, date=12, memonumber=14 */
  pdfPt?: number;
  canvasKey: string;

  /** ขนาด marker (เปอร์เซ็นต์) */
  sizePct?: number;
  /** callback ตอนจบการ resize */
  onResizeEnd: (newSizePct: number) => void;

  className?: string;
  style?: React.CSSProperties;

  /** แยกชนิดเพื่อเลือกฟอนต์และขนาด */
  kind?: "signature" | "date" | "memonumber" | "note";

  /** ฟอนต์ฝั่งหน้าเว็บ (ควรโหลด Prompt/Sarabun/GreatVibes ไว้) */
  fontSig?: string;
  fontDate?: string;
  fontMemo?: string;
  fontNote?: string;
}

const toNum = (v?: string | null) => {
  if (!v) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export const Marker: React.FC<MarkerProps> = ({
  pageRef,
  pos,
  onChange,
  onDelete,
  text,
  imgSrc,
  pdfPt,
  canvasKey,
  sizePct = 100,
  onResizeEnd,
  className = "",
  style,
  kind = "signature",
  // ✅ ให้ date และ memonumber ใช้ฟอนต์เดียวกันกับที่ backend ใช้วาด (Prompt/สำรอง Sarabun)
  fontSig = "Allura, 'Great Vibes', cursive",
  fontDate = "Prompt, Sarabun, Inter, Arial, sans-serif",
  fontMemo = "Prompt, Sarabun, Inter, Arial, sans-serif",
  fontNote = "Prompt, Sarabun, Inter, Arial, sans-serif",
}) => {
  // ✅ drag ทำงานด้วย % (xPct/yPct) เหมือนเดิม
  const outerRef = useDraggable({
    pageRef,
    defaultPos: { xPct: pos.x, yPct: pos.y },
    onDragEnd: ({ xPct, yPct }) => onChange({ x: xPct, y: yPct }),
    canvasKey,
  }) as React.MutableRefObject<HTMLDivElement | null>;

  // ✅ ตั้งค่า point-size ให้ตรง backend ถ้าไม่ส่ง pdfPt มา
  const DEFAULT_PT: Record<NonNullable<MarkerProps["kind"]>, number> = {
    signature: 16,
    date: 12,
    memonumber: 14,
    note: 12,
  };
  const effectivePt = pdfPt ?? DEFAULT_PT[kind];

  // ✅ ทำให้ resize “เห็นผลทันที” (ไม่ต้องรอ parent setState)
  const [liveSizePct, setLiveSizePct] = useState(sizePct);
  const liveSizeRef = useRef(sizePct);
  useEffect(() => {
    setLiveSizePct(sizePct);
    liveSizeRef.current = sizePct;
  }, [sizePct]);

  const scale = liveSizePct / 100;

  // ✅ วัดความกว้างของ “canvas จริง” + อ่าน pageWidthPt (ถ้ามี) เพื่อเลิกผูกกับ A4 ตายตัว
  const [canvasCssW, setCanvasCssW] = useState<number | null>(null);
  const [pageWidthPt, setPageWidthPt] = useState<number>(FALLBACK_PAGE_WIDTH_PT);

  useLayoutEffect(() => {
    let ro: ResizeObserver | null = null;
    let raf = 0;

    const host = pageRef.current;
    if (!host) return;

    const tryAttach = () => {
      const canvas = host.querySelector("canvas") as HTMLCanvasElement | null;

      if (!canvas) {
        raf = window.requestAnimationFrame(tryAttach);
        return;
      }

      const measure = () => {
        const r = canvas.getBoundingClientRect();
        const w = r.width || host.getBoundingClientRect().width || host.clientWidth;
        setCanvasCssW(w > 0 ? w : null);

        // รองรับการใส่ค่าไว้ที่ canvas หรือ wrapper เช่น data-page-width-pt="612"
        const wPt =
          toNum(canvas.dataset.pageWidthPt) ||
          toNum(canvas.getAttribute("data-page-width-pt")) ||
          toNum(host.dataset.pageWidthPt) ||
          toNum(host.getAttribute("data-page-width-pt"));

        setPageWidthPt(Number.isFinite(wPt) && wPt > 0 ? wPt : FALLBACK_PAGE_WIDTH_PT);
      };

      measure();
      ro = new ResizeObserver(measure);
      ro.observe(canvas);
      ro.observe(host);
    };

    tryAttach();

    return () => {
      if (ro) ro.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [canvasKey, pos.fileIdx, pos.pageInFile, pageRef]);

  // ✅ แปลง point (backend) → px (frontend) โดยอิง "canvas ที่ render จริง"
  // ใช้ A4 reference width (FALLBACK_PAGE_WIDTH_PT) เสมอ เพื่อให้ marker มีขนาด pixel เท่ากันทุกหน้า
  // Backend จะใช้ pageScaleFactor ชดเชยให้ signature/date มีสัดส่วนเท่ากันใน PDF output
  const basePx = (() => {
    const w = canvasCssW ?? pageRef.current?.getBoundingClientRect().width ?? 0;
    if (!w || w <= 0) return effectivePt; // fallback กันกระพริบตอนแรก
    return effectivePt * (w / FALLBACK_PAGE_WIDTH_PT);
  })();

  const startRef = useRef<{
    startX: number;
    startSize: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);

  const innerRef = useRef<HTMLDivElement>(null);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();

    const el = innerRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const startWidth = Math.max(1, rect.width);

    startRef.current = {
      startX: e.clientX,
      startSize: liveSizeRef.current,
      startWidth,
      pointerId: e.pointerId,
    };

    // จับ pointer ไว้ที่ “handle” เพื่อกันหลุด
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const s = startRef.current;
      if (!s) return;
      const dx = ev.clientX - s.startX;

      const next = Math.max(
        20,
        Math.min(300, s.startSize * (1 + dx / s.startWidth))
      );

      liveSizeRef.current = next;
      setLiveSizePct(next);
    };

    const onUp = () => {
      const s = startRef.current;
      if (s) {
        try {
          handle.releasePointerCapture(s.pointerId);
        } catch {
          // ignore
        }
      }
      startRef.current = null;

      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);

      // ✅ ส่งค่า “ตอนจบ” กลับ parent
      onResizeEnd(liveSizeRef.current);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ✅ เลือกฟอนต์/น้ำหนัก/สไตล์ตามชนิด ให้ memonumber เหมือน backend
  const isDate = kind === "date";
  const isSig = kind === "signature";
  const isMemo = kind === "memonumber";
  const isNote = kind === "note";

  const computedFontFamily = isDate ? fontDate : isMemo ? fontMemo : isNote ? fontNote : fontSig;
  const computedFontWeight: React.CSSProperties["fontWeight"] = 400;
  const computedFontStyle: React.CSSProperties["fontStyle"] = "normal";
  const computedFontSynthesis: React.CSSProperties["fontSynthesis"] = isSig
    ? "weight style small-caps position"
    : "none";

  const numericFeatures: React.CSSProperties = {
    fontVariantNumeric: "tabular-nums lining-nums",
    fontFeatureSettings: "'tnum' on, 'lnum' on",
  };
const cleanText = (s: string) =>
  (s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  // แสดงวันที่แบบสั้น (YYYY-MM-DD) ถ้า text เป็น ISO
const displayTextRaw =
  isDate && typeof text === "string"
    ? text.includes("T")
      ? text.slice(0, 10)
      : text
    : text;

const displayText = typeof displayTextRaw === "string"
  ? cleanText(displayTextRaw)
  : displayTextRaw;


  return (
<div
  ref={outerRef}
  style={{
    position: "absolute",
    left: 0,
    top: 0,
    transform: "translate(-50%, 0)", // top-center anchor เหมือนเดิม
    transformOrigin: "50% 0",
    zIndex: 10,
    userSelect: "none",
    width: "max-content",
    ...style,
  }}
  className={className}
>

      {imgSrc ? (
        <div
          ref={innerRef}
          style={{
            position: "relative",
            outline: "1px dashed #666",
            outlineOffset: "2px",
            background: "transparent",
            display: "inline-block",
            whiteSpace: "nowrap",
            lineHeight: 1.1,
            transform: `scale(${scale})`,
            transformOrigin: "50% 0",
          }}
        >
          <img
            src={imgSrc}
            alt="signature"
            draggable={false}
            style={{
              display: "block",
              height: `${basePx * 1.2}px`,
              width: "auto",
              pointerEvents: "none",
            }}
          />

          {/* resize handle */}
          <div
            onPointerDown={startResize}
            className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize bg-white border border-gray-400"
          />

          {onDelete && (
            <button
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="absolute -top-2.5 -right-2.5 h-5 w-5 rounded-full bg-red-500/90 text-white flex items-center justify-center"
            >
              ×
            </button>
          )}
        </div>
      ) : (
        <div
          ref={innerRef}
          style={{
            fontSize: basePx,
            fontFamily: computedFontFamily,
            fontWeight: computedFontWeight,
            fontStyle: computedFontStyle,
            fontSynthesis: computedFontSynthesis,
            ...(isSig ? {} : numericFeatures),

            outline: "1px dashed #666",
            outlineOffset: "2px",
            background: "transparent",
            position: "relative",
            display: "inline-block",
            padding: 0,
            whiteSpace: "nowrap",
            lineHeight: 1,
            transform: `scale(${scale})`,
            transformOrigin: "50% 0",
          }}
        >
          {displayText}

          {/* resize handle */}
          <div
            onPointerDown={startResize}
            className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize bg-white border border-gray-400"
          />

          {onDelete && (
            <button
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="absolute -top-2.5 -right-2.5 h-5 w-5 rounded-full bg-red-500/90 text-white flex items-center justify-center"
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
};
