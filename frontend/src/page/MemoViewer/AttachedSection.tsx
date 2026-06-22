// src/component/AttachedSection.tsx
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EyeIcon } from "lucide-react";
import { AiFillFilePdf } from "react-icons/ai";
import { PhotoIcon } from "@heroicons/react/20/solid";
import { PaperClipIcon } from "@heroicons/react/24/outline";
import { BASE_URL } from "../../lib/api";
import { toSecureUploadUrl } from "../../lib/files";
import { FaFileExcel, FaFilePowerpoint, FaFileWord } from "react-icons/fa6";
import PdfOverlayAttached from "./PdfOverlayAttached";
// วางไว้เหนือคอมโพเนนต์ หรือใต้ interface ก็ได้
const getFileKind = (type?: string, name?: string) => {
  const t = (type || "").toLowerCase();
  const ext = ((name || "").split(".").pop() || "").toLowerCase();

  const isPDF = t === "application/pdf" || ext === "pdf";
  const isImage =
    t.startsWith("image/") ||
    ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext);

  const isWord =
    t.includes("msword") ||
    t.includes("wordprocessingml") ||
    ["doc", "docx", "rtf"].includes(ext);
  const isExcel =
    t.includes("spreadsheetml") ||
    t.includes("vnd.ms-excel") ||
    ["xls", "xlsx", "csv"].includes(ext);
  const isPpt =
    t.includes("presentationml") ||
    t.includes("vnd.ms-powerpoint") ||
    ["ppt", "pptx", "pps", "ppsx"].includes(ext);

  if (isPDF) return "pdf";
  if (isImage) return "image";
  if (isWord) return "word";
  if (isExcel) return "excel";
  if (isPpt) return "ppt";
  return "other";
};

export interface AttachedFile {
  id: number;
  url: string;
  fileName: string;
  fileType: string;
  size: number;
  isUrl?: boolean; // Flag for URL links
}

type Props = {
  files: AttachedFile[];
};

const AttachedSection: React.FC<Props> = ({ files }) => {
  const { t } = useTranslation("memoViewer");
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

  const safeFiles = useMemo(
    () =>
      (files ?? []).map((f) => {
        if (f.isUrl) {
          // For URL links, ensure they have a protocol
          let url = f.url;
          if (url && !url.match(/^https?:\/\//i)) {
            // If no protocol, assume https://
            url = `https://${url}`;
          }
          return { ...f, url };
        }
        // For regular files, normalize the path
        return { ...f, url: toSecureUploadUrl(f.url) };
      }),
    [files],
  );

  // (ยังไม่ได้ใช้ แต่เผื่อกรณีอื่น ๆ ในอนาคต)
  const toSecureOnce = (u?: string | null) => {
    if (!u) return "";
    let s = String(u).trim();

    // absolute -> ปล่อย
    if (/^https?:\/\//i.test(s)) return s;

    // ตัด / นำหน้า
    s = s.replace(/^\/+/, "");

    // ลบ prefix ที่ซ้ำซ้อน เหลือครั้งเดียว
    s = s.replace(/^(?:api\/secure-uploads\/)+/i, "api/secure-uploads/");

    // ถ้าเริ่มด้วย attached/ หรือ profiles/ เติมหน้าให้ครบ
    if (/^(attached|profiles)\//i.test(s)) {
      s = `api/secure-uploads/${s}`;
    }

    return `${BASE_URL}/${s}`.replace(/([^:]\/)\/+/g, "$1");
  };

  // ---------- preview states (แบบเดียวกับหน้า Comment) ----------
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewPdf, setPreviewPdf] = useState<string | null>(null);
  const [loadingFileId, setLoadingFileId] = useState<number | null>(null);

  // ฟังก์ชันดาวน์โหลดไฟล์ที่อ่าน Content-Disposition header
  const handleDownload = async (att: AttachedFile) => {
    try {
      const response = await fetch(att.url, {
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error('Download failed');
      }
      
      // อ่านชื่อไฟล์จาก Content-Disposition header
      const contentDisposition = response.headers.get('content-disposition');
      let filename = att.fileName;
      
      if (contentDisposition) {
        
        // Try different patterns to extract filename
        const patterns = [
          /filename\*=UTF-8''([^;]+)/i,
          /filename\*="?([^";\n]+)"?/i,
          /filename="?([^";\n]+)"?/i
        ];
        
        for (const pattern of patterns) {
          const match = contentDisposition.match(pattern);
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
      
      // สร้าง blob และดาวน์โหลด
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
      // Fallback to direct link
      window.open(att.url, '_blank');
    }
  };

  const handlePreview = (att: AttachedFile) => {
    // If it's a URL link, just open it in a new tab
    if (att.isUrl) {
      window.open(att.url, "_blank", "noopener,noreferrer");
      return;
    }

    const fullUrl = att.url;
    const kind = getFileKind(att.fileType, att.fileName);

    setLoadingFileId(att.id);
    try {
      if (kind === "pdf") {
        if (isiOS) {
          // iOS เปิดแท็บใหม่เหมือนเดิม
          window.open(fullUrl, "_blank");
        } else {
          // ใช้ modal แบบเดียวกับ CommentSection
          setPreviewPdf(fullUrl);
        }
      } else if (kind === "image") {
        setPreviewImage(fullUrl);
      } else {
        // ไฟล์อื่น ๆ เปิดปกติ
        window.open(fullUrl, "_blank");
      }
    } finally {
      setLoadingFileId(null);
    }
  };

  // empty state
  if (!files?.length) {
    return (
      <div className="flex flex-col items-center justify-center p-8 h-full">
        <PaperClipIcon className="h-8 w-8 text-gray-400 mb-4" />
        <h3 className="text-lg font-medium text-gray-700 mb-1">
          {t("attached.empty.title")}
        </h3>
        <p className="text-sm text-gray-500">
          {t("attached.empty.description")}
        </p>
      </div>
    );
  }

  return (
    <>
      {/* List */}
      <div className="w-full max-w-screen-md mx-auto flex flex-col gap-4">
        <h2 className="text-white bg-[#183E33] rounded-t-lg p-3 font-semibold">
          Attached
        </h2>

        {safeFiles.map((att) => {
          const kind = att.isUrl
            ? "url"
            : getFileKind(att.fileType, att.fileName);
          const isImage = kind === "image";

          const iconBox =
            kind === "url"
              ? {
                  bg: "bg-blue-50",
                  icon: (
                    <svg
                      className="w-5 h-5 text-blue-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                      />
                    </svg>
                  ),
                }
              : kind === "pdf"
                ? {
                    bg: "bg-red-50",
                    icon: <AiFillFilePdf className="w-5 h-5 text-red-500" />,
                  }
                : kind === "word"
                  ? {
                      bg: "bg-blue-50",
                      icon: <FaFileWord className="w-5 h-5 text-blue-600" />,
                    }
                  : kind === "excel"
                    ? {
                        bg: "bg-green-50",
                        icon: (
                          <FaFileExcel className="w-5 h-5 text-green-600" />
                        ),
                      }
                    : kind === "ppt"
                      ? {
                          bg: "bg-orange-50",
                          icon: (
                            <FaFilePowerpoint className="w-5 h-5 text-orange-600" />
                          ),
                        }
                      : kind === "image"
                        ? {
                            bg: "bg-lime-50",
                            icon: (
                              <PhotoIcon className="w-5 h-5 text-lime-500" />
                            ),
                          }
                        : {
                            bg: "bg-gray-50",
                            icon: (
                              <PaperClipIcon className="w-5 h-5 text-gray-500" />
                            ),
                          };

          return (
            <div
              key={att.id}
              className="flex items-center justify-between overflow-hidden p-3 bg-white rounded-lg border border-gray-200 shadow-sm hover:bg-gray-50 transition"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden">
                <div className={`p-2 rounded-lg ${iconBox.bg}`}>
                  {iconBox.icon}
                </div>

                <p
                  className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-gray-900"
                  title={att.fileName}
                >
                  {att.fileName}
                </p>
              </div>

              {/* ปุ่มพรีวิว */}
              <button
                onClick={() => handlePreview(att)}
                disabled={loadingFileId === att.id}
                className="flex-shrink-0 p-2 bg-gray-100 hover:bg-gray-200 rounded transition-colors disabled:opacity-60 disabled:cursor-wait"
                title={
                  att.isUrl
                    ? t("attached.openLink") || "Open link"
                    : isImage
                      ? t("attached.previewImage")
                      : t("attached.preview")
                }
              >
                {loadingFileId === att.id ? (
                  <div className="h-5 w-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                ) : att.isUrl ? (
                  <svg
                    className="w-5 h-5 text-gray-600 hover:text-gray-800"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                ) : (
                  <EyeIcon className="w-5 h-5 text-gray-600 hover:text-gray-800" />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Image Modal (ของเดิม เก็บไว้เหมือนเก่า) */}
      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPreviewImage(null);
          }}
        >
          <img
            src={previewImage}
            alt="Preview"
            className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-lg"
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* PDF Modal (ยกมาจาก CommentSection) */}
      {previewPdf && (
        <PdfOverlayAttached
          src={previewPdf}
          downloadUrl={previewPdf}
          onClose={() => setPreviewPdf(null)}
        />
      )}
    </>
  );
};

export default AttachedSection;
