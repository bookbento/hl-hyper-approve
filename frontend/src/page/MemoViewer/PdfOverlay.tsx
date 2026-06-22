// ./PdfOverlay.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import { api } from "../../lib/api";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";

export type PdfOverlayProps = {
  src: string | ArrayBuffer | null;
  downloadUrl: string;
  onClose: () => void;
  /** แสดงปุ่ม Terminate ในแถบควบคุม ถ้า true */
  canTerminate?: boolean;
  /** กดแล้วเรียกฟังก์ชัน terminate ที่ส่งมาจากหน้าแม่ */
  onTerminate?: () => void;
};

const PdfOverlay: React.FC<PdfOverlayProps> = ({
  src,
  downloadUrl,
  onClose,
  canTerminate,
  onTerminate,
}) => {
  const { t } = useTranslation("memoViewer");
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Go to Page state
  const [gotoPageInput, setGotoPageInput] = useState<string>('');
  const gotoPageInputRef = useRef<HTMLInputElement>(null);

  // Validate if gotoPageInput is a valid page number
  const isValidPageInput = useMemo(() => {
    if (!gotoPageInput.trim()) return false;
    const n = parseInt(gotoPageInput, 10);
    return Number.isFinite(n) && n >= 1 && n <= numPages;
  }, [gotoPageInput, numPages]);

  // scale อัตโนมัติตามขนาดกล่อง + zoom จากผู้ใช้
  const [baseScale, setBaseScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const Z_MIN = 0.5,
    Z_MAX = 3,
    STEP = 0.25;

  const boxRef = useRef<HTMLDivElement>(null);

  // คำนวณ baseScale เมื่อรีไซส์
  useEffect(() => {
    const fn = () => {
      if (!boxRef.current) return;
      const maxW = boxRef.current.clientWidth - 32; // padding
      setBaseScale(Math.min(maxW / 600, 1)); // 600≈A4 width
    };
    fn();
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  // ปิดด้วย ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Scroll to a specific page
  const scrollToPage = useCallback((n: number) => {
    const el = pageRefs.current[n - 1];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setPage(n);
  }, []);

  // Track current visible page as user scrolls
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      for (let i = numPages - 1; i >= 0; i--) {
        const el = pageRefs.current[i];
        if (el && el.getBoundingClientRect().top <= container.getBoundingClientRect().top + 80) {
          setPage(i + 1);
          break;
        }
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [numPages]);

  // Handle "Go to Page" navigation
  const handleGotoPage = useCallback(() => {
    const n = parseInt(gotoPageInput, 10);

    // Validate input
    if (!Number.isFinite(n)) {
      toast.error(t("gotoPage.error.invalidNumber"));
      setGotoPageInput('');
      setTimeout(() => gotoPageInputRef.current?.focus(), 0);
      return;
    }

    // Clamp to valid range
    if (n < 1 || n > numPages) {
      toast.error(t("gotoPage.error.outOfRange", { max: numPages }));
      setGotoPageInput('');
      setTimeout(() => gotoPageInputRef.current?.focus(), 0);
      return;
    }

    // Navigate to page
    scrollToPage(n);

    // Clear input after successful navigation
    setGotoPageInput('');

    // Show success feedback
    toast.success(t("gotoPage.success", { page: n }));
  }, [gotoPageInput, numPages, scrollToPage, t]);

  // Handle input change - strip non-numeric characters
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/[^\d]/g, '');
    setGotoPageInput(value);
  };

  // Handle Enter key press
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleGotoPage();
    }
    // Clear input on Escape
    if (e.key === 'Escape') {
      setGotoPageInput('');
      (e.target as HTMLInputElement).blur();
    }
  };

  if (!src) return null;
  const scale = baseScale * zoom;

  const handleDownload = async () => {
    try {
      const res = await api.get(downloadUrl, {
        responseType: "blob",
        withCredentials: true,
      });

      // หา filename จาก header ถ้ามี
      const dispo = res.headers["content-disposition"] as string | undefined;
      let filename = "document.pdf";
      
      if (dispo) {
        
        // Try different patterns to extract filename
        const patterns = [
          /filename\*=UTF-8''([^;]+)/i,
          /filename\*="?([^";\n]+)"?/i,
          /filename="?([^";\n]+)"?/i
        ];
        
        for (const pattern of patterns) {
          const match = dispo.match(pattern);
          if (match && match[1]) {
            try {
              filename = decodeURIComponent(match[1]);
              break;
            } catch (e) {
              filename = match[1];
              break;
            }
          }
        }
      }

      const blobUrl = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (error) {
      console.error('Download failed:', error);
      // fallback — ถ้าโหลดจากเซิร์ฟเวอร์ล้มเหลว ลองใช้ src เดิม
      if (typeof src === "string") {
        const a = document.createElement("a");
        a.href = src;
        a.download = "document.pdf";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    }
  };
 const options = useMemo(() => ({
    withCredentials: true,
  }), []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
        className="relative w-[95vw] h-[90vh] bg-gray-50 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
      >
        {/* Header / Close Bar */}
        <div className="absolute top-0 left-0 right-0 z-10 flex justifying-end p-2 pointer-events-none">
          <button
            onClick={onClose}
            className="pointer-events-auto ml-auto p-2 rounded-full bg-black/50 hover:bg-black/70 text-white backdrop-blur-sm transition-colors"
            aria-label="Close"
            title="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* PDF viewer Container */}
        <div ref={scrollContainerRef} className="flex-1 w-full overflow-auto bg-gray-100/50 text-center">
          <div className="min-w-full inline-block pt-12 pb-32 align-middle">
            <Document
              file={src}
              onLoadSuccess={({ numPages }) => setNumPages(numPages)}
              options={options}
              loading={
                <div className="flex items-center justify-center h-[50vh] w-full">
                  <div className="w-10 h-10 border-4 border-gray-200 border-t-blue-500 rounded-full animate-spin"></div>
                </div>
              }
            >
              {Array.from({ length: numPages }, (_, i) => (
                <div
                  key={i}
                  ref={(el) => { pageRefs.current[i] = el; }}
                  className="mb-4 flex justify-center"
                >
                  <Page
                    pageNumber={i + 1}
                    scale={scale}
                    renderAnnotationLayer={false}
                    renderTextLayer={false}
                    className="shadow-lg !bg-white"
                    loading={
                      <div className="flex items-center justify-center h-[600px] w-full bg-white shadow-sm">
                        <div className="w-10 h-10 border-4 border-gray-200 border-t-blue-500 rounded-full animate-spin"></div>
                      </div>
                    }
                    error={
                      <div className="flex flex-col items-center justify-center p-10 text-center h-[600px] bg-white rounded-lg shadow-sm">
                        <div className="p-4 bg-red-100 rounded-full mb-4">
                          <svg
                            className="w-8 h-8 text-red-500"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                            />
                          </svg>
                        </div>
                        <h3 className="text-lg font-semibold text-gray-900 mb-2">
                          {t("pdfOverlay.errorTitle", "Unable to display preview")}
                        </h3>
                        <p className="text-gray-500 mb-6 max-w-sm">
                          {t("pdfOverlay.errorDesc", "The file might be too large or not supported. Please download to view locally.")}
                        </p>
                        <button
                          onClick={handleDownload}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-sm transition-colors text-sm font-medium flex items-center gap-2"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                          </svg>
                          Download File
                        </button>
                      </div>
                    }
                  />
                </div>
              ))}
            </Document>
          </div>
        </div>

        {/* ===== แถบควบคุม ===== */}
<div
          className="
            absolute bottom-6 left-1/2 -translate-x-1/2 z-20
            flex flex-wrap items-center justify-center gap-4
            bg-white/90 backdrop-blur-md px-5 py-3 rounded-2xl shadow-xl border border-gray-100
            w-[min(90vw,480px)] transition-all
          "
        >
          {/* Zoom */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setZoom((z) => Math.max(Z_MIN, z - STEP))}
              disabled={zoom <= Z_MIN}
              className="px-2 py-1 rounded bg-gray-100 disabled:opacity-40"
              aria-label="Zoom out"
              title="Zoom out"
            >
              –
            </button>

            <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>

            <button
              onClick={() => setZoom((z) => Math.min(Z_MAX, z + STEP))}
              disabled={zoom >= Z_MAX}
              className="px-2 py-1 rounded bg-gray-100 disabled:opacity-40"
              aria-label="Zoom in"
              title="Zoom in"
            >
              +
            </button>
          </div>

          {/* Page nav */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => scrollToPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="px-2 py-1 rounded bg-gray-100 disabled:opacity-40"
              aria-label="Previous page"
              title="Previous page"
            >
              ‹
            </button>

            <span className="w-16 text-center tabular-nums">
              {page}/{numPages}
            </span>

            <button
              onClick={() => scrollToPage(Math.min(numPages, page + 1))}
              disabled={page >= numPages}
              className="px-2 py-1 rounded bg-gray-100 disabled:opacity-40"
              aria-label="Next page"
              title="Next page"
            >
              ›
            </button>
          </div>

          {/* Go to Page controls - only show for multi-page PDFs */}
          {numPages > 1 && (
            <div className="flex items-center gap-2">
              <input
                ref={gotoPageInputRef}
                type="number"
                inputMode="numeric"
                min={1}
                max={numPages}
                value={gotoPageInput}
                placeholder={t("gotoPage.placeholder")}
                className="w-16 h-8 px-2 text-sm text-center bg-white border border-gray-300 rounded 
                           focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                           [appearance:textfield] [-moz-appearance:textfield]
                           [&::-webkit-outer-spin-button]:appearance-none
                           [&::-webkit-inner-spin-button]:appearance-none
                           disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={t("gotoPage.ariaLabel")}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
              />
              <button
                onClick={handleGotoPage}
                disabled={!isValidPageInput}
                className="h-8 px-3 bg-blue-500 hover:bg-blue-600 text-white rounded 
                           shadow-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed
                           flex items-center gap-1.5 text-sm"
                aria-label={t("gotoPage.btnLabel")}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                        d="M9 5l7 7-7 7" />
                </svg>
                <span className="hidden sm:inline">{t("gotoPage.btnText")}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default React.memo(PdfOverlay);
