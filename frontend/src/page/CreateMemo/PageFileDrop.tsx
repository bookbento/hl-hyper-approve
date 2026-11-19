import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Props = {
  /** listen only while the upload section is on screen */
  enabled: boolean;
  onMainFiles: (files: File[]) => void;
  onAttachedFiles: (files: File[]) => void;
  labels: { title: string; main: string; mainHint: string; attach: string; attachHint: string };
};

const hasFiles = (e: globalThis.DragEvent | DragEvent) =>
  Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * Drop files anywhere on the page (Google-Drive style). While a file drag is over
 * the window a full-screen overlay offers two targets: the main PDF or attachments.
 * Dropping anywhere else on the overlay attaches the files.
 */
export default function PageFileDrop({ enabled, onMainFiles, onAttachedFiles, labels }: Props) {
  const [active, setActive] = useState(false);
  const [over, setOver] = useState<"main" | "attach" | null>(null);
  // dragenter/leave fire for every element crossed; count them to know when the drag left the window
  const depth = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const reset = () => {
      depth.current = 0;
      setActive(false);
      setOver(null);
    };
    const onEnter = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current += 1;
      setActive(true);
    };
    const onLeave = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) reset();
    };
    // without preventDefault on dragover/drop the browser opens the file and leaves the form
    const onOver = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
      reset();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") reset();
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("keydown", onKey);
      reset();
    };
  }, [enabled]);

  if (!enabled || !active) return null;

  const take = (e: DragEvent, target: "main" | "attach") => {
    e.preventDefault();
    e.stopPropagation();
    depth.current = 0;
    setActive(false);
    setOver(null);
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    if (target === "main") onMainFiles(files);
    else onAttachedFiles(files);
  };

  const card = (target: "main" | "attach", title: string, hint: string, icon: ReactNode) => (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (over !== target) setOver(target);
      }}
      onDragLeave={(e) => {
        // moving onto the card's own icon/text fires dragleave too
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver((o) => (o === target ? null : o));
      }}
      onDrop={(e) => take(e, target)}
      className={`flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center transition-all duration-150 ${
        over === target
          ? "scale-[1.02] border-brand-500 bg-brand-50 text-brand-800 shadow-xl"
          : "border-white/70 bg-white/85 text-gray-700"
      }`}
    >
      <div className={`rounded-full p-4 ${over === target ? "bg-brand-100" : "bg-gray-100"}`}>{icon}</div>
      <div className="text-lg font-semibold">{title}</div>
      <div className="text-sm text-gray-500">{hint}</div>
    </div>
  );

  return createPortal(
    <div
      role="dialog"
      aria-label={labels.title}
      className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-6 bg-brand-900/40 p-6 backdrop-blur-sm animate-[fadeIn_120ms_ease-out]"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => take(e, "attach")}
    >
      <div className="rounded-full bg-white/90 px-5 py-2 text-base font-semibold text-gray-800 shadow">
        {labels.title}
      </div>
      <div className="flex w-full max-w-3xl flex-col gap-4 sm:flex-row">
        {card(
          "main",
          labels.main,
          labels.mainHint,
          <svg className="h-8 w-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2zM9 13h6M9 17h4" />
          </svg>,
        )}
        {card(
          "attach",
          labels.attach,
          labels.attachHint,
          <svg className="h-8 w-8 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>,
        )}
      </div>
    </div>,
    document.body,
  );
}
