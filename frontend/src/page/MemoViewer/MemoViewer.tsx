import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { api, isAuthError } from "../../lib/api";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import LoadingScreen from "../../components/Mhan";
import CommentSection from "./CommentSection";
import AttachedSection from "./AttachedSection";
import HistorySection from "./HistorySection";
import MemoAndApproval from "./MemoAndApproval";
import PdfOverlay from "./PdfOverlay";
import { useStableSize } from "./useStableSize";
import { toSecureUploadUrl } from "../../lib/files";

import { ReferenceMemoViewer } from "../../components/ReferenceMemo";
import DeletedMemo from "../../components/DeletedMemo";
import ApproveModal from "./ApproveModal"; // ⬅️ NEW
import ApproveWithConditionModal from "./ApproveWithConditionModal";
import TerminateReasonModal from "./TerminateReasonModal";
import { RejectReasonModal } from "./RejectReasonModal";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCircleCheck,
  faCircleInfo,
  faSpinner,
  faArrowRight,
} from "@fortawesome/free-solid-svg-icons";
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

interface ApprovalLineResponse {
  id: number;
  levels: {
    level: number;
    users: {
      loaUserPivotId: number;
      id: number;
      name: string;
      level: number;
      status: string;
    }[];
  }[];
}

// === CC types ===
interface CcRecipient {
  userId: number;
  name: string;
  email: string;
  addedAt: string;
  profileImage?: string | null;
}

// ⬇️ ADD: type ของ marker ลายเซ็น
interface SignaturePosition {
  id: number;
  memoId: number;
  fileId: number;
  userId: number;
  page: number;
  x: number;
  y: number;
  sizePct?: number | null;
  level?: number | null; // Approval level this signature belongs to
}

interface Memo {
  id: number;
  subject: string;
  memonumber: string;
  userId: number;
  user?: MemoUser;
  businessUnit?: { name: string };
  department?: { name: string };
  team?: { name: string };
  memoType?: { name: string };
  createdAt: string;
  statuses: MemoStatus[];
  history?: HistoryItem[];
  attachedFiles?: AttachedFile[];
  mainFiles?: Array<{ id: number }>;
  status?: string | null;
  lastHistory?: {
    action: string;
    actiontype: string | null;
    timestamp: string;
    userName: string;
    statusName: string | null;
  } | null;
  expiresAt?: string | null;

  // ⬇️ ADD: ให้ memo รู้จักฟิลด์นี้ (optional)
  signaturePositions?: SignaturePosition[];
}

async function fetchCurrentUser() {
  try {
    const res = await api.get("/api/me");
    return res.data;
  } catch (err) {
    if (isAuthError(err)) {
      // ถ้า session หมดอายุ อาจ redirect หรือคืน null ให้ caller จัดการ
      return null;
    }
    console.error("❌ Failed to fetch current user", err);
    return null;
  }
}

function markRejected(
  groups: ApproverGroup[],
  pivotId: number,
): ApproverGroup[] {
  return groups.map((g) => ({
    ...g,
    users: g.users.map((u) =>
      u.loaUserPivotId === pivotId ? { ...u, status: "rejected" } : u,
    ),
  }));
}

interface Approver {
  id: number;
  name: string;
  level: number;
  status: string;
  loaUserPivotId: number;
  actedAt?: string | null;
  since?: string | null;
  isSigReq?: boolean; // ⬅️ ADD
  approvalRequirement?: string; // ⬅️ ADD for level progress calculation
}
interface UserSignature {
  id: number;
  path: string;
  label?: string;
}

interface UserSignaturesResponse {
  defaultSignatureId: number | null;
  signatures: UserSignature[];
}

interface ApproverGroup {
  level: number;
  users: Approver[];
}

interface AttachedFile {
  id: number;
  url: string;
  fileName: string;
  fileType: string;
  size: number;
  isUrl?: boolean; // Flag for URL links
  filePath?: string | null; // Optional for URL links
}

interface HistoryItem {
  id: number;
  action: string;
  createdAt: string;
  user?: {
    id: number;
    name: string;
  };
}

interface MemoStatus {
  id: number;
  status: {
    id: number;
    name: string;
  };
  createdAt: string;
  updatedAt?: string;
}

interface MemoUser {
  id: number;
  name: string;
  lastname?: string | null;
  nickname?: string | null;
  profileImagePath?: string | null;
  defaultSignatureText?: string | null;
}

interface Memo {
  id: number;
  subject: string;
  memonumber: string;
  userId: number;
  user?: MemoUser;
  businessUnit?: { name: string };
  department?: { name: string };
  team?: { name: string };
  memoType?: { name: string };
  createdAt: string;
  statuses: MemoStatus[];
  history?: HistoryItem[];
  attachedFiles?: AttachedFile[];
  mainFiles?: Array<{ id: number }>;
  status?: string | null; // ⬅️ เพิ่ม (optional)
  lastHistory?: {
    action: string;
    actiontype: string | null;
    timestamp: string;
    userName: string;
    statusName: string | null;
  } | null;
  expiresAt?: string | null;
}
type ExtraApprovalLineDTO = {
  id: number;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "REJECTED";
  approvers: {
    id: number;
    user: {
      id: number;
      name: string;
      lastname?: string | null;
      nickname?: string | null;
    };
    status?: { id: number; name: string } | null;
  }[];
};

// === Inline DeleteConfirmationModal (Confirm/Cancel version) ==================
type DeleteModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: React.ReactNode;
  message?: React.ReactNode;
  itemName?: string;
  isLoading?: boolean;
  confirmLabel?: React.ReactNode; // ป้ายปุ่มยืนยัน (ตัวเลือก)
};

const DeleteConfirmationModal: React.FC<DeleteModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  itemName = "",
  isLoading = false,
  confirmLabel,
}) => {
  const { t } = useTranslation("memoViewer");

  // ปิดด้วย ESC / ยืนยันด้วย Enter
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && !isLoading) onConfirm();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, isLoading, onClose, onConfirm]);

  if (!isOpen) return null;

  const confirmText =
    confirmLabel ??
    t("confirmDelete.btnConfirm", {
      defaultValue: t("confirmDelete.btnDelete", "Confirm"),
    });

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
              <svg
                className="w-6 h-6 text-red-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">
                {title ?? t("confirmDelete.title", "Delete Document")}
              </h3>
              <p className="text-sm text-gray-500">
                {t("confirmDelete.cannotUndo", "This action cannot be undone")}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100"
            disabled={isLoading}
            aria-label={t("confirmDelete.btnClose", "Close")}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          <p className="text-gray-700">
            {message ??
              t(
                "confirmDelete.message",
                "Are you sure you want to delete this memo?",
              )}
          </p>
          {!!itemName && (
            <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
              <p className="text-sm text-gray-600">
                {t("confirmDelete.itemLabel", "Item to delete:")}
              </p>
              <p className="font-medium text-gray-900 break-all">{itemName}</p>
            </div>
          )}

          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <div className="flex gap-2">
              <svg
                className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div>
                <p className="text-sm font-medium text-red-800">
                  {t("confirmDelete.warningTitle", "Warning")}
                </p>
                <p className="text-sm text-red-700">
                  {t(
                    "confirmDelete.warningDetail",
                    "This is a permanent action. All data associated with this memo will be deleted permanently.",
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t bg-gray-50">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            {t("confirmDelete.btnCancel", "Cancel")}
          </button>

          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 min-w-[120px] flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {t("confirmDelete.deleting", "Deleting...")}
              </>
            ) : (
              <>
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1-1H8a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
                {confirmText}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default function MemoViewer() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  // ⬇️ NEW: Approval Modal State
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [showApproveWithConditionModal, setShowApproveWithConditionModal] =
    useState(false);
  const [pendingPivotRequiresSig, setPendingPivotRequiresSig] = useState(false);
  const [pendingPivotId, setPendingPivotId] = useState<number | null>(null);

  // Check if this is a reference view (read-only mode)
  const isReferenceMode = searchParams.get("mode") === "reference";
  const refreshLockRef = useRef(false);
  // ---------- state ----------
  const { t, i18n } = useTranslation("memoViewer");

  // Language loading state
  const [isLanguageLoading, setIsLanguageLoading] = useState(false);

  // Access error state (for 403 permission denied)
  const [accessError, setAccessError] = useState<{
    code: number;
    message: string;
  } | null>(null);

  const [memo, setMemo] = useState<Memo | null>(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [commentCount, setCommentCount] = useState<number>(0);
  const [attachedCount, setAttachedCount] = useState<number>(0);
  const [referenceCount, setReferenceCount] = useState<number>(0);
  const formatCount = (n: number) => (n > 99 ? "99+" : String(n));

  // Set document title for memo detail page
  useEffect(() => {
    const originalTitle = document.title;
    document.title = "HyLife e-Approval | Memo Detail";
    
    return () => {
      document.title = originalTitle;
    };
  }, []);

  useEffect(() => {
    setPage((p) => {
      if (!numPages) return 1;
      return Math.min(Math.max(1, p), numPages);
    });
  }, [numPages]);

  const [approverGroups, setApproverGroups] = useState<ApproverGroup[]>([]);
  const [userSignatures, setUserSignatures] = useState<UserSignature[]>([]);
  const [defaultSignatureId, setDefaultSignatureId] = useState<number | null>(
    null,
  );

  const [extraLine, setExtraLine] = useState<ExtraApprovalLineDTO | null>(null);
  const extraBusy = useMemo(
    () =>
      extraLine?.status === "PENDING" || extraLine?.status === "IN_PROGRESS",
    [extraLine],
  );

  const [ccRecipients, setCcRecipients] = useState<CcRecipient[]>([]);
  const [me, setMe] = useState<MemoUser | null>(null);
  const [pageInput, setPageInput] = useState<string>("1");
  const [gotoPageInput, setGotoPageInput] = useState<string>("");
  const gotoPageInputRef = useRef<HTMLInputElement>(null);

  // Validate if gotoPageInput is a valid page number
  const isValidPageInput = useMemo(() => {
    if (!gotoPageInput.trim()) return false;
    const n = parseInt(gotoPageInput, 10);
    return Number.isFinite(n) && n >= 1 && n <= numPages;
  }, [gotoPageInput, numPages]);

  // sync ช่อง input ให้ตาม page เสมอ
  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const commitPageInput = () => {
    const n = parseInt(pageInput, 10);
    if (Number.isFinite(n)) {
      const clamped = Math.max(1, Math.min(n, numPages || 1));
      setPage(clamped);
    } else {
      // ถ้าพิมพ์ไม่ใช่เลข ให้คืนค่าเดิม
      setPageInput(String(page));
    }
  };

  // Handle "Go to Page" navigation
  const handleGotoPage = useCallback(() => {
    const n = parseInt(gotoPageInput, 10);

    // Validate input
    if (!Number.isFinite(n)) {
      toast.error(t("gotoPage.error.invalidNumber"));
      setGotoPageInput("");
      // Maintain focus for retry
      setTimeout(() => gotoPageInputRef.current?.focus(), 0);
      return;
    }

    // Clamp to valid range
    if (n < 1 || n > numPages) {
      toast.error(t("gotoPage.error.outOfRange", { max: numPages }));
      setGotoPageInput("");
      // Maintain focus for retry
      setTimeout(() => gotoPageInputRef.current?.focus(), 0);
      return;
    }

    // Navigate to page
    setPage(n);

    // Clear input after successful navigation
    setGotoPageInput("");

    // Optional: Show success feedback
    toast.success(t("gotoPage.success", { page: n }));
  }, [gotoPageInput, numPages, t]);

  // Handle input change - strip non-numeric characters
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/[^\d]/g, "");
    setGotoPageInput(value);
  };

  // Handle Enter key press
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleGotoPage();
    }
    // Optional: Clear input on Escape
    if (e.key === "Escape") {
      setGotoPageInput("");
      (e.target as HTMLInputElement).blur();
    }
  };

  // เปิด/ปิดแถบขวา + จำค่าล่าสุด
  const [rightOpen, setRightOpen] = useState<boolean>(true);
  useEffect(() => {
    setRightOpen(true); // บังคับเปิดเมื่อเข้าหน้า/สลับเมโม
  }, [id]);

  // อ่านสถานะ "ล่าสุด" จากท้ายลิสต์ (หรือ sort ตามเวลา ถ้ามี timestamp)
  const latestStatus = useMemo(() => {
    const arr = memo?.statuses ?? [];
    if (!arr.length) return null;

    // ถ้ามี createdAt/updatedAt ให้ sort เพื่อความชัวร์
    const sorted = [...arr].sort((a: MemoStatus, b: MemoStatus) => {
      const atA = new Date(a.createdAt ?? a.updatedAt ?? 0).getTime();
      const atB = new Date(b.createdAt ?? b.updatedAt ?? 0).getTime();
      return atA - atB;
    });
    return sorted[sorted.length - 1];
  }, [memo]);
  const isExpired = useMemo(() => {
    if (!memo?.expiresAt) return false;
    const t = Date.parse(memo.expiresAt);
    return Number.isFinite(t) ? t <= Date.now() : false;
  }, [memo?.expiresAt]);
  const currentStatusId = latestStatus?.status?.id ?? null;
  const isTerminated = currentStatusId === 7;
  const isInApproval = currentStatusId === 5;
  const isProcessing = currentStatusId === 5;
  const isEditable = currentStatusId === 1 || currentStatusId === 6;

  const inFlight = useRef(new Set<string>());
  const runOnce = useCallback(async (key: string, fn: () => Promise<void>) => {
    if (inFlight.current.has(key)) return; // กันคลิกซ้ำทันที
    inFlight.current.add(key);
    try {
      await fn();
    } finally {
      inFlight.current.delete(key);
    }
  }, []);

  const hasApproved =
    memo?.statuses.some((s: MemoStatus) => s.status.name === "Approved") ??
    false;
  const [pdfOpen, setPdfOpen] = useState(false);

  // ✅ Next Memo Modal state
  const [showNextMemoModal, setShowNextMemoModal] = useState(false);
  const [loadingNextMemo, setLoadingNextMemo] = useState(false);
  const [hasMorePendingDocs, setHasMorePendingDocs] = useState(false);

  // Dirty state for CommentSection
  const [isCommentDirty, setIsCommentDirty] = useState(false);

  // Handle Tab Switching with Confirmation
  const handleTabChange = (newTab: typeof activeTab) => {
    if (activeTab === "comment" && isCommentDirty && newTab !== "comment") {
      const confirm = window.confirm(t("confirmDiscard"));
      if (!confirm) return;
    }
    setActiveTab(newTab);
  };

  // เลือก label
  const statusLabel = hasApproved
    ? "Approved"
    : (latestStatus?.status?.name ?? "Processing");

  // ---------- แถบเมนูต่างๆๆ ---------
  const [activeTab, setActiveTab] = useState<
    "details" | "history" | "comment" | "attached" | "reference"
  >("details");

  const TABS = [
    {
      key: "details",
      label: t("tab.details"),
      icon: (
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      ),
    },
    {
      key: "comment",
      label: t("tab.comment"),
      icon: (
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      ),
    },
    {
      key: "attached",
      label: t("tab.attached"),
      icon: (
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
          />
        </svg>
      ),
    },
    {
      key: "history",
      label: t("tab.history"),
      icon: (
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      ),
    },
    {
      key: "reference",
      label: t("tab.reference"),
      icon: (
        <svg
          className="w-5 h-5"
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
    },
  ] as const;

  const displayNameFromId = (id?: number, fallbackName?: string) => {
    if (!id) return fallbackName ?? "";
    // For now, just return the fallback name since userMap is not being used
    return fallbackName ?? "";
  };
  const latestName = latestStatus?.status?.name ?? "";
  // ซ่อนปุ่ม Extra line เมื่ออนุมัติแล้ว / ยุติ / ถูก Recall
  const hideExtraButton =
    ["Approved", "Terminated", "Recalled", "Recall"].includes(latestName) ||
    hasApproved || // กันเคสมี Approved ในไทม์ไลน์แล้ว
    currentStatusId === 7 || // Terminated
    currentStatusId === 6 || // Recalled (ถ้าระบบคุณใช้ 6)
    currentStatusId === 3;
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfProgress, setPdfProgress] = useState<number | null>(null);
  const [pdfMissing, setPdfMissing] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1); // 1 = fit-to-width

  const mountedRef = useRef(true);

  // ⬇️ REMOVED: approvalHandlersRef (Logic lifted to parent)

  // ✅ ลำดับที่ถูก
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const pdfScrollRef = useRef<HTMLDivElement>(null);
  const { width: containerWidth, recalc } = useStableSize<HTMLDivElement>(
    pdfContainerRef,
    [rightOpen, pdfOpen],
    { minWidth: 360 }, // ปรับได้ 320–480 ตาม layout ของคุณ
  );

  const PADDING_X = 24;
  const basePageWidth = Math.max(320, Math.floor(containerWidth - PADDING_X * 2));
  const pageWidth = Math.round(basePageWidth * zoomLevel);

  // Chrome-style discrete zoom steps (as scale multipliers)
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  const ZOOM_MIN = ZOOM_STEPS[0];
  const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

  const nextZoomUp = (current: number) => {
    for (const s of ZOOM_STEPS) { if (s > current + 0.001) return s; }
    return ZOOM_MAX;
  };
  const nextZoomDown = (current: number) => {
    for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) { if (ZOOM_STEPS[i] < current - 0.001) return ZOOM_STEPS[i]; }
    return ZOOM_MIN;
  };

  // Smooth-animate scroll to target position
  const animateScroll = useCallback(
    (sc: HTMLDivElement, targetLeft: number, targetTop: number, duration = 200) => {
      const startLeft = sc.scrollLeft;
      const startTop = sc.scrollTop;
      const dLeft = targetLeft - startLeft;
      const dTop = targetTop - startTop;
      const start = performance.now();
      const ease = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out quad
      const step = (now: number) => {
        const elapsed = Math.min((now - start) / duration, 1);
        const p = ease(elapsed);
        sc.scrollLeft = startLeft + dLeft * p;
        sc.scrollTop = startTop + dTop * p;
        if (elapsed < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [],
  );

  // Zoom while preserving the visual center (or cursor point for wheel zoom)
  const applyZoom = useCallback(
    (newZoom: number, cursorX?: number, cursorY?: number) => {
      const sc = pdfScrollRef.current;
      if (!sc) {
        setZoomLevel(newZoom);
        return;
      }
      const oldZoom = zoomLevel;
      const vpX = cursorX != null ? cursorX - sc.getBoundingClientRect().left : sc.clientWidth / 2;
      const vpY = cursorY != null ? cursorY - sc.getBoundingClientRect().top : sc.clientHeight / 2;
      const contentX = (sc.scrollLeft + vpX) / oldZoom;
      const contentY = (sc.scrollTop + vpY) / oldZoom;
      setZoomLevel(newZoom);
      requestAnimationFrame(() => {
        animateScroll(sc, contentX * newZoom - vpX, contentY * newZoom - vpY);
      });
    },
    [zoomLevel, animateScroll],
  );

  const handleZoomIn = useCallback(() => {
    applyZoom(nextZoomUp(zoomLevel));
  }, [zoomLevel, applyZoom]);
  const handleZoomOut = useCallback(() => {
    applyZoom(nextZoomDown(zoomLevel));
  }, [zoomLevel, applyZoom]);
  const handleZoomReset = useCallback(() => {
    applyZoom(1);
  }, [applyZoom]);

  // Capture Ctrl+Wheel at document level to prevent browser zoom,
  // but only apply PDF zoom when cursor is inside the PDF container.
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const el = pdfContainerRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      const direction = e.deltaY > 0 ? "down" : "up";
      setZoomLevel((prev) => {
        const next = direction === "up" ? nextZoomUp(prev) : nextZoomDown(prev);
        const sc = pdfScrollRef.current;
        if (sc) {
          const vpX = e.clientX - sc.getBoundingClientRect().left;
          const vpY = e.clientY - sc.getBoundingClientRect().top;
          const contentX = (sc.scrollLeft + vpX) / prev;
          const contentY = (sc.scrollTop + vpY) / prev;
          requestAnimationFrame(() => {
            animateScroll(sc, contentX * next - vpX, contentY * next - vpY, 150);
          });
        }
        return next;
      });
    };
    document.addEventListener("wheel", handler, { passive: false });
    return () => document.removeEventListener("wheel", handler);
  }, [animateScroll]);
  const preloadCommentCount = useCallback(async () => {
    if (!id) return;
    try {
      const { data } = await api.get(`/api/memos/${id}/comments`, {
        withCredentials: true,
      });
      setCommentCount(Array.isArray(data) ? data.length : 0);
    } catch {
      setCommentCount(0);
    }
  }, [id]);

  const preloadReferenceCount = useCallback(async () => {
    if (!id) return;
    try {
      const { data } = await api.get(`/api/memos/${id}/references`, {
        withCredentials: true,
      });
      setReferenceCount(Array.isArray(data) ? data.length : 0);
    } catch {
      setReferenceCount(0);
    }
  }, [id]);

  // เรียกใช้งานหลัง set memo เสร็จ หรืออย่างน้อยตอน id เปลี่ยน
  useEffect(() => {
    preloadCommentCount();
    preloadReferenceCount();
  }, [preloadCommentCount, preloadReferenceCount]);
  // ===== โหลดข้อมูล + ตั้ง URL PDF แบบ Streaming (ไม่ใช้ blob) =====
  // helper

  // ✅ ฟังอีเวนต์จากปุ่ม Go to approval ใน MemoAndApproval
  useEffect(() => {
    const onOpen = () => {
      // เปิดแผงขวาไว้ก่อน
      setRightOpen(true);
      // ไปแท็บคอมเมนต์
      setActiveTab("comment"); // Force switch is fine here as it's an explicit action to OPEN comments

      // รอให้แท็บ render แล้วค่อยเลื่อน
      requestAnimationFrame(() => {
        const el = document.getElementById("comment-section");
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    };

    window.addEventListener("open-extra-panel", onOpen as EventListener);
    return () =>
      window.removeEventListener("open-extra-panel", onOpen as EventListener);
  }, []);

  const makePdfUrl = useCallback(
    (memoId: string | number, ver: number) =>
      `/api/memos/${memoId}/download?preview=1&v=${ver}&nonce=${Date.now()}`,
    [],
  );
  const loadData = useCallback(
    async (opts: { refreshPdf?: boolean } = {}) => {
      const { refreshPdf = false } = opts;
      if (!id) return;

      console.log(
        `[MemoViewer.loadData] START - memoId=${id}, refreshPdf=${refreshPdf}`,
      );

      try {
        // 1) โหลด meta พร้อมกัน
        const cacheBuster = Date.now();
        console.log(
          `[MemoViewer.loadData] Fetching with cacheBuster=${cacheBuster}`,
        );

        const [memoRes, lineRes, ccRes, extraRes] = await Promise.all([
          api.get(`/api/memos/${id}?_=${cacheBuster}`, {
            withCredentials: true,
          }),
          api.get<ApprovalLineResponse>(
            `/api/memos/${id}/approval-line?_=${cacheBuster}`,
            {
              withCredentials: true,
            },
          ),
          api.get<CcRecipient[]>(`/api/memos/${id}/cc?_=${cacheBuster}`, {
            withCredentials: true,
          }),
          api.get<ExtraApprovalLineDTO | null>(
            `/api/memos/${id}/extra-approval-lines/active?_=${cacheBuster}`,
            { withCredentials: true },
          ),
        ]);

        console.log(`[MemoViewer.loadData] Received lineRes:`, lineRes.data);
        console.log(`[MemoViewer.loadData] Received lineRes:`, lineRes.data);

        if (!mountedRef.current) return;

        const memoData = memoRes.data;
        setMemo(memoData);

        // ⬇️ CHANGE: ตอน map users ให้ส่ง isSigReq มาด้วย (ใช้ fallback หลายชื่อ)
        const groups: ApproverGroup[] = lineRes.data.levels.map((lvl) => ({
          level: lvl.level,
          users: lvl.users.map((u) => {
            const mapped = {
              id: u.id,
              name: u.name,
              level: u.level,
              loaUserPivotId: u.loaUserPivotId,
              status: u.status,
              actedAt: (u as any).actedAt ?? (u as any).updatedAt ?? null,
              since: (u as any).since ?? (u as any).createdAt ?? null,
              isSigReq:
                (u as any).isSigReq ??
                (u as any).requireSignature ??
                (u as any).signatureRequired ??
                (u as any).mustSign ??
                (u as any).needSignature ??
                undefined, // ไม่มี ก็ปล่อย undefined
              approvalRequirement: (u as any).approvalRequirement,
              isLevelSatisfied: (u as any).isLevelSatisfied,
              approvedBy: (u as any).approvedBy,
              approveWithCondition: (u as any).approveWithCondition ?? null,
              rejectReason: (u as any).rejectReason ?? null,
              terminateReason: (u as any).terminateReason ?? null,
            };
            console.log(`[MemoViewer.loadData] Mapped user:`, mapped);
            return mapped;
          }),
        }));
        console.log(
          `[MemoViewer.loadData] Setting ${groups.length} approver groups`,
        );
        setApproverGroups(groups);

        const cc = Array.isArray(ccRes.data) ? ccRes.data : [];
        setCcRecipients(
          cc.map((c) => ({
            ...c,
            profileImage: toSecureUploadUrl(c.profileImage ?? null),
          })),
        );
        setExtraLine(extraRes.data ?? null);
        setAttachedCount(
          Array.isArray(memoData?.attachedFiles)
            ? memoData.attachedFiles.length
            : 0,
        );
        // 2) ตั้ง URL PDF — pre-check ก่อนส่งให้ react-pdf
        if (refreshPdf) {
          const ver = memoRes.data?.mainFiles?.[0]?.id ?? 0;
          const url = makePdfUrl(id!, ver);
          setPdfMissing(false);
          try {
            const resp = await fetch(url, {
              credentials: "include",
              method: "HEAD",
            });
            if (resp.ok) {
              setPdfUrl(url);
            } else if (resp.status === 404) {
              setPdfMissing(true);
              setPdfLoading(false);
            } else {
              setPdfUrl(url); // let react-pdf handle other errors
            }
          } catch {
            setPdfUrl(url); // network error — let react-pdf handle it
          }
        }
      } catch (err: any) {
        if (mountedRef.current) {
          console.error("❌ loadData error:", err);

          // Check for 403 Forbidden error (no permission to view memo)
          if (err?.response?.status === 403) {
            const errorMessage =
              err?.response?.data?.error ||
              err?.response?.data?.message ||
              t(
                "error.noAccessToMemo",
                "You do not have permission to access this memo",
              );
            setAccessError({ code: 403, message: errorMessage });
            return; // Don't show toast for permission errors
          }

          // Check for 410 Gone OR 404 with "deleted" message
          if (
            err?.response?.status === 410 ||
            (err?.response?.status === 404 &&
              (err?.response?.data?.error || "").includes("deleted"))
          ) {
            setAccessError({
              code: 410,
              message: t(
                "error.memoDeleted",
                "This memo has been deleted and is no longer available.",
              ),
            });
            return;
          }

          toast.error(t("error.loadData"));
        }
      }
    },
    [id, t],
  );

  // เริ่ม state โหลดทุกครั้งที่ pdfUrl เปลี่ยน
  useEffect(() => {
    if (!pdfUrl) return;
    setPdfLoading(true);
    setPdfProgress(null);
  }, [pdfUrl]);

  const handleRecallClear = async () => {
    if (!me?.id || !memo?.mainFiles?.[0]?.id) {
      toast.error(t("error.missingUserOrFile"));
      return;
    }
    try {
      await api.post(
        `/api/memos/${id}/recall-clear`,
        {
          userId: me.id,
          fileId: memo.mainFiles[0].id,
        },
        { withCredentials: true },
      );
      toast.success(t("success.recallClear"));
      await loadData({ refreshPdf: true });
    } catch (e: any) {
      console.error("handleRecallClear error:", e);

      // ✅ Handle 409 MEMO_STATUS_CHANGED - use i18n to translate status code
      if (
        e?.response?.status === 409 &&
        e?.response?.data?.code === "MEMO_STATUS_CHANGED"
      ) {
        const statusCode = e?.response?.data?.statusCode || "UNKNOWN";
        const errorMsg = t(
          `error.statusChanged.${statusCode}`,
          t("error.statusChanged.UNKNOWN"),
        );
        toast.error(errorMsg, { duration: 5000 });

        // Auto-refresh data to show current state
        await loadData({ refreshPdf: true });
        return;
      }

      toast.error(t("error.recallClearFail"));
    }
  };

  const [terminateModalOpen, setTerminateModalOpen] = useState(false);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectingPivotId, setRejectingPivotId] = useState<number | null>(null);

  const handleTerminate = useCallback(
    (reason: string) =>
      runOnce("terminate", async () => {
        if (!memo?.id || !me?.id) {
          toast.error("Missing memo or user info");
          return;
        }
        try {
          await api.post(
            `/api/memos/${id}/status`,
            {
              memoId: memo.id,
              userId: me.id,
              statusId: 7,
              fileId: memo.mainFiles?.[0]?.id,
              terminationReason: reason,
            },
            { withCredentials: true },
          );

          // อัปเดตใน state ให้เห็นผลทันที
          setMemo((prev: Memo | null) =>
            prev
              ? {
                  ...prev,
                  statuses: [
                    ...(prev.statuses ?? []),
                    {
                      id: Date.now(), // temporary id
                      status: { id: 7, name: "Terminated" },
                      createdAt: new Date().toISOString(),
                    },
                  ],
                }
              : prev,
          );

          toast.success(t("success.terminated") || "Memo terminated");
          await loadData({ refreshPdf: true });
        } catch (e: any) {
          console.error("handleTerminate error:", e);

          // ✅ Handle 409 MEMO_STATUS_CHANGED - use i18n to translate status code
          if (
            e?.response?.status === 409 &&
            e?.response?.data?.code === "MEMO_STATUS_CHANGED"
          ) {
            const statusCode = e?.response?.data?.statusCode || "UNKNOWN";
            const errorMsg = t(
              `error.statusChanged.${statusCode}`,
              t("error.statusChanged.UNKNOWN"),
            );
            toast.error(errorMsg, { duration: 5000 });

            // Auto-refresh data to show current state
            await loadData({ refreshPdf: true });
            return;
          }

          // ✅ Handle 403 - not authorized to terminate
          if (e?.response?.status === 403) {
            const errorMsg =
              e?.response?.data?.error ||
              t("error.terminateNotAllowed", "คุณไม่มีสิทธิ์ยุติเอกสารนี้");
            toast.error(errorMsg, { duration: 5000 });
            return;
          }

          toast.error(t("error.terminateFail") || "Terminate failed");
        }
      }),
    [id, memo?.id, memo?.mainFiles, me?.id, t, runOnce, loadData],
  );

  const handleDownload = () => {
    if (!id) return;
    const a = document.createElement("a");
    a.href = `/api/memos/${id}/download`;
    a.rel = "noopener";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  function formatDisplayName(
    u?: {
      name?: string;
      lastname?: string | null;
      nickname?: string | null;
    } | null,
  ) {
    if (!u) return "";
    const full = [u?.name, u?.lastname]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return u?.nickname ? `${full} (${u.nickname})` : full;
  }
  const myDisplayName = useMemo(() => formatDisplayName(me), [me]);
  const [deleting, setDeleting] = useState(false);

  const hasAnyApproved = approverGroups.some((g) =>
    g.users.some((u) => u.status === "approved"),
  );

  const deletableStatusIds = [1, 6];
  const canDelete =
    !!me?.id &&
    me.id === memo?.userId &&
    deletableStatusIds.includes(currentStatusId ?? 0) &&
    !hasAnyApproved;

  const handleDelete = async () => {
    if (!id || deleting) return;
    if (!canDelete) {
      toast.error(t("error.deleteNotAllowed"));
      return;
    }
    try {
      setDeleting(true);
      await api.delete(`/api/memos/${id}`, { withCredentials: true });
      toast.success(t("success.deleted"));
      setShowDeleteModal(false);
      navigate("/dashboard", { replace: true });
    } catch (err: unknown) {
      const msg =
        err &&
        typeof err === "object" &&
        "response" in err &&
        err.response &&
        typeof err.response === "object" &&
        "data" in err.response &&
        err.response.data &&
        typeof err.response.data === "object" &&
        "message" in err.response.data
          ? (err.response.data as { message: string }).message
          : err &&
              typeof err === "object" &&
              "message" in err &&
              typeof err.message === "string"
            ? err.message
            : t("error.deleteFailed");
      toast.error(msg);
    } finally {
      setDeleting(false);
    }
  };

  // ===== initial load: โหลด PDF + meta ทันที และโหลดผู้ใช้/ลายเซ็นแบบขนาน =====
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    // เริ่มโหลด meta + ตั้ง pdfUrl ทันที
    loadData({ refreshPdf: true });

    // โหลดผู้ใช้/ลายเซ็นแบบขนาน (ไม่ต้องรอ PDF)
    (async () => {
      const currentUser = await fetchCurrentUser();
      if (!currentUser || cancelled) return;
      setMe(currentUser);

      try {
        const res = await api.get<UserSignaturesResponse>(
          `/api/users/${currentUser.id}/signatures`,
          { withCredentials: true },
        );
        if (cancelled) return;
        setUserSignatures(res.data.signatures);
        setDefaultSignatureId(res.data.defaultSignatureId ?? null);
      } catch {
        toast.error(t("error.cannotLoadSignatures"));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, loadData, t]);

  // Language change detection and loading state management
  useEffect(() => {
    const handleLanguageChange = () => {
      setIsLanguageLoading(true);

      // Set a timeout to hide loading screen after translations are loaded
      const timer = setTimeout(() => {
        setIsLanguageLoading(false);
      }, 500); // Adjust timing as needed

      return () => clearTimeout(timer);
    };

    // Listen for language change events
    i18n.on("languageChanged", handleLanguageChange);

    return () => {
      i18n.off("languageChanged", handleLanguageChange);
    };
  }, [i18n]);

  // Refresh เมื่อแท็บกลับมา visible (ไม่มี polling)
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (refreshLockRef.current) return; // กันยิงซ้ำจาก event หลายตัว
      refreshLockRef.current = true;
      loadData().finally(() => {
        refreshLockRef.current = false;
      });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadData]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ⬇️ Auto-open ApproveWithConditionModal when coming from email link
  const autoOpenTriggeredRef = useRef(false);
  useEffect(() => {
    if (autoOpenTriggeredRef.current) return;
    const action = searchParams.get("action");
    if (action !== "approve-with-condition") return;
    if (!memo || !me || approverGroups.length === 0) return;
    if (currentStatusId !== 5) return; // only when memo is Processing

    // Find user's pending approval
    const waitingLvls = approverGroups
      .filter((g) => g.users.some((u) => u.status === "waiting"))
      .map((g) => g.level);
    const minLvl = waitingLvls.length ? Math.min(...waitingLvls) : null;

    const myGroup = approverGroups.find((grp) =>
      grp.users.some(
        (u) => u.id === me.id && u.status === "waiting" && grp.level === minLvl,
      ),
    );
    const myApproverInfo = myGroup?.users.find((u) => u.id === me.id);

    if (myApproverInfo) {
      autoOpenTriggeredRef.current = true;
      const requiresSig = !!myApproverInfo.isSigReq;
      setPendingPivotId(myApproverInfo.loaUserPivotId);
      setPendingPivotRequiresSig(requiresSig);
      setShowApproveWithConditionModal(true);
    }
  }, [memo, me, approverGroups, searchParams, currentStatusId]);

  // ---------- approve ----------
  const flatApprovers = approverGroups.flatMap((g) => g.users);

  // Calculate level-based progress instead of individual approver progress
  const calculateLevelProgress = () => {
    if (approverGroups.length === 0) return { completed: 0, total: 0, percentage: 0 };
    
    let completedLevels = 0;
    const totalLevels = approverGroups.length;
    
    for (const group of approverGroups) {
      const approvedUsers = group.users.filter(u => u.status === "approved");
      const notRequiredUsers = group.users.filter(u => u.status === "not_required");
      const totalApprovedOrNotRequired = approvedUsers.length + notRequiredUsers.length;
      
      // Check if level is complete based on approval requirement
      const firstUser = group.users[0];
      const approvalRequirement = firstUser?.approvalRequirement || "ALL";
      
      let isLevelComplete = false;
      if (approvalRequirement === "ANY") {
        // For ANY: level is complete if at least one user approved
        isLevelComplete = approvedUsers.length > 0;
      } else {
        // For ALL: level is complete if all users approved or not_required
        isLevelComplete = totalApprovedOrNotRequired === group.users.length;
      }
      
      if (isLevelComplete) {
        completedLevels++;
      }
    }
    
    const percentage = totalLevels > 0 ? Math.round((completedLevels / totalLevels) * 100) : 0;
    return { completed: completedLevels, total: totalLevels, percentage };
  };

  const levelProgress = calculateLevelProgress();

  const waitingLevels = approverGroups
    .filter((g) => g.users.some((u) => u.status === "waiting"))
    .map((g) => g.level);

  const minWaitingLevel: number | null = waitingLevels.length
    ? Math.min(...waitingLevels)
    : null;
  const approverIds: number[] = flatApprovers.map((u) => u.id);
  const isApprover = me != null && approverIds.includes(me.id);

  const amIWaitingAtMinLevel =
    isApprover &&
    typeof minWaitingLevel === "number" &&
    approverGroups
      .find((g) => g.level === minWaitingLevel)
      ?.users.some((u) => u.id === me?.id && u.status === "waiting") === true;

  const canTerminate = isProcessing && !isTerminated && amIWaitingAtMinLevel;

  // ⬇️ Auto-open TerminateReasonModal when coming from email link
  const autoOpenTerminateRef = useRef(false);
  useEffect(() => {
    if (autoOpenTerminateRef.current) return;
    const action = searchParams.get("action");
    if (action !== "terminate") return;
    if (!memo || !me || approverGroups.length === 0) return;

    if (canTerminate) {
      autoOpenTerminateRef.current = true;
      setTerminateModalOpen(true);
    }
  }, [memo, me, approverGroups, searchParams, canTerminate]);

  // ⬇️ Auto-open RejectReasonModal when coming from email link
  const autoOpenRejectRef = useRef(false);
  useEffect(() => {
    if (autoOpenRejectRef.current) return;
    const action = searchParams.get("action");
    if (action !== "reject") return;
    if (!memo || !me || approverGroups.length === 0) return;
    if (currentStatusId !== 5) return; // only when memo is Processing

    // Find user's pending approval
    const waitingLvls = approverGroups
      .filter((g) => g.users.some((u) => u.status === "waiting"))
      .map((g) => g.level);
    const minLvl = waitingLvls.length ? Math.min(...waitingLvls) : null;

    const myGroup = approverGroups.find((grp) =>
      grp.users.some(
        (u) => u.id === me.id && u.status === "waiting" && grp.level === minLvl,
      ),
    );
    const myApproverInfo = myGroup?.users.find((u) => u.id === me.id);

    if (myApproverInfo && amIWaitingAtMinLevel) {
      autoOpenRejectRef.current = true;
      setRejectingPivotId(myApproverInfo.loaUserPivotId);
      setRejectModalOpen(true);
    }
  }, [memo, me, approverGroups, searchParams, amIWaitingAtMinLevel, currentStatusId]);

  const handlePublish = async () => {
    if (!memo?.id || !me?.id) {
      toast.error("Missing memo or user info");
      return;
    }
    try {
      await api.post(
        `/api/memos/${id}/status`,
        {
          memoId: memo.id,
          userId: me.id,
          statusId: 5,
        },
        { withCredentials: true },
      );
      toast.success(t("success.publish"));
      await loadData({ refreshPdf: true });
    } catch (err) {
      console.error("Publish failed:", err);
      toast.error(t("error.publishFail"));
    }
  };

  // ⬇️ NEW: Centralized Approval Logic
  const handleApproveRequest = async (
    loaUserPivotId: number,
    requiresSignature: boolean,
  ) => {
    if (extraBusy) {
      toast.error(
        t("extra.busyError", "มีไลน์อนุมัติเพิ่มเติมกำลังดำเนินการอยู่"),
      );
      return;
    }
    if (isExpired) {
      toast.error(t("expired", "หมดอายุแล้ว"));
      return;
    }

    if (requiresSignature) {
      setPendingPivotId(loaUserPivotId);
      setShowApproveModal(true);
    } else {
      // Approve directly
      await handleConfirmApprove(loaUserPivotId, { statusCode: "approved" });
    }
  };

  const handleConfirmApprove = async (
    loaUserId: number,
    payload: {
      statusCode: string;
      signatureText?: string;
      signatureImageId?: number;
    },
  ) => {
    console.log(
      `[MemoViewer.handleConfirmApprove] START - loaUserId=${loaUserId}, payload=`,
      payload,
    );
    try {
      if (payload.signatureText || payload.signatureImageId) {
        await api.post(
          `/api/memos/${id}/action-signature`,
          {
            loaUserId,
            ...payload,
          },
          { withCredentials: true },
        );
      } else {
        await api.post(
          `/api/memos/${id}/action`,
          {
            loaUserId,
            statusCode: "approved",
          },
          { withCredentials: true },
        );
      }
      console.log(
        `[MemoViewer.handleConfirmApprove] Approval successful, calling loadData...`,
      );
      toast.success(t("approvers.signsuccess"));
      await loadData({ refreshPdf: true });
      console.log(`[MemoViewer.handleConfirmApprove] loadData completed`);

      // ✅ Check if there are more pending documents before showing modal
      try {
        const { data } = await api.get("/api/memos/awaiting-approval", {
          withCredentials: true,
        });

        const hasMore =
          data && data.length > 0 && data.some((m: any) => m.id !== Number(id));
        setHasMorePendingDocs(hasMore);
      } catch (error) {
        console.error("Failed to check pending documents:", error);
        setHasMorePendingDocs(false);
      }

      setShowNextMemoModal(true);
    } catch (err: any) {
      console.error("handleConfirmApprove error:", err);

      // ✅ Handle 409 MEMO_STATUS_CHANGED - use i18n to translate status code
      if (
        err?.response?.status === 409 &&
        err?.response?.data?.code === "MEMO_STATUS_CHANGED"
      ) {
        const statusCode = err?.response?.data?.statusCode || "UNKNOWN";
        const errorMsg = t(
          `error.statusChanged.${statusCode}`,
          t("error.statusChanged.UNKNOWN"),
        );
        toast.error(errorMsg, { duration: 5000 });

        // Auto-refresh data to show current state
        await loadData({ refreshPdf: true });
        return; // Don't rethrow - we handled it
      }

      toast.error(t("approvers.signfail"));
      throw err; // rethrow for modal to handle if needed
    }
  };

  // ⬇️ Approve With Condition handlers
  const handleApproveWithConditionRequest = async (
    loaUserPivotId: number,
    requiresSignature: boolean,
  ) => {
    if (extraBusy) {
      toast.error(
        t("extra.busyError", "An extra approval line is currently in progress"),
      );
      return;
    }
    if (isExpired) {
      toast.error(t("expired", "Expired"));
      return;
    }
    setPendingPivotId(loaUserPivotId);
    setPendingPivotRequiresSig(requiresSignature);
    setShowApproveWithConditionModal(true);
  };

  const handleConfirmApproveWithCondition = async (
    loaUserId: number,
    payload: {
      statusCode: string;
      signatureText?: string;
      signatureImageId?: number;
      approveWithCondition: string;
    },
  ) => {
    try {
      await api.post(
        `/api/memos/${id}/action-signature`,
        {
          loaUserId,
          ...payload,
        },
        { withCredentials: true },
      );

      toast.success(t("approvers.signsuccess"));
      await loadData({ refreshPdf: true });

      try {
        const { data } = await api.get("/api/memos/awaiting-approval", {
          withCredentials: true,
        });
        const hasMore =
          data && data.length > 0 && data.some((m: any) => m.id !== Number(id));
        setHasMorePendingDocs(hasMore);
      } catch {
        setHasMorePendingDocs(false);
      }

      setShowNextMemoModal(true);
    } catch (err) {
      console.error(err);
      toast.error(t("approvers.signfail"));
      throw err;
    }
  };

  const handleGoToNextMemo = async () => {
    setLoadingNextMemo(true);
    try {
      const { data } = await api.get("/api/memos/awaiting-approval", {
        withCredentials: true,
      });

      if (data && data.length > 0) {
        const nextMemo = data.find((m: any) => m.id !== Number(id));

        if (nextMemo) {
          navigate(`/memo/${nextMemo.id}`);
          setShowNextMemoModal(false);
        } else if (data.length > 1) {
          navigate(`/memo/${data[1].id}`);
          setShowNextMemoModal(false);
        } else {
          toast(t("approvers.noMorePending", "ไม่มีเอกสารรออนุมัติแล้ว"), {
            icon: (
              <FontAwesomeIcon icon={faCircleInfo} className="text-blue-900" />
            ),
          });
          setShowNextMemoModal(false);
          navigate("/dashboard");
        }
      } else {
        toast(t("approvers.noMorePending", "ไม่มีเอกสารรออนุมัติแล้ว"), {
          icon: (
            <FontAwesomeIcon icon={faCircleInfo} className="text-blue-900" />
          ),
        });
        setShowNextMemoModal(false);
        navigate("/dashboard");
      }
    } catch (error) {
      console.error("Failed to fetch next memo:", error);
      toast.error(
        t("approvers.fetchNextFailed", "ไม่สามารถโหลดเอกสารถัดไปได้"),
      );
      setShowNextMemoModal(false);
    } finally {
      setLoadingNextMemo(false);
    }
  };

  const handleCloseNextMemoModal = () => {
    setShowNextMemoModal(false);
  };

  const handleRejectRequest = async (loaUserPivotId: number) => {
    // Open modal instead of direct reject
    setRejectingPivotId(loaUserPivotId);
    setRejectModalOpen(true);
  };

  const handleConfirmReject = async (reason: string) => {
    if (!rejectingPivotId) return;
    
    if (extraBusy) {
      toast.error("มี Extra approval line กำลังดำเนินการอยู่");
      return;
    }
    if (!me?.id) {
      toast.error("Missing user info");
      return;
    }
    const snapshot = approverGroups;
    setApproverGroups((prev) => markRejected(prev, rejectingPivotId));
    try {
      await api.post(
        `/api/memos/${id}/status`,
        {
          statusId: 4,
          userId: me.id,
          rejectReason: reason,
        },
        { withCredentials: true },
      );
      setRejectModalOpen(false);
      setRejectingPivotId(null);
      await loadData({ refreshPdf: true });
    } catch (err: any) {
      setApproverGroups(snapshot);
      console.error("handleRejectRequest error:", err);

      // ✅ Handle 409 MEMO_STATUS_CHANGED - use i18n to translate status code
      if (
        err?.response?.status === 409 &&
        err?.response?.data?.code === "MEMO_STATUS_CHANGED"
      ) {
        const statusCode = err?.response?.data?.statusCode || "UNKNOWN";
        const errorMsg = t(
          `error.statusChanged.${statusCode}`,
          t("error.statusChanged.UNKNOWN"),
        );
        toast.error(errorMsg, { duration: 5000 });

        // Auto-refresh data to show current state
        await loadData({ refreshPdf: true });
        return;
      }

      toast.error(t("error.rejectFail"));
    }
  };

  // Show access denied or deleted screen
  if (accessError) {
    const isDeleted = accessError.code === 410;

    if (isDeleted) {
      return <DeletedMemo />;
    }

    const title = t("accessDenied.title", "Access Denied");
    const hint = t(
      "accessDenied.hint",
      "If you believe you should have access to this memo, please contact the memo owner or your administrator.",
    );

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-red-50 to-orange-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
          {/* Header with gradient */}
          <div className="bg-gradient-to-r from-red-500 to-orange-500 p-6">
            <div className="flex items-center justify-center">
              <div className="w-16 h-16 bg-white/20 backdrop-blur-sm rounded-full flex items-center justify-center">
                <svg
                  className="w-10 h-10 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  {isDeleted ? (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1-1H8a1 1 0 00-1 1v3M4 7h16"
                    />
                  ) : (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                    />
                  )}
                </svg>
              </div>
            </div>
          </div>
          <div className="p-8 text-center">
            <h2 className="text-2xl font-bold text-gray-900 mb-2">{title}</h2>
            <p className="text-red-600 font-medium mb-4">
              {t("accessDenied.message", "You do not have access to this memo")}
            </p>
            <p className="text-gray-500 mb-8">{hint}</p>

            <button
              onClick={() => navigate("/dashboard")}
              className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-xl text-white bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-700 hover:to-orange-700 shadow-lg hover:shadow-xl transition-all duration-300 transform hover:-translate-y-0.5"
            >
              <svg
                className="w-5 h-5 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 19l-7-7m0 0l7-7m-7 7h18"
                />
              </svg>
              {t("btnBackToDashboard", "Back to Dashboard")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!memo) {
    return <LoadingScreen />;
  }

  // Show loading screen during language change
  if (isLanguageLoading) {
    return <LoadingScreen />;
  }

  return (
    <div className="w-full h-full flex flex-col md:flex-row bg-gray-100 text-gray-800 overflow-hidden">
      {/* ===== Left pane ===== */}
      <div
        className={`
    hidden md:flex w-full md:w-auto
    ${pdfOpen ? "fixed inset-0 z-50 flex" : ""}
    relative
    flex-1 bg-white flex-col h-full min-w-0 min-h-0
  `}
      >
        {/* 👉 ด้ามจับตอนแถบขวา “ปิด” */}

        {/* ปุ่มเปิด Right Panel (เมื่อแถบปิดอยู่ - Button on Right Edge of Screen) */}
        {!rightOpen && (
          <button
            onClick={() => setRightOpen(true)}
            className="hidden md:flex flex-col items-center justify-center
               absolute top-1/2 -translate-y-1/2 right-0 z-20 
               w-7 h-20 rounded-l-2xl
               bg-gray-500 hover:bg-gray-600
               text-white hover:text-white
               shadow-[-4px_0_12px_rgba(0,0,0,0.1)] hover:shadow-[-6px_0_16px_rgba(0,0,0,0.15)]
               transition-all duration-300 ease-out
               group overflow-hidden cursor-pointer"
            title={t("rightPanel.show", "แสดงแถบเครื่องมือ")}
            aria-label="Show right panel"
          >
            {/* Decoration line */}

            <svg
              className="w-6 h-6 transform group-hover:scale-125 transition-transform duration-300 relative z-10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
        )}
        {/* ปุ่มปิด เฉพาะมือถือ */}
        <button
          onClick={() => setPdfOpen(false)}
          className="md:hidden self-end m-4 p-2 rounded-full bg-gray-100 hover:bg-gray-200"
        >
          ✕
        </button>

        {/* Header Section - Fixed */}
        <div className="flex-shrink-0 p-4 ">
          <div className="w-full flex items-center justify-between mb-4">
            <button
              onClick={() => navigate(-1)}
              className="text-gray-600 hover:text-gray-900 transition-colors flex items-center gap-1"
            >
            </button>

            {/* Action Buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* ⛔️ หมดอายุ: ซ่อนทุกปุ่มเปลี่ยนสถานะ */}
              {!isExpired && !isTerminated && !isReferenceMode && (
                <>
                  {/* Edit Button */}
                  {me?.id === memo.userId && isEditable && (
                    <button
                      onClick={() => navigate(`/memos/${memo.id}/edit`)}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg shadow-lg hover:shadow-xl transition-all duration-300 transform hover:-translate-y-0.5 focus:ring-2 focus:ring-green-400 font-semibold flex items-center gap-2"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                      </svg>
                      {t("btnEdit")}
                    </button>
                  )}

                  {/* Recall/Revise Buttons */}
                  {me?.id === memo.userId && currentStatusId === 4 && (
                    <div className="flex gap-2">
                      <button
                        onClick={handleRecallClear}
                        className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg shadow-md transition-all duration-200 font-medium flex items-center gap-2 text-sm"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-5 w-5"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                        >
                          <path
                            fillRule="evenodd"
                            d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                            clipRule="evenodd"
                          />
                        </svg>
                        {t("btnRevise")}
                      </button>
                    </div>
                  )}

                  {/* Recall Buttons */}
                  {me?.id === memo.userId && currentStatusId === 5 && (
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          runOnce("recallClear", handleRecallClear)
                        }
                        className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-lg shadow-md hover:shadow-lg transition-all duration-300 font-medium flex items-center gap-2"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-5 w-5"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                        >
                          <path
                            fillRule="evenodd"
                            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                            clipRule="evenodd"
                          />
                        </svg>
                        {t("btnRecall")}
                      </button>
                    </div>
                  )}

                  {/* Publish Button */}
                  {me?.id === memo.userId && currentStatusId === 1 && (
                    <button
                      onClick={() => runOnce("publish", handlePublish)}
                      className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg shadow-lg hover:shadow-xl transition-all duration-300 transform hover:-translate-y-0.5 focus:ring-2 focus:ring-sky-400 font-semibold flex items-center gap-2"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-5 w-5"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
                        <path
                          fillRule="evenodd"
                          d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {t("btnPublish")}
                    </button>
                  )}
                </>
              )}

              {/* Terminate Button (ยังคงคอมเมนต์ไว้ และถูกครอบด้วย !isExpired ด้วย) */}
            </div>
          </div>

          {/* Progress Bar */}
          <div className="w-full flex flex-col items-center gap-4">
            <div className="w-3/4 max-w-2xl">
              <div className="flex justify-between mb-1">
                <span className="text-sm font-medium text-gray-600">
                  Approval process:{" "}
                  {levelProgress.completed}/{levelProgress.total} levels
                </span>
                <span className="text-sm font-medium text-gray-600">
                  {levelProgress.percentage}%
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className="bg-gradient-to-r from-green-900 to-green-600 h-2.5 rounded-full transition-all duration-500 ease-in-out"
                  style={{
                    width: `${levelProgress.percentage}%`,
                  }}
                ></div>
              </div>
            </div>

            {/* Pagination Controls */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 lg:gap-4">
              <button
                className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 shadow-sm hover:shadow-md flex items-center justify-center transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed group"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <svg
                  className="w-5 h-5 text-gray-600 group-hover:text-green-800 group-disabled:group-hover:text-gray-600 transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M15 19l-7-7 7-7"
                  ></path>
                </svg>
              </button>
              <label
                htmlFor="gotoPage"
                className="flex items-center justify-center h-10 bg-gray-100 rounded-lg shadow-inner px-2 cursor-text select-none"
              >
                <input
                  id="gotoPage"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={numPages}
                  step={1}
                  value={pageInput}
                  onChange={(e) =>
                    setPageInput(e.target.value.replace(/[^\d]/g, ""))
                  }
                  onKeyDown={(e) => e.key === "Enter" && commitPageInput()}
                  onBlur={commitPageInput}
                  onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                  className="w-[2ch] min-w-[2ch] max-w-[3ch] h-6 leading-6 text-center bg-transparent font-medium text-gray-700 p-0 m-0 border-0 outline-none
               [appearance:textfield] [-moz-appearance:textfield]
               [&::-webkit-outer-spin-button]:appearance-none
               [&::-webkit-inner-spin-button]:appearance-none tabular-nums"
                  aria-label="Go to page"
                />
                <span className="text-gray-400 mx-1 leading-6">/</span>
                <span className="font-medium text-gray-700 leading-6 tabular-nums px-1">
                  {numPages}
                </span>
              </label>

              <button
                className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 shadow-sm hover:shadow-md flex items-center justify-center transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed group"
                disabled={page >= numPages}
                onClick={() => setPage((p) => p + 1)}
              >
                <svg
                  className="w-5 h-5 text-gray-600 group-hover:text-green-800 group-disabled:group-hover:text-gray-600 transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M9 5l7 7-7 7"
                  ></path>
                </svg>
              </button>

              {/* Go to Page controls - only show for multi-page PDFs */}
              {numPages > 1 && !pdfMissing && (
                <>
                  {/* Visual separator - hidden on mobile */}
                  <div
                    className="hidden sm:block h-8 w-px bg-gray-300 mx-1"
                    aria-hidden="true"
                  ></div>

                  {/* Go to Page Input - responsive width */}
                  <input
                    ref={gotoPageInputRef}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={numPages}
                    value={gotoPageInput}
                    placeholder={t("gotoPage.placeholder")}
                    className="w-14 sm:w-16 h-10 px-2 text-center bg-white border border-gray-300 rounded-lg 
                               focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                               [appearance:textfield] [-moz-appearance:textfield]
                               [&::-webkit-outer-spin-button]:appearance-none
                               [&::-webkit-inner-spin-button]:appearance-none
                               disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={t("gotoPage.ariaLabel")}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    disabled={pdfLoading || !pdfUrl || numPages === 0}
                  />

                  {/* Go to Page Button - icon only on mobile, with text on larger screens */}
                  <button
                    onClick={handleGotoPage}
                    disabled={
                      !isValidPageInput ||
                      pdfLoading ||
                      !pdfUrl ||
                      numPages === 0
                    }
                    className="h-10 px-3 sm:px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-lg
                               shadow-md transition-all disabled:opacity-40 disabled:cursor-not-allowed
                               flex items-center gap-2"
                    aria-label={t("gotoPage.btnLabel")}
                  >
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                    <span className="hidden sm:inline text-sm font-medium">
                      {t("gotoPage.btnText")}
                    </span>
                  </button>

                  {/* Zoom Controls */}
                  <div
                    className="hidden sm:block h-8 w-px bg-gray-300 mx-1"
                    aria-hidden="true"
                  ></div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={handleZoomOut}
                      disabled={zoomLevel <= ZOOM_MIN}
                      className="w-9 h-9 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 shadow-sm hover:shadow-md flex items-center justify-center transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed group"
                      aria-label="Zoom out"
                      title="Zoom out (Ctrl + Scroll down)"
                    >
                      <svg className="w-4 h-4 text-gray-600 group-hover:text-green-800 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 12H4" />
                      </svg>
                    </button>
                    <button
                      onClick={handleZoomReset}
                      className="h-9 px-2 rounded-lg bg-gradient-to-br from-gray-100 to-gray-200 shadow-sm hover:shadow-md flex items-center justify-center transition-all duration-200 group min-w-[3.5rem]"
                      aria-label="Reset zoom"
                      title="Reset zoom to fit"
                    >
                      <span className="text-xs font-medium text-gray-600 group-hover:text-green-800 transition-colors tabular-nums">
                        {Math.round(zoomLevel * 100)}%
                      </span>
                    </button>
                    <button
                      onClick={handleZoomIn}
                      disabled={zoomLevel >= ZOOM_MAX}
                      className="w-9 h-9 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 shadow-sm hover:shadow-md flex items-center justify-center transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed group"
                      aria-label="Zoom in"
                      title="Zoom in (Ctrl + Scroll up)"
                    >
                      <svg className="w-4 h-4 text-gray-600 group-hover:text-green-800 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                  </div>
                </>
              )}

              {/* Visual separator - hidden on mobile */}
              <div
                className="hidden sm:block h-8 w-px bg-gray-300 mx-1"
                aria-hidden="true"
              ></div>

              {/* Refresh */}
              <button
                onClick={() => {
                  setPdfUrl(null); // unmount ก่อน
                  setTimeout(() => loadData({ refreshPdf: true }), 0); // แล้วค่อย set ใหม่
                }}
                className="bg-gray-100 hover:bg-gray-200 text-gray-700 p-2 rounded-full shadow-md transition-all"
                aria-label={t("btnRefresh") || "Refresh"}
                title={t("btnRefresh") || "Refresh"}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-6 h-6"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                  />
                </svg>
              </button>

              {/* Delete */}
              {canDelete && !isReferenceMode && (
                <button
                  onClick={() => setShowDeleteModal(true)}
                  disabled={deleting}
                  className="hidden md:flex bg-red-200 hover:bg-red-300 text-red-800 p-2 rounded-full shadow-md transition-all disabled:opacity-50"
                  aria-label={t("btnDelete") || "Delete"}
                  title={t("btnDelete") || "Delete"}
                >
                  {deleting ? (
                    <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="w-6 h-6"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.02.166m-1.02-.165L18.16 19.673A2.25 2.25 0 0 1 15.917 21.75H8.083a2.25 2.25 0 0 1-2.243-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.338-.059.678-.114 1.02-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.02-2.09 2.2v.917m7.5 0a48.667 48.667 0 0 0-7.5 0"
                      />
                    </svg>
                  )}
                </button>
              )}
              {/* Download */}
              <button
                onClick={handleDownload}
                className="flex items-center gap-2 bg-[#00e89a] hover:bg-[#DFDFD1] text-lime-900 px-3 py-2 rounded-xl shadow-md transition-all"
                aria-label={t("btnDownload")}
                title={t("btnDownload")}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-5 h-5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
                  />
                </svg>
                <span className="text-sm font-medium">
                  {t("btnDownload", "ดาวน์โหลดเอกสาร")}
                </span>
              </button>
              {/* View PDF Modal */}
              <button
                onClick={() => setPdfOpen(true)}
                className="flex items-center gap-2 bg-blue-500 hover:bg-blue-600 text-white px-3 py-2 rounded-xl shadow-md transition-all"
                aria-label={t("btnViewPdfModal", "View PDF")}
                title={t("btnViewPdfModal", "View PDF")}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-5 h-5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                  />
                </svg>
                <span className="text-sm font-medium">
                  {t("btnViewPdfModal", "View PDF")}
                </span>
              </button>
              
              {/* Print Button */}
              <button
                onClick={() => {
                  if (id) {
                    // ใช้แบบ id ไปก่อนสำหรับปุ่ม Print
                    window.open(`/api/memos/${id}/download?inline=1`, "_blank");
                    // แบบชื่อไฟล์ ภาษาไทยมันขึ้น get api error not found
                    //const safeSubject = memo?.subject?.replace(/[\/\\?%*:|"<>]/g, " ").trim() || "document";
                    //const safeMemoNumber = memo?.memonumber?.replace(/[\/\\?%*:|"<>]/g, " ").trim() || `memo-${id}`;
                    //window.open(`/api/memos/${id}/download/${safeMemoNumber}-${safeSubject}.pdf?inline=1`, "_blank");
                  }
                }}
                disabled={!id}
                className="flex items-center gap-2 bg-purple-500 hover:bg-purple-600 text-white px-3 py-2 rounded-xl shadow-md transition-all disabled:opacity-50"
                aria-label={t("btnPrint", "Print")}
                title={t("btnPrint", "Print")}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-5 h-5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-14.326 0C3.768 7.44 3 8.375 3 9.456v6.294A2.25 2.25 0 0 0 5.25 18h1.091M12 10.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Zm5.25-7.5H6.75A2.25 2.25 0 0 0 4.5 5.25v2.25h15V5.25A2.25 2.25 0 0 0 17.25 3Z"
                  />
                </svg>
                <span className="text-sm font-medium">
                  {t("btnPrint", "พิมพ์เอกสาร")}
                </span>
              </button>

            </div>
          </div>
        </div>

        {/* PDF Container - Scrollable */}
        <div className="flex-1 min-h-0 flex items-center justify-center p-4">
          <div
            ref={pdfContainerRef} // 👈 วัดที่กรอบนี้เท่านั้น
            className="relative shadow-lg rounded-xl w-full h-full overflow-hidden"
          >
            {/* Overlay โหลด PDF */}
            {pdfLoading && (
              <div className="absolute inset-0 z-10 bg-white/70 backdrop-blur-sm flex flex-col items-center justify-center">
                <div className="w-10 h-10 border-4 border-gray-300 border-t-gray-700 rounded-full animate-spin" />
                {pdfProgress != null && (
                  <div className="mt-3 text-sm text-gray-700">
                    {pdfProgress}%
                  </div>
                )}
                <div className="mt-1 text-xs text-gray-500">
                  {t("loadingpdf", "กำลังโหลด PDF")}
                </div>
              </div>
            )}

            <div ref={pdfScrollRef} className="h-full overflow-auto p-6 pt-16">
              {/* min-width: 100% + text-align center = ถ้า content เล็กกว่า viewport จะอยู่กลาง, ถ้าใหญ่กว่าจะ scroll ได้ทั้งซ้ายขวา */}
              <div className="inline-block min-w-full text-center">
                {pdfMissing && (
                  <div className="flex flex-col items-center justify-center py-20 text-gray-500">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-16 w-16 mb-4 text-gray-300"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    <p className="text-lg font-medium">
                      {t("error.pdfMissing")}
                    </p>
                    <p className="text-sm mt-1">
                      {t("error.pdfMissingDesc")}
                    </p>
                  </div>
                )}
                {pdfUrl && !pdfOpen && !pdfMissing && (
                  <Document
                    key={pdfUrl}
                    file={pdfUrl}
                    className="inline-block"
                    onLoadSuccess={({ numPages }) => {
                      setNumPages(numPages);
                      setPdfLoading(false);
                      recalc(); // ✅ บังคับวัดอีกครั้งหลัง PDF mount
                    }}
                    onLoadError={(e) => {
                      setPdfLoading(false);
                      setPdfMissing(true);
                      toast.error(
                        t("error.pdfMissing", "ไม่พบไฟล์ PDF") +
                          " / " +
                          t("error.pdfMissingDesc", "ไฟล์อาจถูกลบออกจากระบบ"),
                      );
                      console.error(e);
                    }}
                    onSourceError={(e) => {
                      setPdfLoading(false);
                      setPdfMissing(true);
                      toast.error(
                        t("error.pdfMissing", "ไม่พบไฟล์ PDF") +
                          " / " +
                          t("error.pdfMissingDesc", "ไฟล์อาจถูกลบออกจากระบบ"),
                      );
                      console.error(e);
                    }}
                    onLoadProgress={({ loaded, total }) => {
                      if (total)
                        setPdfProgress(Math.round((loaded / total) * 100));
                    }}
                  >
                    <Page
                      pageNumber={page}
                      width={pageWidth}
                      renderAnnotationLayer={false}
                      renderTextLayer={false}
                      className="block shadow-lg"
                    />
                  </Document>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ====== Right pane (Tabs) ====== */}
      <div
        className={`
    relative
    flex flex-col h-full min-h-0 bg-white md:border-l border-gray-200
    transition-all duration-300
    ${
      rightOpen
        ? "md:w-[420px] md:min-w-[420px] md:max-w-[420px] opacity-100"
        : "md:w-0 md:min-w-0 md:max-w-0 opacity-0 pointer-events-none"
    }
  `}
        aria-hidden={!rightOpen}
      >
        {/* 👉 ด้ามจับตอนแถบขวา “เปิด” (Button on Left Edge of Right Panel) */}
        {rightOpen && (
          <button
            onClick={() => setRightOpen(false)}
            className="hidden md:flex flex-col items-center justify-center
               absolute top-1/2 -translate-y-1/2 -left-7 z-20 
               w-7 h-20 rounded-l-2xl
               bg-gray-500 hover:bg-gray-800
               text-white hover:text-white
               shadow-[-4px_0_12px_rgba(0,0,0,0.1)] hover:shadow-[-6px_0_16px_rgba(0,0,0,0.15)]
               transition-all duration-300 ease-out
               group"
            title={t("rightPanel.hide", "ซ่อนแถบเครื่องมือ")}
            aria-label="Hide right panel"
          >
            <svg
              className="w-6 h-6 transform group-hover:scale-125 transition-transform duration-300 relative z-10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 5l7 7-7 7"
              />
            </svg>
          </button>
        )}
        <div
          className={`flex-1 min-h-0 w-full p-2 sm:p-4 ${
            activeTab === "comment" ? "overflow-hidden" : "overflow-y-auto"
          }`}
        >
          <div className="h-full flex flex-col w-full max-w-screen-lg mx-auto">
            {/* ===== Quick Action Buttons (Always Visible Above Tabs) ===== */}
            {(() => {
              // Find if current user has pending action
              const flatApprovers = approverGroups.flatMap((g) => g.users);
              const waitingLevels = approverGroups
                .filter((g) => g.users.some((u) => u.status === "waiting"))
                .map((g) => g.level);
              const minLevel = waitingLevels.length
                ? Math.min(...waitingLevels)
                : null;

              const myPendingApproval = approverGroups.find((grp) =>
                grp.users.some(
                  (u) =>
                    u.id === me?.id &&
                    u.status === "waiting" &&
                    grp.level === minLevel &&
                    isInApproval,
                ),
              );

              const myApprover = myPendingApproval?.users.find(
                (u) => u.id === me?.id,
              );

              // Check if current user is in extra line and waiting
              const myExtraWaiting =
                extraLine && me?.id
                  ? (() => {
                      const myApprover = extraLine.approvers?.find(
                        (a) => a.user.id === me.id,
                      );
                      const isPending =
                        !myApprover?.status ||
                        myApprover?.status?.name?.toUpperCase?.() === "WAITING";
                      const lineOk = ["PENDING", "IN_PROGRESS"].includes(
                        (extraLine.status ?? "").toUpperCase(),
                      );
                      return !!myApprover && isPending && lineOk;
                    })()
                  : false;

              // Check if there's an extra approval line (either blocking or user is assigned)
              // Hide extra approval line notice if memo is terminated
              const hasExtraNotice =
                !isTerminated && (extraBusy || myExtraWaiting);

              // If no action buttons and no extra notice, don't render anything
              if (!myApprover && !hasExtraNotice) return null;

              return (
                <div className="shrink-0 mb-8 space-y-3">
                  {/* Consolidated Extra Approval Line Notice */}
                  {hasExtraNotice && (
                    <div
                      className={`rounded-xl border shadow-sm ${
                        myExtraWaiting
                          ? "border-amber-200 bg-gradient-to-r from-amber-50 to-amber-100 text-amber-900/95"
                          : "border-amber-200 bg-amber-50/90 text-amber-900"
                      }`}
                      role="alert"
                      aria-live="polite"
                    >
                      <div className="flex items-start gap-3 p-3">
                        <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-100">
                          <svg
                            className="h-4 w-4 text-amber-700"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16c-.77.833.192 2.5 1.732 2.5z"
                            />
                          </svg>
                        </span>
                        <div className="flex-1 min-w-0">
                          {myExtraWaiting ? (
                            // User is assigned as extra approver
                            <>
                              <p className="text-sm font-semibold">
                                {t("extra.noticeTitle", "Additional approvals")}
                              </p>
                              <p className="mt-0.5 text-xs text-amber-800">
                                {t(
                                  "extra.noticeBody",
                                  "You've been assigned as an extra approver. Tap to go to approval.",
                                )}
                              </p>
                            </>
                          ) : extraLine && extraLine.approvers.length > 0 ? (
                            // Extra line is blocking with approver names
                            <>
                              <p className="text-sm font-semibold">
                                {t(
                                  "extra.inProgressTitleWithApprovers",
                                  "Extra approval line by",
                                )}{" "}
                                <span className="text-amber-950">
                                  {extraLine.approvers
                                    .map((a) => {
                                      const fullName = [
                                        a.user.name,
                                        a.user.lastname,
                                      ]
                                        .filter(Boolean)
                                        .join(" ");
                                      return fullName || `User #${a.user.id}`;
                                    })
                                    .join(", ")}
                                </span>{" "}
                                {t("extra.inProgressSuffix", "in progress...")}
                              </p>
                              <p className="mt-0.5 text-xs text-amber-800">
                                {t(
                                  "extra.inProgressBody",
                                  "Approve/Reject buttons are temporarily disabled until this line completes.",
                                )}
                              </p>
                            </>
                          ) : (
                            // Generic extra line message
                            <>
                              <p className="text-sm font-semibold">
                                {t(
                                  "extra.inProgressTitle",
                                  "Extra approval line in progress",
                                )}
                              </p>
                              <p className="mt-0.5 text-xs text-amber-800">
                                {t(
                                  "extra.inProgressBody",
                                  "Approve/Reject buttons are temporarily disabled until this line completes.",
                                )}
                              </p>
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            handleTabChange("comment");
                            setTimeout(() => {
                              const commentSection =
                                document.getElementById("comment-section");
                              if (commentSection) {
                                commentSection.scrollIntoView({
                                  behavior: "smooth",
                                  block: "start",
                                });
                              }
                            }, 100);
                          }}
                          className="ml-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 transition-colors shadow-sm flex-shrink-0"
                          aria-label={t("extra.viewDetails", "View details")}
                          title={t("extra.viewDetails", "View details")}
                        >
                          <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                            />
                          </svg>
                          <span>
                            {t("extra.viewInComments", "View in Comments")}
                          </span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Action Buttons */}
                  {myApprover && !isExpired && !isReferenceMode && (
                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border-2 border-blue-200 rounded-xl p-4 shadow-md">
                      <div className="flex items-center gap-3 mb-3">
                        <div className="flex-shrink-0 w-10 h-10 bg-blue-500 rounded-full flex items-center justify-center">
                          <svg
                            className="w-6 h-6 text-white"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                          </svg>
                        </div>
                        <div className="flex-1">
                          <h3 className="text-lg font-bold text-gray-900">
                            {t("quickAction.title", "Your Action Required")}
                          </h3>
                          <p className="text-sm text-gray-600">
                            {t(
                              "quickAction.subtitle",
                              "You are at approval level",
                            )}{" "}
                            {myApprover.level + 1}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        {/* Approve Button */}
                        <button
                          onClick={async () => {
                            if (extraBusy || isExpired) {
                              toast.error(
                                isExpired
                                  ? t("expired", "Expired")
                                  : t(
                                      "extra.busyError",
                                      "An extra approval line is currently in progress",
                                    ),
                              );
                              return;
                            }
                            // Execute approval directly
                            if (myApprover) {
                              const requiresSignature =
                                myApprover.isSigReq ?? false;
                              await handleApproveRequest(
                                myApprover.loaUserPivotId,
                                requiresSignature,
                              );
                            }
                          }}
                          disabled={extraBusy || isExpired}
                          className={`w-full px-5 py-3 text-base font-semibold rounded-lg shadow-md
                            transition-all duration-200 flex items-center justify-center gap-2
                            ${
                              extraBusy || isExpired
                                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                                : "bg-green-700 text-white hover:bg-green-900 hover:shadow-lg transform hover:-translate-y-0.5"
                            }`}
                        >
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                          {t("approvers.approve", "Approve")}
                        </button>

                        {/* Approve With Condition Button */}
                        <button
                          onClick={async () => {
                            if (extraBusy || isExpired) {
                              toast.error(
                                isExpired
                                  ? t("expired", "Expired")
                                  : t(
                                      "extra.busyError",
                                      "An extra approval line is currently in progress",
                                    ),
                              );
                              return;
                            }
                            if (myApprover) {
                              const requiresSignature =
                                myApprover.isSigReq ?? false;
                              await handleApproveWithConditionRequest(
                                myApprover.loaUserPivotId,
                                requiresSignature,
                              );
                            }
                          }}
                          disabled={extraBusy || isExpired}
                          className={`w-full px-5 py-3 text-base font-semibold rounded-lg shadow-md
                            transition-all duration-200 flex items-center justify-center gap-2
                            ${
                              extraBusy || isExpired
                                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                                : "bg-amber-600 text-white hover:bg-amber-700 hover:shadow-lg transform hover:-translate-y-0.5"
                            }`}
                        >
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                          </svg>
                          {t(
                            "approvers.approveWithCondition",
                            "Approve With Condition",
                          )}
                        </button>

                        {/* Need Revise & Terminate (if not owner) */}
                        {me?.id !== memo.userId && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <button
                              onClick={async () => {
                                if (extraBusy || isExpired) {
                                  toast.error(
                                    isExpired
                                      ? t("expired", "Expired")
                                      : t(
                                          "extra.busyError",
                                          "An extra approval line is currently in progress",
                                        ),
                                  );
                                  return;
                                }
                                // Execute reject directly
                                if (myApprover) {
                                  await handleRejectRequest(
                                    myApprover.loaUserPivotId,
                                  );
                                }
                              }}
                              disabled={extraBusy || isExpired}
                              className={`w-full px-4 py-2.5 text-sm font-medium rounded-lg shadow-sm
                                transition-all duration-200 flex items-center justify-center gap-2
                                ${
                                  extraBusy || isExpired
                                    ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                                    : "bg-amber-500 text-white hover:bg-amber-600 hover:shadow-md"
                                }
                                disabled:opacity-60 disabled:cursor-not-allowed`}
                            >
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                />
                              </svg>
                              {t("btnNeedRevise", "Needs Revised")}
                            </button>

                            {canTerminate && (
                              <button
                                onClick={() => {
                                  if (extraBusy || isExpired) {
                                    toast.error(
                                      isExpired
                                        ? t("expired", "Expired")
                                        : t(
                                            "extra.busyError",
                                            "An extra approval line is currently in progress",
                                          ),
                                    );
                                    return;
                                  }
                                  setTerminateModalOpen(true);
                                }}
                                disabled={extraBusy || isExpired}
                                className="w-full px-4 py-2.5 text-sm font-medium rounded-lg shadow-sm
                                  transition-all duration-200 flex items-center justify-center gap-2
                                  bg-rose-600 text-white hover:bg-rose-700 hover:shadow-md
                                  disabled:opacity-60 disabled:cursor-not-allowed"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                  />
                                </svg>
                                {t("btnTerminate", "Terminate")}
                              </button>
                            )}
                          </div>
                        )}

                        {/* Terminate button removed for owner — owner should not terminate their own memo */}
                      </div>
                    </div>
                  )}
                  <div className="pt-4">
                    <div className="w-[90%] mx-auto border-b border-gray-300"></div>
                  </div>
                </div>
              );
            })()}

            {/* ===== Tabs ===== */}
            <nav
              className="shrink-0 flex justify-center gap-1 sm:gap-2 overflow-x-auto scrollbar-hide"
              aria-label="Tabs"
            >
              {TABS.map((tab) => {
                const active = activeTab === tab.key;

                // เลือก count สำหรับแต่ละแท็บ
                const count =
                  tab.key === "comment"
                    ? commentCount
                    : tab.key === "attached"
                      ? attachedCount
                      : tab.key === "reference"
                        ? referenceCount
                        : null;

                return (
                  <button
                    key={tab.key}
                    onClick={() => handleTabChange(tab.key)}
                    className={`relative flex items-center justify-center gap-2 px-3 py-2.5 text-xs sm:text-sm
          font-medium rounded-lg transition-all duration-200 ${
            active
              ? "bg-green-100 text-green-800 border border-green-200 shadow-sm min-w-[7rem]"
              : "text-gray-600 hover:text-gray-800 hover:bg-gray-100 min-w-[3rem]"
          }`}
                    aria-label={tab.label}
                    title={tab.label}
                  >
                    {/* Icon */}
                    <span className="flex-shrink-0">{tab.icon}</span>

                    {/* Label - only show for active tab */}
                    {active && (
                      <span className="whitespace-nowrap font-semibold">
                        {tab.label}
                      </span>
                    )}

                    {/* Count Badge */}
                    {typeof count === "number" && count > 0 && (
                      <span
                        className={`absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1
      rounded-full text-[10px] leading-[18px] text-white text-center
      border border-white shadow
      ${active ? "bg-emerald-600" : "bg-orange-700"}`}
                      >
                        {formatCount(count)}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            {/* ===== Body (ยืดเต็มสูง) ===== */}
            <div
              className={`flex-1 min-h-0 mt-4 ${
                activeTab === "comment" ? "overflow-hidden" : "overflow-y-auto"
              }`}
            >
              {/* ===== Dynamic Sections ===== */}
              {activeTab === "details" && (
                <MemoAndApproval
                  memo={memo}
                  memoId={id!}
                  // ⬇️ ADD: ส่ง markers ให้ลูกใช้กรอง
                  signaturePositions={memo.signaturePositions ?? []}
                  extraBusy={extraBusy}
                  extraLine={extraLine}
                  jumpToComments={() => {
                    handleTabChange("comment");
                    setTimeout(() => {
                      const commentSection =
                        document.getElementById("comment-section");
                      if (commentSection) {
                        commentSection.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                      }
                    }, 100);
                  }}
                  approverGroups={approverGroups}
                  ccRecipients={ccRecipients}
                  statusLabel={statusLabel}
                  isInApproval={isInApproval}
                  minWaitingLevel={minWaitingLevel}
                  meId={me?.id ?? null}
                  myDisplayName={myDisplayName}
                  defaultSignatureText={me?.defaultSignatureText || ""}
                  userSignatures={userSignatures}
                  defaultSignatureId={defaultSignatureId}
                  onReject={(pivotId) => handleRejectRequest(pivotId)}
                  onApprove={(pivotId, reqSig) =>
                    handleApproveRequest(pivotId, reqSig)
                  } // ⬅️ Pass handler
                  onApproveWithCondition={(pivotId, reqSig) =>
                    handleApproveWithConditionRequest(pivotId, reqSig)
                  }
                  onAfterAction={() => loadData({ refreshPdf: true })}
                  canTerminate={canTerminate}
                  onTerminate={handleTerminate}
                  onOpenPdf={() => setPdfOpen(true)}
                  showMobileActions={!pdfOpen}
                  displayNameFromId={displayNameFromId}
                  isReferenceMode={isReferenceMode}
                />
              )}

              {activeTab === "comment" && (
                // ✅ ให้เป็น anchor ที่ปุ่มจะเลื่อนมาหา และเป็นตัว scroll ด้วย
                <div
                  id="comment-section"
                  data-scroll-container
                  className="h-full overflow-y-auto scroll-smooth"
                >
                  <CommentSection
                    memoId={id ? Number(id) : 0}
                    meId={me?.id ?? 0}
                    meProfileImagePath={toSecureUploadUrl(
                      me?.profileImagePath ?? null,
                    )}
                    expiresAt={memo.expiresAt}
                    onCountChange={(n) => setCommentCount(n)}
                    hideExtraButton={hideExtraButton}
                    isReferenceMode={isReferenceMode}
                    isProcessing={isProcessing}
                    meName={me?.name ?? undefined}
                    meLastname={me?.lastname ?? undefined}
                    meNickname={me?.nickname ?? undefined}
                    onDirtyChange={setIsCommentDirty}
                  />
                </div>
              )}
              {activeTab === "attached" && (
                <AttachedSection
                  files={(memo?.attachedFiles ?? []).map((f) => ({
                    ...f,
                    // For URL links, keep the URL as-is; for files, convert to secure URL
                    url: f.isUrl ? f.url : toSecureUploadUrl(f.url),
                  }))}
                />
              )}
              {activeTab === "history" && (
                <HistorySection items={memo?.history ?? []} />
              )}
              {activeTab === "reference" && (
                <ReferenceMemoViewer memoId={Number(id)} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ===== PDF overlay (แสดงเมื่อ pdfOpen) ===== */}
      {pdfOpen && (
        <PdfOverlay
          key={pdfUrl}
          src={pdfUrl}
          downloadUrl={`/api/memos/${id}/download?preview=1`}
          onClose={() => setPdfOpen(false)}
          onTerminate={() => setTerminateModalOpen(true)}
          canTerminate={canTerminate}
        />
      )}
      <DeleteConfirmationModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={handleDelete}
        title={t("confirmDelete.title")}
        message={t("confirmDelete.message")}
        itemName={`${memo?.memonumber || `#${id}`} - ${
          memo?.subject || t("confirmDelete.untitled")
        }`}
        isLoading={deleting}
      />

      <ApproveModal
        isOpen={showApproveModal}
        onClose={() => setShowApproveModal(false)}
        onConfirm={handleConfirmApprove}
        loaUserId={pendingPivotId}
        userSignatures={userSignatures}
        defaultSignatureId={defaultSignatureId}
        defaultSignatureText={me?.defaultSignatureText || ""}
        meId={me?.id ?? null}
        myDisplayName={myDisplayName}
      />

      <ApproveWithConditionModal
        isOpen={showApproveWithConditionModal}
        onClose={() => setShowApproveWithConditionModal(false)}
        onConfirm={handleConfirmApproveWithCondition}
        loaUserId={pendingPivotId}
        requiresSignature={pendingPivotRequiresSig}
        userSignatures={userSignatures}
        defaultSignatureId={defaultSignatureId}
        defaultSignatureText={me?.defaultSignatureText || ""}
        meId={me?.id ?? null}
        myDisplayName={myDisplayName}
      />

      <TerminateReasonModal
        isOpen={terminateModalOpen}
        onClose={() => setTerminateModalOpen(false)}
        onConfirm={handleTerminate}
      />

      <RejectReasonModal
        isOpen={rejectModalOpen}
        onClose={() => {
          setRejectModalOpen(false);
          setRejectingPivotId(null);
        }}
        onConfirm={handleConfirmReject}
      />

      <RejectReasonModal
        isOpen={rejectModalOpen}
        onClose={() => {
          setRejectModalOpen(false);
          setRejectingPivotId(null);
        }}
        onConfirm={handleConfirmReject}
      />


      {/* ✅ Modal: ถามว่าจะอนุมัติเอกสารอื่นต่อไหม */}
      {showNextMemoModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
            {/* Header */}
            <div className="bg-gradient-to-r from-green-500 to-emerald-600 p-6 text-white">
              <div className="flex items-center gap-3">
                <div className="bg-white/20 rounded-full p-3">
                  <svg
                    className="w-8 h-8"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <div>
                  <h3 className="text-xl font-bold">
                    {t("approvers.approvalSuccess", "อนุมัติเอกสารสำเร็จ")}
                  </h3>
                  <p className="text-green-100 text-sm mt-1">
                    {t(
                      "approvers.approvalCompleted",
                      "เอกสารได้รับการอนุมัติเรียบร้อยแล้ว",
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="p-6">
              <p className="text-gray-700 text-center mb-6">
                {hasMorePendingDocs
                  ? t(
                      "approvers.continueApproving",
                      "คุณต้องการอนุมัติเอกสารที่ยังค้างอยู่ (รอการอนุมัติ) อีกฉบับหรือไม่?",
                    )
                  : t(
                      "approvers.continueApprovingLastDoc",
                      "ไม่มีเอกสารที่รอการอนุมัติจากคุณในขณะนี้แล้ว",
                    )}
              </p>

              {/* Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={handleCloseNextMemoModal}
                  disabled={loadingNextMemo}
                  className="flex-1 px-4 py-3 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium disabled:opacity-50"
                >
                  {t("approvers.closeButton", "ปิด")}
                </button>
                {hasMorePendingDocs && (
                  <button
                    onClick={handleGoToNextMemo}
                    disabled={loadingNextMemo}
                    className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-900 transition-all font-medium shadow-lg hover:shadow-xl disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {loadingNextMemo ? (
                      <>
                        <FontAwesomeIcon
                          icon={faSpinner}
                          className="animate-spin h-5 w-5"
                        />
                        {t("approvers.loading", "กำลังโหลด...")}
                      </>
                    ) : (
                      <>
                        {t("approvers.approveNext", "อนุมัติเอกสารอื่น")}
                        <FontAwesomeIcon
                          icon={faArrowRight}
                          className="w-5 h-5"
                        />
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
