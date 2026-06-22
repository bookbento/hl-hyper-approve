import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import axios from "axios";
import { pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useNavigate } from "react-router-dom";
import { HashLoader } from "react-spinners";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";

import { toSecureUploadUrl } from "../../lib/files";
import {
  FiCheck,
  FiChevronDown,
  FiChevronUp,
  FiFilter,
  FiSearch,
  FiX,
  FiClock,
} from "react-icons/fi";
import { useMemoSearch } from "../../hooks/useMemoSearch";
import {
  colFiltersToSearchRequest,
  isAbortError,
  searchMemoStats,
  type ColKey as SearchColKey,
} from "../../lib/api/memoSearch.api";
import type {
  MemoListItem,
  StatCounts as ServerStatCounts,
  Facets as ServerFacets,
} from "../../lib/api/memoSearch.types";
import { subscribeMemoDashboardRefresh } from "../../lib/memoDashboardEvents";

// Feature flag — opt-in to server-side pagination. Set to true in
// frontend/.env via VITE_USE_MEMO_SEARCH=true. Toggle requires `vite` rebuild.
const USE_NEW_SEARCH =
  import.meta.env.VITE_USE_MEMO_SEARCH === "true";
const DASHBOARD_STAT_COUNTS_CACHE_KEY = "dashboard:statCounts:v1";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
axios.defaults.baseURL = (import.meta.env.VITE_BACKEND_API_URL || "").replace(
  /\/+$/,
  ""
);
export type Status =
  | "Draft"
  | "Published"
  | "Processing"
  | "Recalled"
  | "Approved"
  | "Rejected"
  | "Terminated"
  | string;

type ApproverStatus = {
  userId: number;
  name: string;
  level: number; // 0-based
  statusCode: "waiting" | "approved" | "rejected" | "terminated" | "not_required";
  actedAt?: string;
  since: string; // ISO
};
// --- utils for responsive ---
const useIsMobile = (bp = 768) => {
  const [isMobile, setIsMobile] = React.useState(
    typeof window !== "undefined" ? window.innerWidth < bp : false
  );
  React.useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < bp);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [bp]);
  return isMobile;
};

const useLockBodyScroll = (locked: boolean) => {
  React.useEffect(() => {
    const { style } = document.body;
    const prev = style.overflow;
    if (locked) style.overflow = "hidden";
    return () => {
      style.overflow = prev;
    };
  }, [locked]);
};

interface Named {
  id: number;
  name: string;
}
interface Memo {
  id: number;
  subject: string;
  documentCode?: string;
  memonumber: string;
  user: { id: number; name: string; lastname: string; nickname: string; department: Named };
  department: Named;
  businessUnit: Named;
  team: Named;
  memoType: { name: string };
  approvalSummary?: string;
  status?: string;
  latestApprovedDate?: string;
  createdAt?: string;
  currentApprover?: { names: string[]; level: number } | null;
  isMyTurnMain?: boolean;
  isMyTurnExtra?: boolean;
  latestComment?: {
    id: number;
    userId: number;
    userName: string;
    nickname?: string | null;
    comment: string;
    snippet?: string | null;
    createdAt: string; // ISO
    attachments?: Array<{
      url: string; // ต้องเป็น URL พร้อมโหลดได้
      fileName: string | null;
      mimeType: string | null;
      isImage: boolean; // true ถ้าเป็น image/*
    }>;
  } | null;
  expiresAt?: string | null;
}

interface Department {
  id: number;
  name: string;
  businessUnitId?: number; // ⬅️ เพิ่ม
  businessUnit?: BusinessUnit; // ⬅️ ถ้าคืน include มาด้วยก็รองรับ
}

interface BusinessUnit {
  id: number;
  name: string;
  departments: Department[];
}

interface CurrentApprover {
  id: number;
  name?: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
}

const getApproverFullName = (a: CurrentApprover): string => {
  const first = (a.firstName ?? "").trim();
  const last = (a.lastName ?? "").trim();
  const fromParts = [first, last].filter(Boolean).join(" ").trim();
  if (fromParts) return fromParts;
  return (a.name ?? "").trim();
};
type StatusAll = "All" | string;
const getApproverLabel = (a: CurrentApprover): string => {
  const full = getApproverFullName(a);
  const nick = (a.nickname ?? "").trim();
  return nick ? `${full} (${nick})` : full;
};

// ===== Helper to find ACTIVE approvers (waiting @ min level) =====
const getCurrentApprovers = (rows: ApproverStatus[]): ApproverStatus[] => {
  if (!rows || !rows.length) return [];
  const waiting = rows.filter((r) => r.statusCode === "waiting");
  if (!waiting.length) return [];
  const minLevel = Math.min(...waiting.map((r) => r.level));
  return waiting.filter((r) => r.level === minLevel);
};

const isProcessingMemo = (m: Pick<Memo, "status">): boolean =>
  (m.status ?? "").trim().toLowerCase() === "processing";

const getActionableCurrentApprovers = (
  memo: Pick<Memo, "status">,
  rows: ApproverStatus[]
): ApproverStatus[] => {
  if (!isProcessingMemo(memo)) return [];
  if (
    rows.some(
      (r) => r.statusCode === "rejected" || r.statusCode === "terminated"
    )
  ) {
    return [];
  }
  return getCurrentApprovers(rows);
};

const isFrozenExpiryStatus = (status?: string | null) => {
  const normalized = (status ?? "").trim().toLowerCase();
  return normalized === "expired" || normalized === "rejected";
};

const shouldHideExpiryBadge = (status?: string | null) => {
  const normalized = (status ?? "").trim().toLowerCase();
  return isFrozenExpiryStatus(normalized) || normalized === "approved";
};

// ===== เพิ่มฟังก์ชันบอกสถานะหมดอายุแบบ key (none|expired|soon|active) =====
const getExpiryStatusKey = (
  iso?: string | null,
  status?: string | null
): "none" | "expired" | "soon" | "active" => {
  if (isFrozenExpiryStatus(status)) {
    return iso ? "expired" : "none";
  }
  if (!iso) return "none";
  const d = new Date(iso);
  if (isNaN(+d)) return "none";
  const now = Date.now();
  const diffMs = d.getTime() - now;
  const days = diffMs / (1000 * 60 * 60 * 24);
  if (diffMs < 0) return "expired";
  if (days <= 3) return "soon";
  return "active";
};

export const FilterMenu: React.FC<{
  open: boolean;
  setOpen: (b: boolean) => void;
  activeFilterCount: number;
  statusFilter: StatusAll;
  setStatusFilter: (v: StatusAll) => void;
  approverFilter: number | "All";
  setApproverFilter: (v: number | "All") => void;
  buFilter: number | "All";
  setBuFilter: (v: number | "All") => void;
  deptFilter: number | "All";
  setDeptFilter: (v: number | "All") => void;
  currentApprovers: CurrentApprover[];
  businessUnits: BusinessUnit[];
  departments: Department[];
  memos: Memo[]; // ✅ เพิ่ม
  onClear: (opts?: { keepMyApproval?: boolean }) => void;
}> = ({
  open,
  setOpen,
  activeFilterCount,
  statusFilter,
  setStatusFilter,
  approverFilter,
  setApproverFilter,
  buFilter,
  setBuFilter,
  deptFilter,
  setDeptFilter,
  currentApprovers,
  businessUnits,
  departments,
  memos, // ✅ เพิ่ม
  onClear,
}) => {
    const { t } = useTranslation("dashboard");

    const panelRef = useRef<HTMLDivElement>(null);
    const toggleRef = useRef<HTMLButtonElement>(null);
    const [searchBu, setSearchBu] = useState("");
    const [searchDept, setSearchDept] = useState("");
    const [searchApprover, setSearchApprover] = useState("");
    // ===== Expiry status meta (color + label + icon) =====

    // ปิดเมื่อคลิกนอกพื้นที่ หรือกด Escape
    useEffect(() => {
      const handlePointerDown = (e: PointerEvent) => {
        if (!open) return;
        const target = e.target as Node;
        if (panelRef.current?.contains(target)) return;
        if (toggleRef.current?.contains(target)) return;
        setOpen(false);
      };

      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
        }
      };

      document.addEventListener("pointerdown", handlePointerDown);
      document.addEventListener("keydown", handleEscape);

      return () => {
        document.removeEventListener("pointerdown", handlePointerDown);
        document.removeEventListener("keydown", handleEscape);
      };
    }, [open, setOpen]);

    // ค้นหา Business Units
    const filteredBUs = useMemo(
      () =>
        businessUnits.filter((b) =>
          b.name.toLowerCase().includes(searchBu.toLowerCase())
        ),
      [businessUnits, searchBu]
    );

    // ค้นหา Departments (ขึ้นกับ BU ที่เลือก)
    const availableDepts = useMemo(() => {
      if (buFilter === "All") return [];

      // ดึง departments จาก memos ที่มี BU ตรงกัน
      const deptMap = new Map<number, { id: number; name: string }>();

      memos.forEach((memo) => {
        if (memo.businessUnit?.id === buFilter && memo.department?.id && memo.department?.name) {
          deptMap.set(memo.department.id, {
            id: memo.department.id,
            name: memo.department.name
          });
        }
      });

      const deptsFromMemos = Array.from(deptMap.values());

      // ถ้ามี departments จาก memos ให้ใช้อันนั้น ไม่งั้นใช้จาก API
      if (deptsFromMemos.length > 0) {
        return deptsFromMemos.filter((d) =>
          d.name.toLowerCase().includes(searchDept.toLowerCase())
        );
      }

      // Fallback: ใช้จาก businessUnits หรือ departments API
      const selectedBU = businessUnits.find((b) => b.id === buFilter);
      const poolFromBU = selectedBU?.departments ?? [];

      const pool =
        poolFromBU.length > 0
          ? poolFromBU
          : departments.filter(
            (d) => (d.businessUnitId ?? d.businessUnit?.id) === buFilter
          );

      return pool.filter((d) =>
        d.name.toLowerCase().includes(searchDept.toLowerCase())
      );
    }, [buFilter, businessUnits, departments, searchDept, memos]);

    const filteredApprovers = useMemo(() => {
      const q = searchApprover.trim().toLowerCase();
      if (!q) return currentApprovers;

      return currentApprovers.filter((a) => {
        const full = getApproverFullName(a).toLowerCase(); // first+last หรือ name เดิม
        const nick = (a.nickname ?? "").toLowerCase(); // ⬅️ ชื่อเล่น
        const legacy = (a.name ?? "").toLowerCase(); // เผื่อแบ็คเอนด์ส่งมาแค่ name

        return full.includes(q) || nick.includes(q) || legacy.includes(q);
      });
    }, [currentApprovers, searchApprover]);

    // รีเซ็ตการค้นหาเมื่อปิดเมนู
    useEffect(() => {
      if (!open) {
        setSearchBu("");
        setSearchDept("");
        setSearchApprover("");
      }
    }, [open]);

    const statusValues: StatusAll[] = [
      "All",
      "Draft",
      "Processing",
      "Approved",
      "Rejected",
      "Terminated",
      "Recalled",
    ];

    const renderStatusLabel = (s: string) =>
      s === "All" ? t("filters.all") : t(`stats.${s.toLowerCase()}`);

    const handleClearAll = () => {
      onClear?.({ keepMyApproval: false }); // ❗เคลียร์ถึงคิวเราด้วย
      setSearchBu("");
      setSearchDept("");
      setSearchApprover("");
    };
    // ====== ภายใน FilterMenu: วางไว้ "ก่อน return" ======
    const isMobile = useIsMobile();
    useLockBodyScroll(open && isMobile);

    // รวมหัว–เนื้อหา–ท้ายของแผงฟิลเตอร์ไว้ที่เดียว เพื่อลดโค้ดซ้ำ
    const PanelInner: React.FC = () => (
      <>
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/70">
          <div className="flex items-center gap-2">
            <svg
              className="w-5 h-5 text-gray-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
              />
            </svg>
            <h3 className="font-semibold text-gray-800">{t("filters.title")}</h3>
          </div>
        </div>

        {/* Content */}
        <div
          className={
            isMobile
              ? "max-h-[70vh] overflow-y-auto"
              : "overflow-y-auto max-h-[calc(70vh-120px)]"
          }
        >
          {/* Status */}
          <div className="p-4 border-b border-gray-100">
            <h4 className="font-medium text-gray-700 mb-3 flex items-center gap-2">
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
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              {t("filters.status")}
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {statusValues.map((s) => (
                <label
                  key={s}
                  className="flex items-center gap-2 text-sm p-2 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer"
                >
                  <input
                    type="radio"
                    name="status"
                    checked={statusFilter === s}
                    onChange={() => setStatusFilter(s)}
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span className="flex-1">{renderStatusLabel(s)}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Approver */}
          <div className="p-4 border-b border-gray-100">
            <h4 className="font-medium text-gray-700 mb-3 flex items-center gap-2">
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
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
              {t("filters.approver")}
            </h4>

            <div className="space-y-3">
              <label className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer">
                <input
                  type="radio"
                  name="approver"
                  checked={approverFilter === "All"}
                  onChange={() => setApproverFilter("All")}
                  className="text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm font-medium">{t("filters.all")}</span>
              </label>

              <div className="max-h-32 overflow-y-auto space-y-1">
                {filteredApprovers.map((a) => (
                  <label
                    key={a.id}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="approver"
                      checked={approverFilter === a.id}
                      onChange={() => setApproverFilter(a.id)}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-900 truncate">
                        {getApproverLabel(a)}
                      </div>
                    </div>
                  </label>
                ))}
                {filteredApprovers.length === 0 && (
                  <div className="text-center text-xs text-gray-500 py-4">
                    {t("filters.noApprover")}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Business Unit */}
          <div className="p-4 border-b border-gray-100">
            <h4 className="font-medium text-gray-700 mb-3 flex items-center gap-2">
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
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                />
              </svg>
              {t("filters.bu")}
            </h4>

            <select
              value={buFilter === "All" ? "All" : buFilter}
              onChange={(e) => {
                const val = e.target.value === "All" ? "All" : Number(e.target.value);
                setBuFilter(val);
                setDeptFilter("All");
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="All">{t("filters.allBusinessUnits")}</option>
              {filteredBUs.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          {/* Department */}
          <div className="p-4">
            <h4 className="font-medium text-gray-700 mb-3 flex items-center gap-2">
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
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                />
              </svg>
              {t("filters.dept")}
            </h4>

            {buFilter === "All" ? (
              <div className="text-center py-6">
                <svg
                  className="w-12 h-12 text-gray-300 mx-auto mb-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                  />
                </svg>
                <p className="text-sm text-gray-500">
                  {t("filters.selectBuFirst")}
                </p>
              </div>
            ) : (
              <select
                value={deptFilter === "All" ? "All" : deptFilter}
                onChange={(e) => {
                  const val = e.target.value === "All" ? "All" : Number(e.target.value);
                  setDeptFilter(val);
                }}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                disabled={availableDepts.length === 0}
              >
                <option value="All">{t("filters.all")}</option>
                {availableDepts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
            {buFilter !== "All" && availableDepts.length === 0 && (
              <div className="text-center text-xs text-gray-500 py-2 mt-2">
                {t("filters.noDept")}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-100 bg-gray-50 flex justify-between gap-2">
          <button
            onClick={handleClearAll}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={activeFilterCount === 0}
          >
            {t("filters.clearAll")}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            {t("filters.apply")}
          </button>
        </div>
      </>
    );

    return (
      <div className="relative inline-block">
        {/* ปุ่ม Toggle - ดีไซน์ที่ดูเป็นทางการมากขึ้น */}
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t("filters.toggle")}
          className={`h-10 inline-flex items-center gap-2 rounded-lg px-4 border transition-all duration-200 font-medium shadow-sm hover:shadow-md
    ${open
              ? "bg-gray-200 text-gray-600 border-gray-300 shadow-md"
              : activeFilterCount > 0
                ? "bg-gray-200 text-gray-600 border-gray-300 hover:bg-gray-100"
                : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
            }`}
        >
          {/* ไอคอนฟิลเตอร์ที่ทันสมัยกว่า */}
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
              d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
            />
          </svg>

          <span className="min-w-[60px] text-left">{t("filters.toggle")}</span>

          {activeFilterCount > 0 && (
            <span
              className={`ml-1 rounded-full px-2 py-1 text-xs font-semibold min-w-[20px] flex items-center justify-center
              ${open ? "bg-white text-gray-600" : "bg-gray-500 text-white"}`}
            >
              {activeFilterCount}
            </span>
          )}

          {/* ไอคอนลูกศร */}
          <svg
            className={`w-4 h-4 transition-transform duration-200 ${open ? "rotate-180" : ""
              }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>

        {/* แผงฟิลเตอร์ */}
        <AnimatePresence>
          {open && (
            <>
              {/* Backdrop เฉพาะมือถือ */}
              {isMobile && (
                <motion.div
                  ref={panelRef}
                  key="backdrop"
                  className="fixed inset-0 z-40 bg-black/40"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setOpen(false)}
                />
              )}

              {/* แผงฟิลเตอร์ */}
              {isMobile ? (
                // ===== MOBILE: bottom sheet =====
                <motion.div
                  ref={panelRef}
                  key="filter-panel-mobile"
                  className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-white shadow-2xl"
                  initial={{ y: "100%" }}
                  animate={{ y: 0 }}
                  exit={{ y: "100%" }}
                  transition={{ type: "spring", stiffness: 260, damping: 26 }}
                  role="dialog"
                  aria-label={t("filters.title")}
                >
                  {/* แถบจับ */}
                  <div className="pt-3">
                    <div className="mx-auto h-1.5 w-10 rounded-full bg-gray-300" />
                  </div>
                  <PanelInner />
                  {/* safe-area */}
                  <div className="h-4 md:h-0" />
                </motion.div>
              ) : (
                // ===== DESKTOP: popover ข้างปุ่ม =====
                <motion.div
                  ref={panelRef}
                  key="filter-panel-desktop"
                  className="absolute left-0 top-full mt-2 z-50 w-80 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
                  initial={{ opacity: 0, y: -8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.98 }}
                  transition={{ duration: 0.2 }}
                  role="dialog"
                  aria-label={t("filters.title")}
                >
                  <PanelInner />
                </motion.div>
              )}
            </>
          )}
        </AnimatePresence>
      </div>
    );
  };

// === Excel-like column filter button + panel ===
type ColKey =
  | "memonumber"
  | "subject"
  | "author"
  | "status"
  | "current"
  | "extra"
  | "latest"
  | "expires"
  | "createdAt"
  | "ccStatus";
type SortDir = "asc" | "desc";
type ExpiryKey = "expired" | "soon" | "active" | "none" | "closed";

// เดิม: type ColumnFilterState = { search?: string; values?: string[] | null };
type ColumnFilterState = {
  search?: string;
  values?: string[] | null;
  expiry?: ExpiryKey[] | null; // ✅ เติมฟิลด์นี้
  dateFrom?: string | null; // ✅ เพิ่มสำหรับ date filter
  dateTo?: string | null; // ✅ เพิ่มสำหรับ date filter
};
type HeaderFilterOption = string | { value: string; label: string };
type Side = "left" | "right" | "auto";

const getHeaderFilterOptionValue = (option: HeaderFilterOption) =>
  typeof option === "string" ? option : option.value;

const getHeaderFilterOptionLabel = (option: HeaderFilterOption) =>
  typeof option === "string" ? option : option.label;

const HeaderFilter: React.FC<{
  colKey: ColKey;
  mode: "text" | "list" | "date";
  options?: HeaderFilterOption[];
  state: ColumnFilterState;
  onApply: (next: ColumnFilterState) => void;
  sortDir: SortDir | null;
  onSort: (dir: SortDir | null) => void;
  showExpiry?: boolean;
  side?: Side;
  hideSort?: boolean;
}> = ({
  colKey,
  mode,
  options = [],
  state,
  onApply,
  sortDir,
  onSort,
  showExpiry,
  side = "right",
  hideSort = false,
}) => {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ top: number; left: number }>({
      top: 0,
      left: 0,
    });
    const panelRef = useRef<HTMLDivElement>(null);
    const btnRef = useRef<HTMLButtonElement>(null);
    const [q, setQ] = useState(state.search ?? "");
    const [selected, setSelected] = useState<string[]>(
      state.values ? [...state.values] : []
    );
    const { t } = useTranslation("dashboard");
    const [localExpiry, setLocalExpiry] = useState<ExpiryKey[]>(
      state.expiry ?? []
    );
    const [dateFrom, setDateFrom] = useState(state.dateFrom ?? "");
    const [dateTo, setDateTo] = useState(state.dateTo ?? "");

    // Calculate and update position
    const updatePosition = React.useCallback(() => {
      if (!btnRef.current) return;
      const r = btnRef.current.getBoundingClientRect();
      const top = r.top; // Use viewport-relative position for fixed positioning
      const panelW = 288; // w-72 = 18rem (18*16)
      const gap = 8;

      let left = r.right + gap; // Open to the right
      if (side === "left") {
        left = r.left - panelW - gap; // Open to the left
      } else if (side === "auto") {
        const spaceRight = window.innerWidth - r.right;
        const spaceLeft = r.left;
        const preferLeft = spaceRight < panelW + gap && spaceLeft > spaceRight;
        left = preferLeft ? r.left - panelW - gap : r.right + gap;
      }

      setPos({ top, left });
    }, [side]);

    // Initial position calculation
    useLayoutEffect(() => {
      if (!open || !btnRef.current) return;
      updatePosition();
    }, [open, updatePosition]);

    // Update position on scroll and resize to keep modal aligned with button
    useEffect(() => {
      if (!open) return;

      window.addEventListener("scroll", updatePosition, true);
      window.addEventListener("resize", updatePosition);

      return () => {
        window.removeEventListener("scroll", updatePosition, true);
        window.removeEventListener("resize", updatePosition);
      };
    }, [open, updatePosition]);

    useEffect(() => {
      if (open) setLocalExpiry(state.expiry ?? []);
    }, [open, state.expiry]);

    useEffect(() => {
      if (!open) return;
      const onDown = (e: MouseEvent) => {
        const t = e.target as Node;
        if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
        setOpen(false);
      };
      const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onEsc);
      return () => {
        document.removeEventListener("mousedown", onDown);
        document.removeEventListener("keydown", onEsc);
      };
    }, [open]);

    useEffect(() => {
      if (open) {
        setQ(state.search ?? "");
        setSelected(state.values ? [...state.values] : []);
      }
    }, [open, state.search, state.values]);

    const isActive =
      (state.search && state.search.trim() !== "") ||
      (state.values && state.values.length > 0) ||
      (state.expiry && state.expiry.length > 0) ||
      !!sortDir;

    const visibleOptions = useMemo(() => {
      if (mode !== "list") return [];
      const qq = q.trim().toLowerCase();
      return (options || []).filter((option) =>
        getHeaderFilterOptionLabel(option).toLowerCase().includes(qq)
      );
    }, [mode, options, q]);

    const toggleOne = (v: string) =>
      setSelected((prev) =>
        prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
      );

    const selectAll = () =>
      setSelected(visibleOptions.map(getHeaderFilterOptionValue));
    const clearAll = () => {
      setSelected([]);
      setQ("");
    };

    return (
      <div className="relative inline-block">
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`ml-1.5 inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 
          text-xs font-medium transition-all duration-200 shadow-sm
          ${isActive
              ? "bg-gradient-to-br from-emerald-500 to-emerald-600 text-white border-emerald-600 shadow-emerald-200"
              : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50 hover:border-gray-400"
            }`}
          title={t("headerFilter.buttonTitle")}
        >
          <FiFilter className="w-3.5 h-3.5" />
          {sortDir &&
            (sortDir === "asc" ? (
              <FiChevronUp className="w-3.5 h-3.5" />
            ) : (
              <FiChevronDown className="w-3.5 h-3.5" />
            ))}
        </button>

        {open && (
          <div
            ref={panelRef}
            className="fixed z-[10000] w-80 rounded-xl border border-gray-200 bg-white shadow-2xl overflow-hidden"
            style={{ top: pos.top, left: pos.left }}
            role="dialog"
          >
            {/* Sort Section */}
            {!hideSort && (
              <div className="p-3 bg-gradient-to-r from-gray-50 to-gray-100 border-b border-gray-200">
                <div className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                  <FiChevronUp className="w-3.5 h-3.5" />
                  {t("headerFilter.sort.title")}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onSort("asc");
                      setOpen(false);
                    }}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg 
                    px-3 py-2 text-xs font-medium transition-all duration-200
                    ${sortDir === "asc"
                        ? "bg-emerald-600 text-white shadow-md"
                        : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 hover:border-emerald-300"
                      }`}
                  >
                    <FiChevronUp className="w-4 h-4" />
                    {t("headerFilter.sort.asc")}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      onSort("desc");
                      setOpen(false);
                    }}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg 
                    px-3 py-2 text-xs font-medium transition-all duration-200
                    ${sortDir === "desc"
                        ? "bg-emerald-600 text-white shadow-md"
                        : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 hover:border-emerald-300"
                      }`}
                  >
                    <FiChevronDown className="w-4 h-4" />
                    {t("headerFilter.sort.desc")}
                  </button>

                  <button
                    type="button"
                    onClick={() => onSort(null)}
                    className="inline-flex items-center justify-center rounded-lg border border-gray-300 p-2 text-gray-700 hover:bg-red-50 hover:border-red-300 hover:text-red-600 transition-all duration-200"
                    title={t("headerFilter.sort.clearTitle")}
                    aria-label={t("headerFilter.sort.clear")}
                  >
                    <FiX className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Filter Section */}
            <div className="p-4">
              <div className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                <FiFilter className="w-3.5 h-3.5" />
                {t("headerFilter.filter.title")}
              </div>

              {mode === "text" && (
                <div className="relative">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t("headerFilter.text.placeholder")}
                    className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2.5 text-sm text-gray-800 placeholder-gray-400
           focus:border-emerald-500 focus:outline-none transition-all"
                  />
                </div>
              )}

              {mode === "list" && (
                <>
                  <div className="mb-3">
                    <div className="relative">
                      <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder={t("headerFilter.list.searchPlaceholder")}
                        className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2.5 text-sm text-gray-800 placeholder-gray-400 focus:border-emerald-500 focus:outline-none transition-all"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between mb-2.5">
                    <button
                      type="button"
                      onClick={selectAll}
                      className="text-xs font-medium text-emerald-700 hover:text-emerald-800 hover:underline flex items-center gap-1"
                    >
                      <FiCheck className="w-3.5 h-3.5" />
                      {t("headerFilter.list.selectAll")}
                    </button>
                    <button
                      type="button"
                      onClick={clearAll}
                      className="text-xs font-medium text-gray-600 hover:text-red-600 hover:underline flex items-center gap-1"
                    >
                      <FiX className="w-3.5 h-3.5" />
                      {t("headerFilter.list.clearAll")}
                    </button>
                  </div>

                  <div className="max-h-48 overflow-auto rounded-lg border border-gray-200 bg-gray-50">
                    {visibleOptions.length ? (
                      <div className="divide-y divide-gray-200">
                        {visibleOptions.map((option) => {
                          const value = getHeaderFilterOptionValue(option);
                          const label = getHeaderFilterOptionLabel(option);
                          return (
                            <label
                              key={value}
                              className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-800 hover:bg-white cursor-pointer transition-colors group"
                            >
                              <input
                                type="checkbox"
                                checked={selected.includes(value)}
                                onChange={() => toggleOne(value)}
                                className="w-4 h-4 text-emerald-600 border-gray-300 rounded cursor-pointer focus:outline-none"
                              />
                              <span className="truncate group-hover:text-emerald-700 transition-colors">
                                {label}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="px-3 py-8 text-center">
                        <FiSearch className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                        <p className="text-xs text-gray-400">
                          {t("headerFilter.list.noResults")}
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}

              {mode === "date" && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      {t("headerFilter.date.from")}
                    </label>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 focus:border-emerald-500 focus:outline-none transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      {t("headerFilter.date.to")}
                    </label>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 focus:border-emerald-500 focus:outline-none transition-all"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setDateFrom("");
                      setDateTo("");
                    }}
                    className="w-full px-3 py-2 text-xs font-medium text-gray-600 hover:text-red-600 hover:underline flex items-center justify-center gap-1"
                  >
                    <FiX className="w-3.5 h-3.5" />
                    {t("headerFilter.date.clear")}
                  </button>
                </div>
              )}

              {showExpiry && (
                <div className="mt-3 rounded-lg border border-gray-200 bg-white p-2.5">
                  <div className="text-xs font-semibold text-gray-700 mb-1">
                    {t("filters.expiry")}
                  </div>


                  <div className="flex flex-col bg-gray-50/50">
                    {(
                      [
                        { key: "closed", label: t("expiry.status.closed") },
                        { key: "expired", label: t("expiry.status.expired") },
                        { key: "soon", label: t("expiry.status.soon") },
                        { key: "active", label: t("expiry.status.active") },
                        { key: "none", label: t("expiry.status.none") },
                      ] as Array<{ key: ExpiryKey; label: string }>
                    ).map(({ key, label }) => {
                      const checked = localExpiry.includes(key);
                      return (
                        <label
                          key={key}
                          className={[
                            "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-colors",
                            "text-sm text-gray-800 hover:bg-gray-50",
                            checked
                              ? "bg-emerald-50 ring-1 ring-emerald-200"
                              : "",
                          ].join(" ")}
                        >
                          <input
                            type="checkbox"
                            className="w-4 h-4 text-emerald-600 border-gray-300 rounded focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                            checked={checked}
                            onChange={() =>
                              setLocalExpiry((prev) =>
                                prev.includes(key)
                                  ? prev.filter((k) => k !== key)
                                  : [...prev, key]
                              )
                            }
                          />
                          <span className="truncate">{label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>


            {/* Action Buttons */}
            <div className="p-3 bg-gray-50 border-t border-gray-200 flex items-center justify-end gap-2">
              <button
                type="button"
                className="px-4 py-2 text-xs font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-white hover:border-gray-400 transition-all"
                onClick={() => setOpen(false)}
              >
                {t("headerFilter.actions.close")}
              </button>
              <button
                type="button"
                className="px-4 py-2 text-xs font-medium rounded-lg bg-gradient-to-r from-emerald-600 to-emerald-700 text-white hover:from-emerald-700 hover:to-emerald-800 shadow-md hover:shadow-lg transition-all"
                onClick={() => {
                  if (mode === "text") {
                    onApply({
                      search: q,
                      ...(showExpiry
                        ? { expiry: localExpiry.length ? localExpiry : null }
                        : {}),
                    });
                  } else if (mode === "date") {
                    onApply({
                      dateFrom: dateFrom || null,
                      dateTo: dateTo || null,
                      ...(showExpiry
                        ? { expiry: localExpiry.length ? localExpiry : null }
                        : {}),
                    });
                  } else {
                    onApply({ values: selected });
                  }
                  setOpen(false);
                }}
              >
                {t("headerFilter.actions.apply")}
              </button>
            </div>
          </div>
        )}
      </div >
    );
  };

type VisibleColKey =
  | "number"
  | "status"
  | "subject"
  | "author"
  | "currentApprover"
  | "extraApprover"
  | "latestComment"
  | "expires"
  | "createdAt"
  | "ccStatus";

// Column Visibility Toggle Component
const ColumnVisibilityToggle: React.FC<{
  visibleColumns: Record<VisibleColKey, boolean>;
  onToggle: (key: VisibleColKey) => void;
}> = ({ visibleColumns, onToggle }) => {
  const { t } = useTranslation("dashboard");
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (!open) return;
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (toggleRef.current?.contains(target)) return;
      setOpen(false);
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const columns: { key: VisibleColKey; label: string }[] = [
    { key: "number", label: t("table.number") },
    { key: "status", label: t("table.status") },
    { key: "subject", label: t("table.subject") },
    { key: "author", label: t("table.author") },
    { key: "currentApprover", label: t("table.currentApprover") },
    { key: "extraApprover", label: t("table.extraApprover") },
    { key: "latestComment", label: t("table.latestComment") },
    { key: "expires", label: t("table.expires") },
    { key: "createdAt", label: t("table.createdAt") },
    { key: "ccStatus", label: t("table.ccStatus") },
  ];

        // Calculate number of hidden columns
        const hiddenCount = Object.values(visibleColumns).filter(v => !v).length;
        
        return (
          <div className="relative inline-block">
            <button
              ref={toggleRef}
              type="button"
              onClick={() => setOpen(!open)}
              className={`h-10 inline-flex items-center gap-2 rounded-lg px-4 border transition-all duration-200 font-medium shadow-sm hover:shadow-md ${
                hiddenCount > 0
                  ? "bg-gray-200 text-gray-600 border-gray-300"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
              }`}
              title={t("columnVisibility.toggle")}
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
                  d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
                />
              </svg>
              <span>{t("columnVisibility.toggle")}</span>
              

              <svg
                className={`w-4 h-4 transition-transform duration-200 ${
                  open ? "rotate-180" : ""
                }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            className="absolute right-0 top-full mt-2 z-50 w-72 rounded-xl border border-gray-200 bg-white shadow-xl overflow-hidden"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            role="dialog"
            aria-label={t("columnVisibility.title")}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b bg-gradient-to-r from-gray-50 to-gray-100">
              <div className="flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-gray-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
                  />
                </svg>
                <h3 className="font-semibold text-gray-800">
                  {t("columnVisibility.title")}
                </h3>
              </div>
            </div>

            {/* Content */}
            <div className="p-4 space-y-2">
              {columns.map((col) => (
                <label
                  key={col.key}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={visibleColumns[col.key]}
                    onChange={() => onToggle(col.key)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                  />
                  <span className="text-sm text-gray-800">{col.label}</span>
                </label>
              ))}
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-gray-100 bg-gray-50">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-full px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
              >
                {t("columnVisibility.close")}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// localStorage keys for dashboard filters
const DASHBOARD_FILTERS_KEY = "dashboard_filters";
const DASHBOARD_COL_FILTERS_KEY = "dashboard_col_filters";
const DASHBOARD_SORT_STATE_KEY = "dashboard_sort_state";

// Helper to load filters from localStorage
const loadFiltersFromStorage = () => {
  try {
    const stored = localStorage.getItem(DASHBOARD_FILTERS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.warn("Failed to load dashboard filters from localStorage:", e);
  }
  return null;
};

// Helper to load column filters from localStorage
const loadColFiltersFromStorage = (): Record<ColKey, ColumnFilterState> | null => {
  try {
    const stored = localStorage.getItem(DASHBOARD_COL_FILTERS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.warn("Failed to load column filters from localStorage:", e);
  }
  return null;
};

// Helper to load sort state from localStorage
const loadSortStateFromStorage = (): { key: ColKey; dir: SortDir } | null => {
  try {
    const stored = localStorage.getItem(DASHBOARD_SORT_STATE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.warn("Failed to load sort state from localStorage:", e);
  }
  return null;
};

const normalizeSavedColFilters = (
  filters: Record<ColKey, ColumnFilterState>
): Record<ColKey, ColumnFilterState> => {
  if (!USE_NEW_SEARCH) return filters;
  const normalized = { ...filters };
  (["current", "extra", "ccStatus"] as const).forEach((key) => {
    const values = normalized[key]?.values;
    if (values?.some((v) => Number.isNaN(Number(v)))) {
      normalized[key] = { ...normalized[key], values: null };
    }
  });
  return normalized;
};

const loadStatCountsFromStorage = (): ServerStatCounts | null => {
  try {
    const raw = localStorage.getItem(DASHBOARD_STAT_COUNTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value?: ServerStatCounts };
    return parsed.value ?? null;
  } catch (e) {
    console.warn("Failed to load stat counts from localStorage:", e);
    return null;
  }
};

const saveStatCountsToStorage = (counts: ServerStatCounts) => {
  try {
    localStorage.setItem(
      DASHBOARD_STAT_COUNTS_CACHE_KEY,
      JSON.stringify({ value: counts, savedAt: Date.now() })
    );
  } catch (e) {
    console.warn("Failed to save stat counts to localStorage:", e);
  }
};

const Dashboard: React.FC = () => {
  const { t } = useTranslation("dashboard");
  const timeAgo = useTimeAgo();
  const [memos, setMemos] = useState<Memo[]>([]);

  // Server-side search authoritative data (populated by adapter useEffect
  // when USE_NEW_SEARCH=true; null otherwise). These shadow legacy
  // computed values (statusCounts, totalRows, options) when populated.
  const [serverStatCounts, setServerStatCounts] =
    useState<ServerStatCounts | null>(() =>
      USE_NEW_SEARCH ? loadStatCountsFromStorage() : null
    );
  const [serverStatCountsLoading, setServerStatCountsLoading] =
    useState(false);
  const [serverFacets, setServerFacets] = useState<ServerFacets | null>(null);
  const [serverTotal, setServerTotal] = useState(0);
  const [serverTotalPages, setServerTotalPages] = useState(1);
  const searchMetaLoadedRef = useRef({
    statCounts: false,
    facets: false,
  });

  // Define INITIAL_COL_FILTERS first before using it
  const INITIAL_COL_FILTERS: Record<ColKey, ColumnFilterState> = {
    memonumber: {},
    subject: {},
    author: { values: null },
    status: { values: null },
    current: { values: null },
    extra: { values: null },
    latest: {},
    expires: {},
    createdAt: {},
    ccStatus: { values: null },
  };

  // Load saved filters from localStorage
  const savedFilters = useMemo(() => loadFiltersFromStorage(), []);
  const savedColFilters = useMemo(() => {
    const stored = loadColFiltersFromStorage();
    return stored ? normalizeSavedColFilters(stored) : null;
  }, []);
  const savedSortState = useMemo(() => loadSortStateFromStorage(), []);

  const [approverFilter, setApproverFilter] = useState<number | "All">(
    savedFilters?.approverFilter ?? "All"
  );
  const [currentApprovers, setCurrentApprovers] = useState<CurrentApprover[]>(
    []
  );
  const currentApproversLoadedRef = useRef(false);
  const [searchTerm, setSearchTerm] = useState(savedFilters?.searchTerm ?? "");
  const [loading, setLoading] = useState(true);
  const [businessUnits, setBusinessUnits] = useState<BusinessUnit[]>([]);
  const [buFilter, setBuFilter] = useState<number | "All">(
    savedFilters?.buFilter ?? "All"
  );
  const [deptFilter, setDeptFilter] = useState<number | "All">(
    savedFilters?.deptFilter ?? "All"
  );
  type View = "ALL" | "MY_APPROVAL" | "MY_CREATED" | `STATUS:${string}`;
  const [view, setView] = useState<View>(savedFilters?.view ?? "ALL");
  const onlyMyApproval = view === "MY_APPROVAL";
  const onlyMyCreated = view === "MY_CREATED";
  const statusFilter: StatusAll = view.startsWith("STATUS:")
    ? (view.split(":")[1] as StatusAll)
    : "All";
    
  // ⬅️ ADD: Load sortByLatestAction from localStorage
  const [sortByLatestAction, setSortByLatestAction] = useState(
    savedFilters?.sortByLatestAction ?? false
  );

  // Column visibility state
  const [visibleColumns, setVisibleColumns] = useState<
    Record<VisibleColKey, boolean>
  >(
    savedFilters?.visibleColumns ?? {
      number: true,
      status: true,
      subject: true,
      author: true,
      currentApprover: true,
      extraApprover: true,
      latestComment: true,
      expires: true,
      createdAt: true,
      ccStatus: true,
    }
  );

  const toggleColumnVisibility = (key: VisibleColKey) => {
    setVisibleColumns((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // ให้ชื่อตัวเดิมไว้ใช้กับ FilterMenu ได้เหมือนเดิม
  const setStatusFilter = (s: StatusAll) =>
    setView(s === "All" ? "ALL" : (`STATUS:${s}` as View));

  // Persist filters to localStorage
  useEffect(() => {
    const filters = {
      approverFilter,
      searchTerm,
      buFilter,
      deptFilter,
      view,
      sortByLatestAction, // ✅
      visibleColumns, // ✅
    };
    try {
      localStorage.setItem(DASHBOARD_FILTERS_KEY, JSON.stringify(filters));
    } catch (e) {
      console.warn("Failed to save dashboard filters to localStorage:", e);
    }
  }, [approverFilter, searchTerm, buFilter, deptFilter, view, sortByLatestAction, visibleColumns]);

  const navigate = useNavigate();
  const [departments, setDepartments] = useState<Department[]>([]);
  // state สำหรับเปิด/ปิด panel
  const [filterOpen, setFilterOpen] = useState(false);
  // ----- state section (ย้ายอันนี้ขึ้นมา) -----
  const [approverMap, setApproverMap] = useState<
    Record<number, ApproverStatus[]>
  >({});

  const thCollator = useMemo(
    () =>
      new Intl.Collator(["th", "en"], {
        usage: "sort",
        sensitivity: "base",
        numeric: true,
        ignorePunctuation: true,
      }),
    []
  );

  const [colFilters, setColFilters] = useState<
    Record<ColKey, ColumnFilterState>
  >(() => {
    if (!savedColFilters) return { ...INITIAL_COL_FILTERS };
    // Merge saved filters with initial defaults so newly added keys are always present
    return { ...INITIAL_COL_FILTERS, ...savedColFilters };
  });
  const [sortState, setSortState] = useState<{
    key: ColKey;
    dir: SortDir;
  } | null>(savedSortState ?? null);

  // Persist column filters to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(DASHBOARD_COL_FILTERS_KEY, JSON.stringify(colFilters));
    } catch (e) {
      console.warn("Failed to save column filters to localStorage:", e);
    }
  }, [colFilters]);

  // Persist sort state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(DASHBOARD_SORT_STATE_KEY, JSON.stringify(sortState));
    } catch (e) {
      console.warn("Failed to save sort state to localStorage:", e);
    }
  }, [sortState]);

  const authorLabel = (u: Memo["user"]) =>
    [u?.name, u?.lastname].filter(Boolean).join(" ") +
    (u?.nickname ? ` (${u.nickname})` : "");
  const currentApproverText = (m: Memo) => {
    if (!isProcessingMemo(m)) return "";

    const rows = approverMap[m.id] ?? [];
    if (rows.length > 0) {
      // ✅ Use helper to show only ACTIVE approvers
      const active = getActionableCurrentApprovers(m, rows);
      if (active.length > 0) {
        return active.map((r) => r.name).join(", ");
      }
      // If none are waiting (e.g. approved/rejected/terminated), show status or empty
      // But typically "Current Approver" column usually shows nothing if process is done.
      // Let's return empty if no one is waiting.
      return "";
    }

    // Fallback if no approverMap yet (rarely happens if loaded)
    const namesFromSummary = m.currentApprover?.names ?? [];
    return namesFromSummary.join(", ");
  };

  const latestCommentText = (m: Memo) => {
    // ดึงข้อความสรุปล่าสุด ถ้าไม่มีก็ใช้ comment/snippet ตรง ๆ
    const { text } = buildLatestCommentSummary(m.latestComment, t);
    return text || m.latestComment?.comment || m.latestComment?.snippet || "";
  };
  const getCellVal = (m: Memo, key: ColKey): string => {
    switch (key) {
      case "memonumber":
        return m.memonumber || "";
      case "subject":
        return m.subject || "";
      case "author":
        return authorLabel(m.user) || "";
      case "status":
        return m.status || "";
      case "current":
        return currentApproverText(m); // ⬅️ ใหม่
      case "extra":
        return extraApproverText(m); // ⬅️ ใหม่
      case "latest":
        return latestCommentText(m); // ⬅️ ใหม่
      case "expires":
        return m.expiresAt || "";
      case "createdAt":
        return m.createdAt || "";
      case "ccStatus":
        // คืนรายชื่อคนที่เป็น CC ในเอกสารนี้ (ถ้า user มีสิทธิ์เห็น)
        if (!me) return "";

        const isCreator = m.user?.id === me.id;
        const isCC = myCCMemoIds.has(m.id);

        if (isCreator || isCC) {
          const ccList = memosCCData[m.id] || [];
          return ccList.map(ccUser => ccUserLabel(ccUser)).join(", ");
        }

        return "";
    }
  };

  const ApprovalProgress: React.FC<{
    memoId: number;
    status?: Status | string;
    className?: string;
    style?: React.CSSProperties;
  }> = ({ memoId, status, className, style }) => {
    const rows = approverMap[memoId] || [];
    const total = rows.length;
    const acted = rows.filter((r) => r.statusCode !== "waiting").length;
    const pct = total ? Math.round((acted / total) * 100) : 0;

    // เลือกสีของ "แถบที่ไหล" ตามสถานะ (fallback เป็น default)
    const key = (status && STATUS_ORDER.includes(status as Status)) ? (status as string) : "default";
    const { fill } = PROGRESS_COLORS[key] ?? PROGRESS_COLORS.default;

    return (
      <div className={`${className || ""}`} style={style}>
        {/* ราง: สีเทาคงที่ */}
        <div className="relative h-3 w-full overflow-hidden rounded-full bg-gray-200">
          {/* แถบที่เลื่อน: สีตามสถานะ */}
          <div
            className={`absolute left-0 top-0 h-full transition-[width] duration-300 ease-out ${fill}`}
            style={{ width: `${pct}%` }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-white drop-shadow-sm">
            {acted}/{total}
          </div>
        </div>
      </div>
    );
  };

  const StatusWithProgress: React.FC<{ status?: Status | string; memoId: number }> = ({ status, memoId }) => {
    const badgeRef = React.useRef<HTMLSpanElement>(null);
    const [w, setW] = React.useState<number>(0);

    React.useLayoutEffect(() => {
      const el = badgeRef.current;
      if (!el) return;
      const update = () => setW(el.offsetWidth);
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }, [status]);

    return (
      <div className="inline-flex flex-col items-center gap-1">
        {/* ให้ badge เป็นตัวกำหนดความกว้าง */}
        <span ref={badgeRef} className="inline-block">
          <StatusBadge status={status as Status} />
        </span>

        {/* Progress จะกว้างเท่ากับ badge เป๊ะ */}
        <ApprovalProgress
          memoId={memoId}
          status={status}
          style={{ width: w ? `${w}px` : undefined }}
        />
      </div>
    );
  };

  // รายชื่อ Current Approver ทั้งหมด (จาก approverMap; ถ้าไม่มีให้ fallback จาก memo.currentApprover.names)
  const currentApproverOptions = useMemo(() => {
    if (USE_NEW_SEARCH && serverFacets) {
      return serverFacets.currentApprovers
        .map((u) => ({ value: String(u.id), label: u.name }))
        .sort((a, b) => thCollator.compare(a.label, b.label));
    }
    const set = new Set<string>();
    memos.forEach((m) => {
      if (!isProcessingMemo(m)) return;

      const rows = approverMap[m.id];
      if (rows?.length) {
        getActionableCurrentApprovers(m, rows).forEach((r) => set.add(r.name));
      } else {
        (m.currentApprover?.names ?? []).forEach((n) => set.add(n));
      }
    });
    return Array.from(set).sort((a, b) => thCollator.compare(a, b));
  }, [memos, approverMap, thCollator, serverFacets]);

  const filterMenuApprovers = useMemo(() => {
    const byId = new Map<number, CurrentApprover>();

    for (const approver of currentApprovers) {
      byId.set(approver.id, approver);
    }

    if (USE_NEW_SEARCH && serverFacets) {
      for (const approver of [
        ...serverFacets.currentApprovers,
        ...serverFacets.extraApprovers,
      ]) {
        if (!byId.has(approver.id)) {
          byId.set(approver.id, {
            id: approver.id,
            name: approver.name,
          });
        }
      }
    }

    return Array.from(byId.values()).sort((a, b) =>
      thCollator.compare(getApproverLabel(a), getApproverLabel(b))
    );
  }, [currentApprovers, serverFacets, thCollator]);

  const authorOptions = useMemo(
    () =>
      Array.from(new Set(memos.map((m) => authorLabel(m.user))))
        .filter(Boolean)
        .sort((a, b) => thCollator.compare(a, b)), // ✅
    [memos, thCollator]
  );

  const statusOptions = useMemo(
    () =>
      Array.from(new Set(memos.map((m) => m.status || "")))
        .filter(Boolean)
        .sort((a, b) => thCollator.compare(a, b)), // ✅
    [memos, thCollator]
  );

  const getExpiryMeta = (iso?: string | null, status?: string | null) => {
    const base = {
      cls: "text-gray-500",
      label: t("expiry.status.none"),
      icon: (
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <path
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12H9M12 3a9 9 0 110 18 9 9 0 010-18z"
          />
        </svg>
      ),
    };

    if (!iso) return base;
    if (isFrozenExpiryStatus(status)) {
      return {
        cls: "text-red-600",
        label: t("expiry.status.expired"),
        icon: (
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <path
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v4m0 4h.01M12 3a9 9 0 110 18 9 9 0 010-18z"
            />
          </svg>
        ),
      };
    }
    const d = new Date(iso);
    if (isNaN(+d)) return base;

    const now = Date.now();
    const diffMs = d.getTime() - now;
    const days = diffMs / (1000 * 60 * 60 * 24);

    if (diffMs < 0) {
      // หมดอายุแล้ว
      return {
        cls: "text-red-600",
        label: t("expiry.status.expired"),
        icon: (
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <path
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v4m0 4h.01M12 3a9 9 0 110 18 9 9 0 010-18z"
            />
          </svg>
        ),
      };
    }
    if (days <= 3) {
      return {
        cls: "text-amber-600",
        label: t("expiry.status.soon"),
        icon: (
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            <path
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 8v4l3 3M12 3a9 9 0 110 18 9 9 0 010-18z"
            />
          </svg>
        ),
      };
    }
    // กำหนดวันหมดอายุ และยังไม่หมดอายุ
    return {
      cls: "text-green-600",
      label: t("expiry.status.active"),
      icon: (
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
        >
          <path
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12l2 2 4-4M12 3a9 9 0 110 18 9 9 0 010-18z"
          />
        </svg>
      ),
    };
  };

  // ถ้าเอกสาร Approved/Terminated ให้ถือว่า "closed" ในคอลัมน์ Subject
  const getSubjectStatusKey = (m: Memo): ExpiryKey => {
    const s = (m.status || "").toLowerCase();
    if (s === "approved" || s === "terminated") return "closed";
    return getExpiryStatusKey(m.expiresAt, m.status); // เดิม: expired/soon/active/none
  };

  // meta สำหรับโชว์ใต้ Subject (label + icon + สี)
  const getSubjectStatusMeta = (
    m: Memo,
    t?: (k: string) => string
  ): { cls: string; label: string; icon: React.ReactNode } => {
    const key = getSubjectStatusKey(m);

    if (key === "closed") {
      return {
        cls: "text-gray-700", // โทนปิดงาน
        label: t ? t("expiry.status.closed") : "Closed",
        icon: (
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
          >
            {/* padlock icon */}
            <path
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 11V7a4 4 0 018 0v4M6 11h12a2 2 0 012 2v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5a2 2 0 012-2z"
            />
          </svg>
        ),
      };
    }

    // อย่างอื่นใช้ของเดิม (active/soon/expired/none)
    return getExpiryMeta(m.expiresAt, m.status);
  };

  type ExtraStatusCode = "waiting" | "approved" | "rejected" | "terminated" | "not_required";
  type ExtraApproverRow = {
    userId?: number; // ⬅️ NEW
    name: string;
    statusCode: ExtraStatusCode;
    since?: string | null;
    actedAt?: string | null;
    level?: number | null;
    order?: number | null;
  };
  type ExtraSummary = {
    status?: string;
    approvers: ExtraApproverRow[];
  };

  const [extraMap, setExtraMap] = useState<Record<number, ExtraSummary | null>>(
    {}
  );

  // แล้วค่อยตามด้วยฟังก์ชันที่ใช้ extraMap
  const extraApproverText = (m: Memo) =>
    extraMap[m.id]?.approvers?.map((a) => a.name).join(", ") ?? "";

  const extraApproverOptions = useMemo(() => {
    if (USE_NEW_SEARCH && serverFacets) {
      return serverFacets.extraApprovers
        .map((u) => ({ value: String(u.id), label: u.name }))
        .sort((a, b) => thCollator.compare(a.label, b.label));
    }
    const set = new Set<string>();
    Object.values(extraMap).forEach((s) =>
      s?.approvers?.forEach((a) => set.add(a.name))
    );
    return Array.from(set).sort((a, b) => thCollator.compare(a, b));
  }, [extraMap, thCollator, serverFacets]);

  // ---- helper แปลงชื่อ-สถานะ ----
  const displayName = (u: any) => {
    const full = [u?.name, u?.lastname].filter(Boolean).join(" ").trim();
    return u?.nickname ? `${full} (${u.nickname})` : full || u?.name || "-";
  };

  // Helper สำหรับ CC users (ไม่มี department) - แสดงชื่อแบบ unique
  const ccUserLabel = (u: { id: number, name: string, lastname?: string, nickname?: string }) => {
    const full = [u?.name, u?.lastname].filter(Boolean).join(" ").trim();
    const nick = u?.nickname?.trim();

    // ถ้ามี nickname ให้แสดงแบบ "ชื่อเต็ม (nickname)"
    if (nick) {
      return `${full} (${nick})`;
    }

    // ถ้าไม่มี nickname แต่มีชื่อเต็ม
    if (full) {
      return full;
    }

    // fallback ใช้ name เดิม
    return u?.name || `User-${u.id}`;
  };
  const normalizeStatusCode = (name?: string | null): ExtraStatusCode => {
    const s = String(name || "").toLowerCase();
    if (/(terminat|cancel|withdraw|recall|stop|abort)/.test(s))
      return "terminated";
    if (/reject|declin|den(y|ied|ies|ying)/.test(s)) return "rejected";
    if (/approv/.test(s)) return "approved";
    return "waiting";
  };
  const fmtExpiry = (iso?: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(+d)) return "";
    return d.toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  // ----------------------------------------------

  // นับจำนวนฟิลเตอร์ที่ใช้งาน เพื่อโชว์ badge 1,2,3...
  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (statusFilter !== "All") n++;
    if (approverFilter !== "All") n++;
    if (buFilter !== "All") n++;
    if (deptFilter !== "All") n++;
    if (onlyMyApproval) n++; // ✅ ตามต้องการ
    if (onlyMyCreated) n++; // ✅ เพิ่ม My Created
    if (sortByLatestAction) n++;
    return n;
  }, [statusFilter, approverFilter, buFilter, deptFilter, onlyMyApproval, onlyMyCreated, sortByLatestAction]);
  type Me = { id: number; name?: string; nickname?: string; lastname?: string };
  const [me, setMe] = useState<Me | null>(null);

  // ⬅️ ADD: โหลด memos ที่ user เป็น CC
  const [myCCMemos, setMyCCMemos] = useState<Memo[]>([]);

  // ⬅️ ADD: Set ของ memo IDs ที่ user เป็น CC (สำหรับ sort/filter)
  const myCCMemoIds = useMemo(() => {
    return new Set(myCCMemos.map(m => m.id));
  }, [myCCMemos]);

  // ⬅️ ADD: เก็บข้อมูล CC ของแต่ละ memo
  const [memosCCData, setMemosCCData] = useState<Record<number, Array<{ id: number, name: string, lastname?: string, nickname?: string }>>>({});

  const ccStatusOptions = useMemo(() => {
    if (USE_NEW_SEARCH && serverFacets) {
      return serverFacets.ccUsers
        .map((u) => ({ value: String(u.id), label: u.name }))
        .sort((a, b) => thCollator.compare(a.label, b.label));
    }
    if (!me) return [];

    const ccUsersMap = new Map<number, string>(); // ใช้ user ID เป็น key

    // เพิ่มชื่อตัวเองเป็น default เสมอ (ใช้ format เดียวกับคนอื่น)

    const myDisplayName = ccUserLabel({
      id: me.id,
      name: me.name || "",
      lastname: me.lastname,
      nickname: me.nickname
    });

    ccUsersMap.set(me.id, myDisplayName);

    // วนดูทุก memo เพื่อหารายชื่อ CC ที่ user มีสิทธิ์เห็น
    memos.forEach((memo) => {
      const isCreator = memo.user?.id === me.id;
      const isCC = myCCMemoIds.has(memo.id);

      // ถ้า user เป็น creator หรือ CC ของ memo นี้
      if (isCreator || isCC) {
        const ccList = memosCCData[memo.id] || [];
        ccList.forEach((ccUser) => {
          const ccUserName = ccUserLabel(ccUser);
          if (ccUserName.trim()) {
            // ใช้ user ID เป็น key เพื่อป้องกันการซ้ำ
            ccUsersMap.set(ccUser.id, ccUserName);
          }
        });
      }
    });

    // แปลงกลับเป็น array ของชื่อ (ไม่ซ้ำเพราะใช้ user ID เป็น key)
    return Array.from(ccUsersMap.values()).sort((a, b) => thCollator.compare(a, b));
  }, [memos, myCCMemoIds, memosCCData, me, thCollator, serverFacets]);

  // ⬅️ ADD: โหลด /api/me
  useEffect(() => {
    axios
      .get<Me>("/api/me", { withCredentials: true })
      .then((res) => setMe(res.data))
      .catch(() => setMe(null));
  }, []);
  useEffect(() => {
    // SKIP when server-side search is enabled — useMemoSearch handles loading
    if (USE_NEW_SEARCH) {
      setLoading(false);
      return;
    }
    // Fetch memos
    axios
      .get<Memo[]>("/api/memos", {
        withCredentials: true,
      })
      .then((res) => {
        const normalized = (res.data || []).map((m) => ({
          ...m,
          latestComment: m.latestComment
            ? {
              ...m.latestComment,
              attachments: (m.latestComment.attachments ?? []).map((a) => ({
                ...a,
                url: toSecureUploadUrl(a.url),
              })),
            }
            : null,
        }));
        setMemos(normalized);
      })
      .catch((err) => {
        if (err.response) {
          console.error(
            "❌ API Error:",
            err.response.status,
            err.response.data
          );
          if (err.response.status === 401) {
            console.warn("🔴 Not authenticated. Redirecting to /login...");
            window.location.href = "/login";
          }
        } else {
          console.error("❌ Request failed:", err.message);
        }
      })
      .finally(() => {
        setLoading(false);
      });

    // Fetch current approvers for filter
    axios
      .get<CurrentApprover[]>("/api/memos/current-approvers", {
        withCredentials: true,
      })
      .then((res) => {
        setCurrentApprovers(res.data);
      })
      .catch((err) => {
        console.error("Failed to fetch current approvers:", err);
      });
  }, []);

  useEffect(() => {
    if (!USE_NEW_SEARCH || !filterOpen || currentApproversLoadedRef.current) {
      return;
    }

    let cancelled = false;
    currentApproversLoadedRef.current = true;

    axios
      .get<CurrentApprover[]>("/api/memos/current-approvers", {
        withCredentials: true,
      })
      .then((res) => {
        if (!cancelled) {
          setCurrentApprovers(res.data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          currentApproversLoadedRef.current = false;
          console.error("Failed to fetch current approvers:", err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filterOpen]);

  // Separate useEffect for CC memos (depends on me)
  useEffect(() => {
    if (!me) return;

    axios
      .get("/api/memos/cc/me", { withCredentials: true })
      .then((res) => {
        // Convert CC memo format to regular memo format
        const ccMemos: Memo[] = (res.data || []).map((ccMemo: any) => ({
          id: ccMemo.id,
          subject: ccMemo.subject,
          memonumber: ccMemo.memonumber,
          user: ccMemo.owner,
          status: ccMemo.latestStatus,
          createdAt: ccMemo.latestStatusAt,
          // Add minimal required fields
          department: { id: 0, name: "" },
          businessUnit: { id: 0, name: "" },
          team: { id: 0, name: "" },
          memoType: { name: ccMemo.type || "" },
        }));
        setMyCCMemos(ccMemos);
      })
      .catch((err) => {
        console.error("Failed to fetch CC memos:", err);
      });
  }, [me]);

  // ⬅️ ADD: โหลดข้อมูล CC ของแต่ละ memo
  useEffect(() => {
    if (USE_NEW_SEARCH) return; // hook adapter populates memosCCData
    if (!memos.length || !me) return;

    const fetchCCData = async () => {
      const ccDataMap: Record<number, Array<{ id: number, name: string, lastname?: string, nickname?: string }>> = {};

      await Promise.all(
        memos.map(async (memo) => {
          try {
            // เช็คว่า user เป็น creator หรือ CC ของ memo นี้หรือไม่
            const isCreator = memo.user?.id === me.id;
            const isCC = myCCMemoIds.has(memo.id);

            if (isCreator || isCC) {
              const { data } = await axios.get(`/api/memos/${memo.id}/cc`, { withCredentials: true });
              ccDataMap[memo.id] = data.users || [];
            }
          } catch (error) {
            console.error(`Failed to fetch CC data for memo ${memo.id}:`, error);
            ccDataMap[memo.id] = [];
          }
        })
      );

      setMemosCCData(ccDataMap);
    };

    fetchCCData();
  }, [memos, me, myCCMemoIds]);
  useEffect(() => {
    if (USE_NEW_SEARCH) return; // hook adapter populates approverMap
    if (!memos.length) return;

    const ids = memos.map((m) => m.id);
    let cancelled = false;

    (async () => {
      try {
        const { data } = await axios.post<Record<number, ApproverStatus[]>>(
          "/api/memos/approver-status/bulk",
          { memoIds: ids },
          { withCredentials: true }
        );
        if (cancelled) return;
        // Backend omits memos the user can't see; default those to [] so callers
        // never read undefined for an id that's in the dashboard list.
        const next: Record<number, ApproverStatus[]> = {};
        for (const id of ids) next[id] = data?.[id] ?? [];
        setApproverMap(next);
      } catch (e) {
        if (!cancelled) console.error("bulk approver-status failed", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [memos]);

  useEffect(() => {
    axios
      .get<BusinessUnit[]>("/api/business-units", { withCredentials: true })
      .then((res) => setBusinessUnits(res.data))
      .catch((err) => console.error("Failed to fetch BUs:", err));
  }, []);
  useEffect(() => {
    setDeptFilter("All");
  }, [buFilter]);
  useEffect(() => {
    axios
      .get<Department[]>("/api/departments", { withCredentials: true })
      .then((res) => {
        setDepartments(res.data || []);
      })
      .catch((err) => {
        console.error(
          "Failed to fetch departments:",
          err?.response?.status,
          err?.response?.data || err.message
        );
      });
  }, []);

  useEffect(() => {
    if (USE_NEW_SEARCH) return; // hook adapter populates extraMap
    if (!memos.length) return;

    const ids = memos.map((m) => m.id);
    let cancelled = false;

    (async () => {
      try {
        const { data } = await axios.post<
          Record<
            number,
            { id: number; status: string; createdAt?: string; approvers: any[] } | null
          >
        >(
          "/api/memos/extra-approval-lines/active/bulk",
          { memoIds: ids },
          { withCredentials: true }
        );
        if (cancelled) return;

        const next: Record<number, ExtraSummary | null> = {};
        for (const id of ids) {
          const entry = data?.[id];
          if (!entry) {
            next[id] = null;
            continue;
          }
          const rows: ExtraApproverRow[] = (entry.approvers ?? []).map(
            (a: any, idx: number) => ({
              userId: a?.user?.id,
              name: displayName(a.user),
              statusCode: normalizeStatusCode(a?.status?.name),
              since: a?.since ?? a?.createdAt ?? null,
              actedAt: a?.actedAt ?? null,
              level: a?.level ?? a?.approvalLevel ?? null,
              order: a?.order ?? a?.seq ?? a?.sequence ?? idx,
            })
          );
          // ✅ เรียง: level -> order -> name
          const sorted = rows.sort((x, y) => {
            const lx = x.level ?? Number.MAX_SAFE_INTEGER;
            const ly = y.level ?? Number.MAX_SAFE_INTEGER;
            if (lx !== ly) return lx - ly;
            const ox = x.order ?? 0;
            const oy = y.order ?? 0;
            if (ox !== oy) return ox - oy;
            return x.name.localeCompare(y.name);
          });
          next[id] = { status: entry.status, approvers: sorted };
        }
        setExtraMap(next);
      } catch (e) {
        if (!cancelled) console.error("bulk extra-approval-lines failed", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [memos]);

  // ⬅️ ADD: รายการ/จำนวนเมโม่ที่ถึงคิวเรา (หลัก+extra)
  const myApprovalMemos = useMemo(
    () =>
      memos.filter(
        (m) =>
          m.status === "Processing" && (isMyTurnMain(m) || isMyTurnExtra(m))
      ),
    [memos, approverMap, extraMap, me]
  );
  // Use server-authoritative count when flag on (counts the FULL set,
  // not the paged slice).
  const approvalRequestCount =
    USE_NEW_SEARCH && serverStatCounts
      ? serverStatCounts.myApproval
      : myApprovalMemos.length;

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) =>
    setSearchTerm(e.target.value.toLowerCase());

  const resetFilters = (opts: { keepMyApproval?: boolean } = {}) => {
    const { keepMyApproval = true } = opts;

    setApproverFilter("All");
    setBuFilter("All");
    setDeptFilter("All");
    setSearchTerm("");
    setColFilters({ ...INITIAL_COL_FILTERS });
    setSortState(null);
    setSortByLatestAction(false);

    // เดิมปิด onlyMyApproval — ตอนนี้ใช้ view แทน
    if (!keepMyApproval) setView("ALL");
  };

  const hasActiveFilters =
    statusFilter !== "All" ||
    approverFilter !== "All" ||
    buFilter !== "All" ||
    deptFilter !== "All" ||
    searchTerm !== "" ||
    onlyMyApproval ||
    onlyMyCreated ||
    sortByLatestAction ||
    sortState !== null ||
    Object.values(colFilters).some(
      (state) =>
        (state.values && state.values.length > 0) ||
        (state.search && state.search.trim() !== "") ||
        (state.dateFrom) ||
        (state.dateTo) ||
        (state.expiry && state.expiry.length > 0)
    );

  const getDeptName = (deptId: number, buId: number | "All") => {
    // ถ้ามี departments ใต้ BU แล้ว ใช้อันนั้นก่อน
    if (buId !== "All") {
      const bu = businessUnits.find((b) => b.id === buId);
      const fromBU = bu?.departments?.find((d) => d.id === deptId)?.name;
      if (fromBU) return fromBU;
    }
    // fallback จาก /api/departments ที่โหลดมาแยก
    return departments.find((d) => d.id === deptId)?.name ?? "";
  };

  // Optimized: Compute status counts once.
  // When server-side search is enabled, prefer authoritative counts from
  // /api/memos/search response (counts the FULL visible set, not paged slice).
  const statusCounts = useMemo(() => {
    if (USE_NEW_SEARCH && serverStatCounts) {
      return {
        total: serverStatCounts.total,
        Draft: serverStatCounts.Draft,
        Processing: serverStatCounts.Processing,
        Approved: serverStatCounts.Approved,
        Rejected: serverStatCounts.Rejected,
        Terminated: serverStatCounts.Terminated,
        Published: serverStatCounts.Published,
        Recalled: serverStatCounts.Recalled,
      };
    }

    const counts = {
      total: memos.length,
      Draft: 0,
      Processing: 0,
      Approved: 0,
      Rejected: 0,
      Terminated: 0,
      Published: 0,
      Recalled: 0,
    };

    memos.forEach((memo) => {
      const status = memo.status as keyof typeof counts;
      if (status && Object.prototype.hasOwnProperty.call(counts, status)) {
        counts[status]++;
      }
    });

    return counts;
  }, [memos, serverStatCounts]);

  // คำนวณจำนวน memos ที่ user เป็น CC (ไม่รวม Deleted)
  const myCCMemosCount = useMemo(() => {
    if (USE_NEW_SEARCH && serverStatCounts) return serverStatCounts.myCC;
    return myCCMemos.filter(m => m.status !== "Deleted").length;
  }, [myCCMemos, serverStatCounts]);

  // คำนวณจำนวน memos ที่ user สร้างเอง
  const myCreatedMemosCount = useMemo(() => {
    if (USE_NEW_SEARCH && serverStatCounts) return serverStatCounts.myCreated;
    if (!me) return 0;
    return memos.filter((m) => m.user?.id === me.id).length;
  }, [memos, me, serverStatCounts]);

  // Configuration for stat cards
  const statCardConfigs = useMemo(
    () => [
      {
        key: "total",
        labelKey: "stats.total",
        status: "All" as const,
        borderClass: "border-sky-400",
        bgFlashClass: "bg-sky-400",
        filterable: true,
      },
      {
        key: "Draft",
        labelKey: "stats.draft",
        status: "Draft" as const,
        borderClass: "border-gray-500",
        bgFlashClass: "bg-gray-500",
        filterable: true,
      },
      {
        key: "Processing",
        labelKey: "stats.processing",
        status: "Processing" as const,
        borderClass: "border-yellow-500",
        bgFlashClass: "bg-yellow-500",
        filterable: true,
      },
      {
        key: "Approved",
        labelKey: "stats.approved",
        status: "Approved" as const,
        borderClass: "border-green-500",
        bgFlashClass: "bg-green-500",
        filterable: true,
      },
      {
        key: "Rejected",
        labelKey: "stats.rejected",
        status: "Rejected" as const,
        borderClass: "border-orange-500",
        bgFlashClass: "bg-orange-500",
        filterable: true,
      },
      {
        key: "Terminated",
        labelKey: "stats.terminated",
        status: "Terminated" as const,
        borderClass: "border-red-500",
        bgFlashClass: "bg-red-500",
        filterable: true,
      },
    ],
    []
  );
  const totalCfg = useMemo(
    () => statCardConfigs.find((c) => c.key === "total"),
    [statCardConfigs]
  );
  const otherCfgs = useMemo(
    () => statCardConfigs.filter((c) => c.key !== "total"),
    [statCardConfigs]
  );

  const visibleMemos = useMemo(() => {
    let filtered = memos.filter((m) => {
      const subKey = getSubjectStatusKey(m); // ✅ ใช้คีย์ใหม่
      const expLabel = t(`expiry.status.${subKey}`);
      const expKey = getExpiryStatusKey(m.expiresAt, m.status); // "none" | "expired" | "soon" | "active"

      const values = [
        m.subject,
        m.documentCode,
        m.memonumber,
        m.user?.name,
        m.department?.name,
        m.businessUnit?.name,
        m.team?.name,
        m.memoType?.name,
        expLabel, // ✅ ให้ค้นหาด้วยคำสถานะ (ภาษาปัจจุบัน)
        expKey, // ✅ และคีย์ภาษาอังกฤษ (เผื่อพิมพ์ว่า expired/soon/active)
        subKey,
      ]
        .join(" ")
        .toLowerCase();
      return values.includes(searchTerm);
    });

    // text filter: memonumber
    if (colFilters.memonumber.search?.trim()) {
      const q = colFilters.memonumber.search.trim().toLowerCase();
      filtered = filtered.filter((m) =>
        getCellVal(m, "memonumber").toLowerCase().includes(q)
      );
    }

    // text filter: subject
    if (colFilters.subject.search?.trim()) {
      const q = colFilters.subject.search.trim().toLowerCase();
      filtered = filtered.filter((m) =>
        getCellVal(m, "subject").toLowerCase().includes(q)
      );
    }

    // list filter: author
    if (colFilters.author.values && colFilters.author.values.length > 0) {
      const set = new Set(colFilters.author.values);
      filtered = filtered.filter((m) => set.has(getCellVal(m, "author")));
    }
    if (colFilters.current.search?.trim()) {
      const q = colFilters.current.search.trim().toLowerCase();
      filtered = filtered.filter((m) =>
        isProcessingMemo(m) && getCellVal(m, "current").toLowerCase().includes(q)
      );
    }
    // ✅ แทนที่บล็อกนี้ทั้งก้อน
    if (colFilters.current.values && colFilters.current.values.length > 0) {
      // ตัวเลือกจาก HeaderFilter ของคอลัมน์ "Current Approver" เป็นชื่อ
      // แต่เผื่ออนาคตมีค่าเป็น id (string ของตัวเลข) เลยรองรับทั้งสองแบบ
      const selectedNames = new Set(
        colFilters.current.values.filter((v) => Number.isNaN(Number(v)))
      );
      const selectedIds = new Set<number>(
        colFilters.current.values
          .map((v) => Number(v))
          .filter((v) => !Number.isNaN(v))
      );

      filtered = filtered.filter((m) => {
        if (!isProcessingMemo(m)) return false;

        const rows = approverMap[m.id] ?? [];
        if (rows.length) {
          // ✅ Only match if the user is currently ACTIVE
          const active = getActionableCurrentApprovers(m, rows);
          // เช็คทั้งชื่อและ userId (ถ้ามี)
          return active.some(
            (r) => selectedNames.has(r.name) || selectedIds.has(r.userId)
          );
        }

        // fallback: กรณียังไม่มี approverMap ให้ใช้ชื่อจาก currentApprover
        const fallbackNames = m.currentApprover?.names ?? [];
        return fallbackNames.some((n) => selectedNames.has(n));
      });
    }

    // -- คอลัมน์ Extra Approver แบบลิสต์ --
    if (colFilters.extra.values && colFilters.extra.values.length > 0) {
      const selectedNames = new Set(
        colFilters.extra.values.filter((v) => Number.isNaN(Number(v)))
      );
      const selectedIds = new Set<number>(
        colFilters.extra.values
          .map((v) => Number(v))
          .filter((v) => !Number.isNaN(v))
      );
      filtered = filtered.filter((m) => {
        const approvers = extraMap[m.id]?.approvers ?? [];
        return approvers.some(
          (a) =>
            selectedNames.has(a.name) ||
            (a.userId !== undefined && selectedIds.has(a.userId))
        );
      });
    }
    // text filter: extra approver
    if (colFilters.extra.search?.trim()) {
      const q = colFilters.extra.search.trim().toLowerCase();
      filtered = filtered.filter((m) =>
        getCellVal(m, "extra").toLowerCase().includes(q)
      );
    }

    // text filter: latest comment
    if (colFilters.latest.search?.trim()) {
      const q = colFilters.latest.search.trim().toLowerCase();
      filtered = filtered.filter((m) =>
        getCellVal(m, "latest").toLowerCase().includes(q)
      );
    }
    // list filter: status
    if (colFilters.status.values && colFilters.status.values.length > 0) {
      const set = new Set(colFilters.status.values);
      filtered = filtered.filter((m) => set.has(getCellVal(m, "status")));
    }

    // list filter: ccStatus
    if (colFilters.ccStatus.values && colFilters.ccStatus.values.length > 0) {
      const selectedNames = new Set(
        colFilters.ccStatus.values.filter((v) => Number.isNaN(Number(v)))
      );
      const selectedIds = new Set<number>(
        colFilters.ccStatus.values
          .map((v) => Number(v))
          .filter((v) => !Number.isNaN(v))
      );
      filtered = filtered.filter((m) => {
        if (USE_NEW_SEARCH) {
          const ccList = memosCCData[m.id] || [];
          return ccList.some(
            (ccUser) =>
              selectedNames.has(ccUserLabel(ccUser)) || selectedIds.has(ccUser.id)
          );
        }

        if (!me) return false;

        const isCreator = m.user?.id === me.id;
        const isCC = myCCMemoIds.has(m.id);

        if (isCreator || isCC) {
          const ccList = memosCCData[m.id] || [];
          // เช็คว่ามีชื่อที่เลือกอยู่ใน CC list หรือไม่
          return ccList.some(
            (ccUser) =>
              selectedNames.has(ccUserLabel(ccUser)) || selectedIds.has(ccUser.id)
          );
        }

        return false;
      });
    }

    // กรองวันหมดอายุจากฟิลเตอร์ของ Expires (ย้ายมาจาก Subject)
    if (colFilters.expires.expiry && colFilters.expires.expiry.length > 0) {
      const setKeys = new Set(colFilters.expires.expiry);

      filtered = filtered.filter((m) => {
        // 1. เช็คสถานะวันหมดอายุจริงๆ (active/expired/soon/none)
        const realExpiry = getExpiryStatusKey(m.expiresAt, m.status);
        if (setKeys.has(realExpiry)) return true;

        // 2. เช็คสถานะแบบที่แสดงใน Subject (ซึ่งรวม closed ด้วย)
        const displayKey = getSubjectStatusKey(m);


        if (setKeys.has(displayKey)) return true;

        return false;
      });
    }

    // date filter: expires
    if (colFilters.expires.dateFrom || colFilters.expires.dateTo) {

      filtered = filtered.filter((m) => {
        if (!m.expiresAt) return false;
        const mDate = new Date(m.expiresAt).setHours(0, 0, 0, 0);
        const from = colFilters.expires.dateFrom
          ? new Date(colFilters.expires.dateFrom).setHours(0, 0, 0, 0)
          : -Infinity;
        const to = colFilters.expires.dateTo
          ? new Date(colFilters.expires.dateTo).setHours(23, 59, 59, 999)
          : Infinity;
        return mDate >= from && mDate <= to;
      });
    }

    // date filter: createdAt
    if (colFilters.createdAt.dateFrom || colFilters.createdAt.dateTo) {
      filtered = filtered.filter((m) => {
        if (!m.createdAt) return false;
        const mDate = new Date(m.createdAt).setHours(0, 0, 0, 0);
        const from = colFilters.createdAt.dateFrom
          ? new Date(colFilters.createdAt.dateFrom).setHours(0, 0, 0, 0)
          : -Infinity;
        const to = colFilters.createdAt.dateTo
          ? new Date(colFilters.createdAt.dateTo).setHours(23, 59, 59, 999)
          : Infinity;
        return mDate >= from && mDate <= to;
      });
    }

    // sort by chosen column
    if (sortState) {
      const { key, dir } = sortState;
      filtered = [...filtered].sort((a, b) => {
        const av = getCellVal(a, key);
        const bv = getCellVal(b, key);
        // ✅ ใช้ลำดับไทยกับ Subject (หรือจะใช้กับทุกคอลัมน์ก็ได้)
        const cmp = thCollator.compare(av, bv);
        return dir === "asc" ? cmp : -cmp;
      });
    } else if (sortByLatestAction) {
      // ⬅️ ADD: Sort by Latest Action
      filtered = [...filtered].sort((a, b) => {
        const getLatestActionTime = (memo: Memo) => {
          let latestTime = 0;
          
          // Check Main Approvers
          const mainRows = approverMap[memo.id] || [];
          mainRows.forEach((r) => {
            if (r.statusCode !== "waiting" && (r.actedAt || r.since)) {
              const time = new Date(r.actedAt ?? r.since).getTime();
              if (time > latestTime) latestTime = time;
            }
          });

          // Check Extra Approvers
          const extraRows = extraMap[memo.id]?.approvers ?? [];
          extraRows.forEach((r) => {
            if (r.statusCode !== "waiting" && (r.actedAt || r.since)) {
              const time = new Date(r.actedAt ?? r.since ?? 0).getTime();
              if (time > latestTime) latestTime = time;
            }
          });
          
          return latestTime;
        };

        const timeA = getLatestActionTime(a);
        const timeB = getLatestActionTime(b);
        return timeB - timeA; // Descending order (latest first)
      });
    }

    // กรอง: memo ที่ approver คนนี้อยู่ในไลน์ (main หรือ extra) — ไม่จำกัด status
    if (approverFilter !== "All") {
      const selectedId = approverFilter as number;

      filtered = filtered.filter((m) => {
        const mainRows = approverMap[m.id];
        if (mainRows?.some((r) => r.userId === selectedId)) return true;

        const extraRows = extraMap[m.id]?.approvers;
        if (extraRows?.some((r) => r.userId === selectedId)) return true;

        return false;
      });
    }

    // 🔽 ใหม่: กรอง BU
    if (buFilter !== "All") {
      filtered = filtered.filter((m) => m.businessUnit?.id === buFilter);
    }
    // 🔽 ใหม่: กรอง Department
    if (deptFilter !== "All") {
      filtered = filtered.filter((m) => m.department?.id === deptFilter);
    }
    if (view === "MY_APPROVAL" && me) {
      filtered = filtered.filter(
        (m) =>
          m.status === "Processing" && (isMyTurnMain(m) || isMyTurnExtra(m))
      );
    } else if (view === "MY_CREATED" && me) {
      filtered = filtered.filter((m) => m.user?.id === me.id);
    } else if (statusFilter !== "All") {
      filtered = filtered.filter((m) => m.status === statusFilter);
    }
    return filtered;
  }, [
    memos,
    searchTerm,
    statusFilter,
    approverFilter,
    currentApprovers,
    buFilter,
    deptFilter,
    approverMap,
    extraMap,
    colFilters,
    sortState,
    onlyMyApproval,
    onlyMyCreated,
    view, // ✅ เพิ่ม view
    me,
    t, // ✅ เพิ่ม t
    myCCMemos, // ✅ เพิ่ม myCCMemos
    myCCMemoIds, // ✅ เพิ่ม myCCMemoIds สำหรับ CC Status column
    memosCCData, // ✅ เพิ่ม memosCCData สำหรับ CC filter
    sortByLatestAction, // ✅
  ]);
  // --- Pagination states & helpers (place BEFORE any early return) ---
  type PageSize = number | "All";

  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [page, setPage] = useState(1);

  // ─── Server-side search hook (Phase 2) ────────────────────────────
  // Active only when USE_NEW_SEARCH=true. Replaces /api/memos + bulk
  // endpoints with a single /api/memos/search call.
  const newSearchRequest = useMemo(() => {
    if (!USE_NEW_SEARCH) {
      return {} as ReturnType<typeof colFiltersToSearchRequest>;
    }
    return colFiltersToSearchRequest({
      colFilters: colFilters as Record<SearchColKey, typeof colFilters[keyof typeof colFilters]>,
      sortState: sortState as { key: SearchColKey; dir: "asc" | "desc" } | null,
      page,
      pageSize: pageSize === "All" ? "all" : pageSize,
      searchText: searchTerm,
      view: view as "ALL" | "MY_APPROVAL" | "MY_CREATED",
      businessUnitId: buFilter,
      departmentId: deptFilter,
      status: statusFilter,
      includeStatCounts: false,
      includeFacets: !searchMetaLoadedRef.current.facets,
    });
  }, [
    colFilters,
    sortState,
    page,
    pageSize,
    searchTerm,
    view,
    buFilter,
    deptFilter,
    statusFilter,
  ]);

  const newSearch = useMemoSearch({
    request: newSearchRequest,
    enabled: USE_NEW_SEARCH,
    debounceMs: 350,
  });

  const newSearchRefetchRef = useRef(newSearch.refetch);
  useEffect(() => {
    newSearchRefetchRef.current = newSearch.refetch;
  }, [newSearch.refetch]);

  const reloadServerStatCounts = useCallback(
    (opts: {
      forceRefresh?: boolean;
      showLoading?: boolean;
      signal?: AbortSignal;
    } = {}) => {
      const { forceRefresh = false, showLoading = true, signal } = opts;
      if (showLoading) setServerStatCountsLoading(true);

      return searchMemoStats(signal, { forceRefresh })
        .then((counts) => {
          if (signal?.aborted) return;
          setServerStatCounts(counts);
          saveStatCountsToStorage(counts);
          searchMetaLoadedRef.current.statCounts = true;
        })
        .catch((err) => {
          if (signal?.aborted || isAbortError(err)) return;
          console.error("[Dashboard] failed to load memo statCounts:", err);
        })
        .finally(() => {
          if (!signal?.aborted && showLoading) {
            setServerStatCountsLoading(false);
          }
        });
    },
    []
  );

  useEffect(() => {
    if (!USE_NEW_SEARCH || searchMetaLoadedRef.current.statCounts) return;

    const controller = new AbortController();
    void reloadServerStatCounts({ signal: controller.signal });

    return () => {
      controller.abort();
    };
  }, [reloadServerStatCounts]);

  useEffect(() => {
    if (!USE_NEW_SEARCH) return;

    let refreshTimer: number | undefined;
    let pendingHiddenRefresh = false;

    const refreshDashboard = () => {
      pendingHiddenRefresh = false;
      void reloadServerStatCounts({
        forceRefresh: true,
        showLoading: false,
      });
      newSearchRefetchRef.current();
    };

    const scheduleRefresh = (delayMs: number) => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(refreshDashboard, delayMs);
    };

    const unsubscribe = subscribeMemoDashboardRefresh(() => {
      if (document.hidden) {
        pendingHiddenRefresh = true;
        return;
      }

      scheduleRefresh(2000);
    });

    const onVisibilityChange = () => {
      if (!document.hidden && pendingHiddenRefresh) {
        scheduleRefresh(250);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onVisibilityChange);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [reloadServerStatCounts]);

  const searchResultsLoading =
    USE_NEW_SEARCH && !newSearch.error && newSearch.isFetching;
  const statCardsLoading =
    USE_NEW_SEARCH &&
    !newSearch.error &&
    !serverStatCounts &&
    (serverStatCountsLoading || !newSearch.data || searchResultsLoading);

  const renderStatCount = (value: number) =>
    statCardsLoading ? (
      <span
        className="inline-block h-8 w-20 animate-pulse rounded-md bg-gray-200 align-middle"
        aria-label={t("loading")}
      >
        <span className="sr-only">{t("loading")}</span>
      </span>
    ) : (
      value.toLocaleString()
    );

  // Adapter: populate legacy state from hook data so existing render code
  // (filter chain, dropdown options, etc.) continues to work unchanged.
  useEffect(() => {
    if (!USE_NEW_SEARCH || !newSearch.data) return;

    const items = newSearch.data.items.map((m) => ({
      ...m,
      latestComment: m.latestComment
        ? {
            ...m.latestComment,
            attachments: (m.latestComment.attachments ?? []).map((a) => ({
              ...a,
              url: toSecureUploadUrl(a.url),
            })),
          }
        : null,
    }));
    setMemos(items as unknown as Memo[]);

    const nextApproverMap: Record<number, ApproverStatus[]> = {};
    const nextExtraMap: Record<number, ExtraSummary | null> = {};
    const nextCCData: Record<
      number,
      Array<{ id: number; name: string; lastname?: string; nickname?: string }>
    > = {};

    for (const it of items) {
      nextApproverMap[it.id] = (it.approverStatus ?? []).map((r) => ({
        userId: r.userId,
        name: r.name,
        level: r.level,
        statusCode: r.statusCode as ApproverStatus["statusCode"],
        actedAt: r.actedAt ?? undefined,
        since: r.since ?? "",
      }));

      nextExtraMap[it.id] = it.extraApproval
        ? ({
            id: it.extraApproval.id,
            status: it.extraApproval.status,
            approvers: it.extraApproval.approvers.map((a) => ({
              id: a.id,
              userId: a.user.id,
              name:
                [a.user.name, a.user.lastname]
                  .filter(Boolean)
                  .join(" ") || `User#${a.user.id}`,
              statusCode: (a.actedAt
                ? a.status?.name?.toLowerCase() ?? "approved"
                : "waiting") as string,
              actedAt: a.actedAt ?? undefined,
              since: a.actedAt ?? null,
              order: undefined as number | undefined,
            })),
          } as unknown as ExtraSummary)
        : null;

      nextCCData[it.id] = (it.ccUsers ?? []).map((u) => ({
        id: u.id,
        name: u.name,
        lastname: u.lastname ?? undefined,
        nickname: u.nickname ?? undefined,
      }));
    }

    setApproverMap(nextApproverMap);
    setExtraMap(nextExtraMap);
    setMemosCCData(nextCCData);
    setServerTotal(newSearch.data.total);
    setServerTotalPages(newSearch.data.totalPages);
    if (newSearch.data.statCounts) {
      setServerStatCounts(newSearch.data.statCounts);
      searchMetaLoadedRef.current.statCounts = true;
    }
    if (newSearch.data.facets) {
      setServerFacets(newSearch.data.facets);
      searchMetaLoadedRef.current.facets = true;
    }
    setLoading(false);
  }, [newSearch.data]);

  // Pagination metadata: server-side when flag on, client-side otherwise.
  const totalRows = USE_NEW_SEARCH ? serverTotal : visibleMemos.length;
  const pageSizeNum = pageSize === "All" ? totalRows || 1 : pageSize;
  const totalPages = USE_NEW_SEARCH
    ? serverTotalPages
    : pageSize === "All"
      ? 1
      : Math.max(1, Math.ceil(totalRows / pageSizeNum));

  useEffect(() => {
    // reset to page 1 when filters/results change (skip when flag-on:
    // server-side search resets via different signal — see below)
    if (USE_NEW_SEARCH) return;
    setPage(1);
  }, [visibleMemos, pageSize]);

  // Flag-on: reset page 1 when filter inputs change
  useEffect(() => {
    if (!USE_NEW_SEARCH) return;
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    searchTerm,
    statusFilter,
    buFilter,
    deptFilter,
    view,
    sortState,
    colFilters,
    pageSize,
  ]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages || 1);
  }, [totalPages, page]);

  // ⬇️ Define the missing pagedMemos
  const start = pageSize === "All" ? 0 : (page - 1) * pageSizeNum;
  const end = pageSize === "All" ? totalRows : start + pageSizeNum;
  const pagedMemos = useMemo(
    () =>
      USE_NEW_SEARCH
        // Server already paginated — return all current items
        ? visibleMemos
        : visibleMemos.slice(start, end),
    [visibleMemos, start, end]
  );
  const showTableSkeleton = searchResultsLoading && pagedMemos.length === 0;
  const tableColumnCount =
    1 + Object.values(visibleColumns).filter(Boolean).length;
  const tableSkeletonRowCount =
    pageSize === "All" ? 8 : Math.min(Math.max(pageSizeNum, 1), 8);

  const PageSizePicker: React.FC<{
    total: number;
    value: PageSize; // number | "All"
    onChange: (v: PageSize) => void;
  }> = ({ total, value, onChange }) => {
    // แสดงตัวเลือกคงที่ 10 → 100 ทีละ 10 + "ทั้งหมด"
    const options = React.useMemo(() => {
      const arr: number[] = [];
      for (let n = 10; n <= 100; n += 10) arr.push(n);
      return arr;
    }, []);

    return (
      <label className="inline-flex items-center gap-2 text-sm text-gray-700">
        {pageSize !== "All" && (
          <>
            <span className="text-sm text-gray-600">
              <span>{t("pager.pageOf", { page, totalPages })}</span>
            </span>
            <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden"></div>
          </>
        )}
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-gray-50  rounded-md border border-gray-300 shadow-sm"
          title={t("pager.titlePrev")}
          aria-label={t("pager.prev")}
        >
          ‹
        </button>
        <select
          aria-label={t("pager.ariaPerPage")}
          value={value === "All" ? "All" : String(value)}
          onChange={(e) =>
            onChange(e.target.value === "All" ? "All" : Number(e.target.value))
          }
          className="rounded-md border border-gray-300 bg-white px-2 py-1 shadow-sm
                   focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-center"
        >
          {options.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          <option value="All">{t("pager.all")}</option>
        </select>

        <button
          type="button"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className="px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-gray-50  rounded-md border border-gray-300 shadow-sm"
          title={t("pager.titleNext")}
          aria-label={t("pager.next")}
        >
          ›
        </button>
      </label>
    );
  };

  function useTimeAgo() {
    const { t, i18n } = useTranslation("dashboard");

    return function timeAgo(fromISO?: string | null) {
      if (!fromISO) return "-";
      const then = new Date(fromISO).getTime();
      if (isNaN(then)) return "-";

      const now = Date.now();
      const diff = now - then; // >0 = อดีต, <0 = อนาคต
      const abs = Math.abs(diff);

      const MIN = 60 * 1000;
      const H = 60 * MIN;
      const D = 24 * H;
      const W = 7 * D;
      const M = 30 * D; // ≈ เดือน
      const Y = 365 * D; // ≈ ปี

      if (abs < 45 * 1000) {
        return diff >= 0 ? t("timeago.nowPast") : t("timeago.nowFuture");
      }

      const table: Array<[number, keyof UnitsKey]> = [
        [Y, "year"],
        [M, "month"],
        [W, "week"],
        [D, "day"],
        [H, "hour"],
        [MIN, "minute"],
      ];

      type UnitsKey = {
        year: string;
        month: string;
        week: string;
        day: string;
        hour: string;
        minute: string;
        second: string;
      };

      for (const [ms, key] of table) {
        if (abs >= ms) {
          const n = Math.floor(abs / ms);
          const unit = t(`timeago.units.${key}`);
          return compose(n, unit, diff >= 0, t, i18n.language);
        }
      }

      // วินาที
      const n = Math.floor(abs / 1000);
      const unit = t("timeago.units.second");
      return compose(n, unit, diff >= 0, t, i18n.language);
    };
  }
  // ⬅️ ADD: หาค่า current level ของไลน์หลักจาก approverMap
  function getCurrentMainLevel(memo: Memo): number {
    const rows = approverMap[memo.id] || [];
    const getTime = (r: ApproverStatus) =>
      new Date(r.actedAt ?? r.since ?? 0).getTime();

    const terminated = rows.filter((r) => r.statusCode === "terminated");
    if (terminated.length) {
      return terminated.reduce((best, r) =>
        getTime(r) > getTime(best) ? r : best
      ).level;
    }
    const rejected = rows.filter((r) => r.statusCode === "rejected");
    if (rejected.length) {
      return rejected.reduce((best, r) =>
        getTime(r) > getTime(best) ? r : best
      ).level;
    }
    const waiting = rows.filter((r) => r.statusCode === "waiting");
    if (waiting.length) {
      return Math.min(...waiting.map((r) => r.level));
    }
    const approved = rows.filter((r) => r.statusCode === "approved");
    if (approved.length) {
      return Math.max(...approved.map((r) => r.level));
    }
    return memo.currentApprover?.level ?? 0;
  }

  // ⬅️ ADD: ถึงคิวเราบนไลน์หลักไหม
  function isMyTurnMain(memo: Memo): boolean {
    if (USE_NEW_SEARCH && typeof memo.isMyTurnMain === "boolean") {
      return memo.isMyTurnMain;
    }
    if (!me) return false;
    const rows = approverMap[memo.id] || [];
    if (!rows.length) return false;
    const cur = getCurrentMainLevel(memo);
    return rows.some(
      (r) => r.userId === me.id && r.statusCode === "waiting" && r.level === cur
    );
  }

  // ⬅️ ADD: หา index ของ “current” ใน extra (ตามลอจิกที่ใช้ render)
  function getCurrentExtraIndex(memoId: number): number {
    const rows = extraMap[memoId]?.approvers ?? [];
    if (!rows.length) return -1;

    const getTime = (r: ExtraApproverRow) =>
      new Date(r.actedAt ?? r.since ?? 0).getTime();
    const latestByTime = (arr: ExtraApproverRow[]) =>
      arr.reduce<ExtraApproverRow | undefined>(
        (best, cur) => (!best || getTime(cur) > getTime(best) ? cur : best),
        undefined
      )!;

    const terminated = rows.filter((r) => r.statusCode === "terminated");
    if (terminated.length) return rows.indexOf(latestByTime(terminated));

    const rejected = rows.filter((r) => r.statusCode === "rejected");
    if (rejected.length) return rows.indexOf(latestByTime(rejected));

    const waiting = rows
      .filter((r) => r.statusCode === "waiting")
      .sort(
        (a, b) =>
          (a.order ?? 9_999) - (b.order ?? 9_999) || getTime(a) - getTime(b)
      );

    if (waiting.length) return rows.indexOf(waiting[0]);

    const approved = rows.filter((r) => r.statusCode === "approved");
    if (approved.length) return rows.indexOf(latestByTime(approved));

    return -1;
  }

  // ⬅️ ADD: ถึงคิวเราบน extra ไหม
  function isMyTurnExtra(memo: Memo): boolean {
    if (USE_NEW_SEARCH && typeof memo.isMyTurnExtra === "boolean") {
      return memo.isMyTurnExtra;
    }
    if (!me) return false;
    const rows = extraMap[memo.id]?.approvers ?? [];
    if (!rows.length) return false;
    const idx = getCurrentExtraIndex(memo.id);
    if (idx < 0) return false;
    const row = rows[idx];
    return row.statusCode === "waiting" && row.userId === me.id;
  }

  // รับ t จาก useTranslation("dashboard")
  function buildLatestCommentSummary(
    lc?: Memo["latestComment"],
    t?: (k: string) => string
  ) {
    if (!lc) return { text: "", tooltip: "", isAuto: false };

    const atts = lc.attachments ?? [];
    const raw = (lc.snippet ?? lc.comment ?? "").trim();

    // มีข้อความจริง → ใช้ข้อความนั้น
    if (raw) {
      return { text: raw, tooltip: raw, isAuto: false };
    }

    // ไม่มีข้อความ แต่มีไฟล์แนบ → สร้างข้อความอัตโนมัติ (ดึงจาก i18n)
    if (atts.length > 0) {
      const hasImages = atts.some((a) => a.isImage);
      const hasNonImages = atts.some((a) => !a.isImage);

      const msg =
        hasImages && hasNonImages
          ? t
            ? t("latestComment.autoBoth")
            : "sent photos and files"
          : hasImages
            ? t
              ? t("latestComment.autoImages")
              : "sent photos"
            : t
              ? t("latestComment.autoFiles")
              : "sent files";

      return {
        text: msg,
        tooltip: `${lc.userName} ${msg}`,
        isAuto: true,
      };
    }

    return { text: "", tooltip: "", isAuto: false };
  }

  // ช่วยประกอบประโยคโดยไม่ใช้ตัวแปรใน JSON
  function compose(
    n: number,
    unit: string,
    isPast: boolean,
    t: any,
    lang: string
  ) {
    // อังกฤษใส่ s แบบง่าย ๆ (ถ้าอยากทำกฎพหูพจน์ละเอียดค่อยเพิ่ม)
    const unitStr = lang.startsWith("en") && n !== 1 ? `${unit}s` : unit;

    if (lang.startsWith("en")) {
      // en: "X units ago" หรือ "in X units"
      return isPast
        ? `${n} ${unitStr} ago`
        : `${t("timeago.futurePrefix")}${n} ${unitStr}`;
    } else {
      // th: "ผ่านมาแล้ว X หน่วย" หรือ "อีก X หน่วย"
      const prefix = isPast
        ? t("timeago.pastPrefix")
        : t("timeago.futurePrefix");
      return `${prefix}${n} ${unitStr}`;
    }
  }

  async function toggleApproverList(memoId: number) {
    setExpanded((prev) => ({ ...prev, [memoId]: !prev[memoId] }));
    if (!approverMap[memoId]) {
      try {
        const { data } = await axios.get<ApproverStatus[]>(
          `/api/memos/${memoId}/approver-status`,
          { withCredentials: true }
        );
        // เรียงตาม level แล้วตามชื่อ
        const sorted = [...data].sort(
          (a, b) => a.level - b.level || a.name.localeCompare(b.name)
        );
        setApproverMap((prev) => ({ ...prev, [memoId]: sorted }));
      } catch (e) {
        console.error("fetch approver-status failed", e);
      }
    }
  }

  const MiniStatus: React.FC<{
    code: "waiting" | "approved" | "rejected" | "terminated" | "not_required";
  }> = ({ code }) => {
    let cls = "";
    let label = "";
    if (code === "approved") {
      cls = "bg-green-100 text-green-700 border-green-200";
      label = "Approved";
    } else if (code === "not_required") {
      cls = "bg-green-50 text-green-700 border-green-200";
      label = t("statusByUser.not_required", "Level approved");
    } else if (code === "rejected") {
      cls = "bg-orange-100 text-orange-700 border-orange-200";
      label = "Rejected";
    } else if (code === "terminated") {
      cls = "bg-red-100 text-red-700 border-red-200";
      label = "Terminated";
    } else {
      cls = "bg-gray-200 text-gray-700 border-gray-200";
      label = "Waiting";
    }
    return (
      <span
        className={`inline-block text-xs px-2 py-0.5 rounded-full border ${cls}`}
      >
        {label}
      </span>
    );
  };

  // แคชผลเรียก API ต่อ memoId

  const StatusBadge: React.FC<{ status: Status }> = ({ status }) => {
    const baseClass =
      "inline-block px-3 py-1 text-sm font-semibold rounded-full";
    const colorMap: Record<Status, string> = {
      Draft: "bg-gray-100 text-gray-800",
      Published: "bg-yellow-100 text-yellow-800",
      Approved: "bg-green-100 text-green-800",
      Rejected: "bg-orange-100 text-orange-800",
      Terminated: "bg-red-900 text-gray-100",
      Processing: "bg-yellow-100 text-yellow-700",
      Recalled: "bg-sky-100    text-sky-700",
      Expired: "bg-purple-100 text-purple-800",
    };
    const colorClass = colorMap[status] ?? "bg-gray-100 text-gray-800";

    return <span className={`${baseClass} ${colorClass}`}>{status}</span>;
  };



  const STATUS_ORDER: Status[] = [
    "Draft",
    "Processing",
    "Approved",
    "Rejected",
    "Terminated",
    "Recalled",
    "Published",
    "Expired",
  ];
  const PROGRESS_COLORS: Record<string, { fill: string }> = {
    Draft: { fill: "bg-gray-500" },
    Processing: { fill: "bg-yellow-500" },
    Approved: { fill: "bg-green-600" },
    Rejected: { fill: "bg-orange-400" },
    Terminated: { fill: "bg-red-900" },
    Recalled: { fill: "bg-sky-600" },
    Published: { fill: "bg-indigo-600" },
    Expired: { fill: "bg-purple-600" },
    // ค่านี้จะถูกใช้เมื่อไม่มี/ไม่ตรงกับสถานะ: น้ำเงินล้วนตามที่ขอ
    default: { fill: "bg-blue-600" },

  };




  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <HashLoader color="#183e33" size={60} />
        {/* <img src="/img/Image.png" alt="Logo" className="w-[500px] animate-spin" /> */}
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 min-h-screen">
      <div className="mx-auto w-full max-w-none">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 sm:mb-6 gap-3 sm:gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">
              {t("title")}
            </h1>
            <p className="text-gray-600 text-sm sm:text-base">
              {t("subtitle")}
            </p>
          </div>
        </div>

        {/* Stats Bar - Optimized Responsive Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-8 gap-3 sm:gap-4 mb-6">
          {/* ——— Total Approvals (ย้ายมาไว้หน้า) ——— */}
          {totalCfg && (
            <button
              type="button"
              onClick={() => setView("ALL")}
              aria-pressed={view === "ALL"}
              className={[
                "relative overflow-hidden bg-white p-4 rounded-lg shadow border-l-4",
                "transform transition-all duration-300 cursor-pointer",
                totalCfg.borderClass,
                view === "ALL" ? "scale-[1.05]" : "",
              ].join(" ")}
              title={t(totalCfg.labelKey)}
            >
              <span
                className={[
                  "absolute inset-0 origin-left transition-transform duration-300 ease-out opacity-25",
                  totalCfg.bgFlashClass,
                  view === "ALL" ? "scale-x-100" : "scale-x-0",
                ].join(" ")}
              />
              <div className="relative z-10">
                <h3 className="text-sm font-medium text-gray-500 mb-1">
                  {t(totalCfg.labelKey)}
                </h3>
                <p
                  className="text-2xl font-bold text-gray-800"
                  aria-busy={statCardsLoading}
                  aria-live="polite"
                >
                  {renderStatCount(
                    statusCounts[totalCfg.key as keyof typeof statusCounts]
                  )}
                </p>
              </div>
            </button>
          )}

          {/* ——— Approval Request (คงโค้ดเดิม) ——— */}
          <button
            type="button"
            onClick={() =>
              setView((v) => (v === "MY_APPROVAL" ? "ALL" : "MY_APPROVAL"))
            }
            disabled={!me}
            aria-pressed={onlyMyApproval}
            className={[
              "relative overflow-hidden bg-white p-4 rounded-lg shadow border-l-4",
              "transform transition-all duration-300 cursor-pointer",
              "border-indigo-500",
              onlyMyApproval ? "scale-[1.05]" : "",
            ].join(" ")}
            title={t("stats.approvalRequest") || "Approval Request"}
          >
            <span
              className={[
                "absolute inset-0 origin-left transition-transform duration-300 ease-out opacity-25",
                "bg-indigo-500",
                onlyMyApproval ? "scale-x-100" : "scale-x-0",
              ].join(" ")}
            />
            <div className="relative z-10">
              <h3 className="text-sm font-medium text-gray-500 mb-1">
                {t("stats.approvalRequest") || "Approval Request"}
              </h3>
              <p
                className="text-2xl font-bold text-gray-800"
                aria-busy={statCardsLoading}
                aria-live="polite"
              >
                {renderStatCount(approvalRequestCount)}
              </p>
            </div>
          </button>

          {/* ——— My Created Memos ——— */}
          <button
            type="button"
            onClick={() =>
              setView((v) => (v === "MY_CREATED" ? "ALL" : "MY_CREATED"))
            }
            disabled={!me}
            aria-pressed={onlyMyCreated}
            className={[
              "relative overflow-hidden bg-white p-4 rounded-lg shadow border-l-4",
              "transform transition-all duration-300 cursor-pointer",
              "border-purple-500",
              onlyMyCreated ? "scale-[1.05]" : "",
            ].join(" ")}
            title={t("stats.myCreatedMemos") || "My Created Memos"}
          >
            <span
              className={[
                "absolute inset-0 origin-left transition-transform duration-300 ease-out opacity-25",
                "bg-purple-500",
                onlyMyCreated ? "scale-x-100" : "scale-x-0",
              ].join(" ")}
            />
            <div className="relative z-10">
              <h3 className="text-sm font-medium text-gray-500 mb-1">
                {t("stats.myCreatedMemos") || "My Created Memos"}
              </h3>
              <p
                className="text-2xl font-bold text-gray-800"
                aria-busy={statCardsLoading}
                aria-live="polite"
              >
                {renderStatCount(myCreatedMemosCount)}
              </p>
            </div>
          </button>

          {/* ——— การ์ดสถานะที่เหลือ ——— */}
          {otherCfgs.map((config) => {
            const isActive = view === (`STATUS:${config.status}` as View);
            return (
              <button
                key={config.key}
                type="button"
                onClick={() => {
                  const targetView = `STATUS:${config.status}` as View;
                  setView((prev) => prev === targetView ? "ALL" : targetView);
                }}
                aria-pressed={isActive}
                className={[
                  "relative overflow-hidden bg-white p-4 rounded-lg shadow border-l-4",
                  "transform transition-all duration-300 cursor-pointer",
                  config.borderClass,
                  isActive ? "scale-[1.05]" : "",
                ].join(" ")}
                title={t(config.labelKey)}
              >
                <span
                  className={[
                    "absolute inset-0 origin-left transition-transform duration-300 ease-out opacity-25",
                    config.bgFlashClass,
                    isActive ? "scale-x-100" : "scale-x-0",
                  ].join(" ")}
                />
                <div className="relative z-10">
                  <h3 className="text-sm font-medium text-gray-500 mb-1">
                    {t(config.labelKey)}
                  </h3>
                  <p
                    className="text-2xl font-bold text-gray-800"
                    aria-busy={statCardsLoading}
                    aria-live="polite"
                  >
                    {renderStatCount(
                      statusCounts[config.key as keyof typeof statusCounts]
                    )}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Active Filters Indicator */}
        {hasActiveFilters && (
          <div className="-mx-4 sm:mx-0 mb-4 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <div className="px-4 sm:px-0 inline-flex items-center gap-2">
              <span className="text-sm text-gray-600 font-medium">
                {t("activeFilters")}:
              </span>
              {statusFilter !== "All" && (
                <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm">
                  {t("stats." + statusFilter.toLowerCase())}
                </span>
              )}
              {approverFilter !== "All" && (
                <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm">
                  {(() => {
                    const a = filterMenuApprovers.find(
                      (x) => x.id === approverFilter
                    );
                    return a ? getApproverLabel(a) : "";
                  })()}
                </span>
              )}

              {buFilter !== "All" && (
                <span className="px-3 py-1 bg-teal-100 text-teal-800 rounded-full text-sm">
                  {businessUnits.find((b) => b.id === buFilter)?.name}
                </span>
              )}

              {deptFilter !== "All" && (
                <span className="px-3 py-1 bg-amber-100 text-amber-800 rounded-full text-sm">
                  {getDeptName(deptFilter, buFilter)}
                </span>
              )}

              {searchTerm && (
                <span className="px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-sm">
                  "{searchTerm}"
                </span>
              )}
              {onlyMyApproval && (
                <span className="px-3 py-1 bg-indigo-100 text-indigo-800 rounded-full text-sm">
                  {t("stats.approvalRequest")}
                </span>
              )}
              {onlyMyCreated && (
                <span className="px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-sm">
                  {t("stats.myCreatedMemos")}
                </span>
              )}
              {sortByLatestAction && (
                <span className="px-3 py-1 bg-gray-100 text-gray-800 rounded-full text-sm">
                  {t("filters.sortByLatestAction", "Latest Action")}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Search, Filter and Pagination Controls */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 px-3 py-3 bg-white rounded-lg mb-4">
          {/* Left side: Search and Filters */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 flex-1">
            {/* Search box */}
            <div className="relative w-full sm:w-64">
              <input
                type="text"
                placeholder={t("searchPlaceholder")}
                className="h-10 w-full px-4 pr-10 border rounded-lg border-gray-300 hover:bg-gray-50 bg-white text-gray-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent placeholder-gray-500"
                value={searchTerm}
                onChange={handleSearch}
              />
              <svg
                className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>

            <FilterMenu
              open={filterOpen}
              setOpen={setFilterOpen}
              activeFilterCount={activeFilterCount}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              approverFilter={approverFilter}
              setApproverFilter={setApproverFilter}
              buFilter={buFilter}
              setBuFilter={setBuFilter}
              deptFilter={deptFilter}
              setDeptFilter={setDeptFilter}
              currentApprovers={filterMenuApprovers}
              businessUnits={businessUnits}
              departments={departments}
              memos={memos}
              onClear={resetFilters}
            />

            <ColumnVisibilityToggle
              visibleColumns={visibleColumns}
              onToggle={toggleColumnVisibility}
            />

            <button
              type="button"
              onClick={() => setSortByLatestAction(!sortByLatestAction)}
              className={`h-10 inline-flex items-center gap-2 rounded-lg px-4 border  font-medium transition-colors ${
                sortByLatestAction
                  ? "bg-gray-200 border-gray-300 text-gray-600 shadow-sm"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50 shadow-sm hover:shadow-md"
              }`}
              title={t("filters.sortByLatestAction", "Sort by Latest Action")}
            >
              <FiClock className="w-4 h-4" />
              {t("filters.sortByLatestAction", "Latest Action")}
            </button>

            <button
              type="button"
              onClick={() => resetFilters({ keepMyApproval: false })}
              className={`h-10 inline-flex items-center gap-2 rounded-lg px-4 border font-medium transition-colors ${
                hasActiveFilters
                  ? "bg-red-50 border-red-100 text-red-400 shadow-sm hover:bg-red-100"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50 shadow-sm hover:shadow-md"
              }`}
              title={t("filters.clearAll")}
            >
              <FiX className="w-4 h-4" />
              {t("filters.clearAll")}
            </button>
          </div>

          {/* Right side: Pagination */}
          <div className="flex items-center justify-end">
            <PageSizePicker
              total={visibleMemos.length}
              value={pageSize}
              onChange={setPageSize}
            />
          </div>
        </div>

        {/* 📱 Card layout for mobile/tablet */}
        <div className="space-y-4 md:hidden">
          {pagedMemos.length > 0 ? (
            pagedMemos.map((memo, index) => (
              <div
                key={memo.id}
                onClick={() => navigate(`/memo/${memo.id}`)}
                className="bg-white rounded-lg shadow border p-4 cursor-pointer hover:bg-gray-50 transition"
              >
                {/* หัวการ์ด: เลขลำดับ + เลขเอกสาร + สถานะ */}
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center gap-3">
                    <div className="inline-flex items-center justify-center w-8 h-8 bg-gray-100 text-gray-600 rounded-full text-xs font-medium">
                      {pageSize === "All" ? index + 1 : (page - 1) * pageSizeNum + index + 1}
                    </div>
                    <h2 className="font-semibold text-[#183e33]">
                      {memo.memonumber}
                    </h2>
                  </div>
                  <StatusBadge status={memo.status ?? ""} />
                </div>

                {/* หัวข้อ */}
                <p className="text-sm text-gray-800 truncate">{memo.subject}</p>

                {/* วันหมดอายุเป็นตัวหนังสือธรรมดา */}
                <div className="mt-1 text-xs text-gray-600">
                  {t("table.expires") ?? "Expires"}:{" "}
                  {memo.expiresAt ? fmtExpiry(memo.expiresAt) : "-"}
                </div>

                {/* บรรทัดที่ 3: สถานะวันหมดอายุ + สี + ไอคอน */}
                {(() => {
                  const meta = getSubjectStatusMeta(memo, t); // ✅
                  return (
                    <div
                      className={`mt-1 text-xs flex items-center gap-1 ${meta.cls}`}
                    >
                      {meta.icon}
                      <span>{meta.label}</span>
                    </div>
                  );
                })()}

                {/* ผู้เขียน */}
                <p className="text-sm text-gray-500 mt-1">
                  {t("table.author")}: {memo.user.name}
                </p>

                {(() => {
                  const atts = memo.latestComment?.attachments ?? [];
                  if (atts.length === 0) return null;

                  return atts.slice(0, 3).map((f, i) => {
                    const safeName =
                      f.fileName ?? f.url.split("/").pop() ?? "attachment";
                    return f.isImage ? (
                      <a
                        key={i}
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block"
                        title={safeName}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <img
                          src={f.url}
                          alt={safeName}
                          className="h-12 w-12 object-cover rounded border"
                        />
                      </a>
                    ) : (
                      <a
                        key={i}
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 px-2 py-1 text-xs rounded border hover:bg-gray-50"
                        title={safeName}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <svg
                          className="w-4 h-4"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
                          <path
                            d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                          <path
                            d="M14 2v6h6"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                        </svg>
                        <span className="truncate max-w-[10rem]">
                          {safeName}
                        </span>
                      </a>
                    );
                  });
                })()}

                {/* Current approver สรุป */}
                {memo.currentApprover && (
                  <div className="text-sm text-blue-600 font-medium mt-2">
                    {memo.currentApprover.names.length === 1 ? (
                      <>
                        {t("table.currentApprover")}:{" "}
                        {memo.currentApprover.names[0]} (L
                        {memo.currentApprover.level + 1})
                      </>
                    ) : (
                      <>
                        <div className="mb-1">
                          {t("table.currentApprover")}: L
                          {memo.currentApprover.level + 1} (
                          {memo.currentApprover.names.length} approvers)
                        </div>
                        <div className="ml-2 space-y-1">
                          {memo.currentApprover.names.map((name, idx) => (
                            <div key={idx} className="text-xs">
                              • {name}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Toggle รายชื่อผู้อนุมัติทั้งหมด */}
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleApproverList(memo.id);
                    }}
                    className="text-xs text-gray-600 underline"
                  >
                    {expanded[memo.id] ? t("hide") : t("show")}
                  </button>

                  {expanded[memo.id] && (
                    <div className="mt-2">
                      {approverMap[memo.id] ? (
                        <ol className="space-y-1">
                          {approverMap[memo.id].map((ap, idx) => (
                            <li
                              key={idx}
                              className="flex items-center justify-between gap-2 rounded-md bg-gray-50 px-2 py-1"
                            >
                              <div>
                                <div className="text-sm text-gray-800">
                                  {ap.name}{" "}
                                  <span className="text-xs text-gray-500">
                                    (L{ap.level + 1})
                                  </span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <MiniStatus code={ap.statusCode} />
                                <span className="text-xs text-gray-500">
                                  {timeAgo(ap.actedAt ?? ap.since)}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <div className="text-xs text-gray-400">
                          {t("loading")}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* วันที่สร้าง/อนุมัติล่าสุด */}
                <p className="text-sm text-gray-500 mt-2">
                  {t("table.createdat")}:{" "}
                  {memo.latestApprovedDate
                    ? new Date(memo.latestApprovedDate).toLocaleDateString(
                      "en-GB"
                    )
                    : "-"}
                </p>

                {/* ปุ่มลบ (คงเดิม)
                <div
                  className="mt-3 flex justify-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => deleteMemo(memo.id)}
                    className="text-red-500 hover:text-red-700"
                    title={t("table.delete")}
                  >
                    🗑️
                  </button>
                </div> */}
              </div>
            ))
          ) : (
            <div className="text-center text-gray-500 py-6">
              {searchTerm ? t("empty.noMatch") : t("empty.none")}
            </div>
          )}
        </div>



        {/* 💻 Table layout for desktop */}
        <div className="hidden md:block bg-white rounded-xl shadow-sm border border-white overflow-visible">
          {/* NEW: top-right page size control */}

          <div className="overflow-x-auto">
            {" "}
            <div className="overflow-x-auto">
              <table className="min-w-[900px] w-full  text-sm">
                <thead>
                  <tr className="text-gray-700 bg-gradient-to-r from-emerald-500 to-emerald-600">
                    {/* Order Number Column */}
                    <th className="px-2 py-3 text-center w-16 text-emerald-50">
                      <div className="inline-flex items-center justify-center gap-1">
                        #
                      </div>
                    </th>
                    {/* เลขเอกสาร + ฟิลเตอร์/เรียง */}
                    {visibleColumns.number && (
                      <th className="px-2 py-3 text-center w-32 text-emerald-50">
                        <div className="inline-flex items-center justify-center gap-1">
                          {t("table.number")}
                          <HeaderFilter
                            colKey="memonumber"
                            mode="text"
                            state={colFilters.memonumber}
                            onApply={(next) =>
                              setColFilters((p) => ({ ...p, memonumber: next }))
                            }
                            sortDir={
                              sortState?.key === "memonumber"
                                ? sortState.dir
                                : null
                            }
                            onSort={(dir) =>
                              setSortState(
                                dir ? { key: "memonumber", dir } : null
                              )
                            }
                          />
                        </div>
                      </th>
                    )}
                    {visibleColumns.status && (
                      <th className="px-2 py-3 text-center text-emerald-50">
                        <div className="inline-flex items-center justify-center gap-1">
                          {t("table.status")}
                          <HeaderFilter
                            colKey="status"
                            mode="list"
                            options={statusOptions}
                            state={colFilters.status}
                            onApply={(next) =>
                              setColFilters((p) => ({ ...p, status: next }))
                            }
                            sortDir={
                              sortState?.key === "status" ? sortState.dir : null
                            }
                            onSort={(dir) =>
                              setSortState(dir ? { key: "status", dir } : null)
                            }
                          />
                        </div>
                      </th>
                    )}
                    {/* หัวข้อ + ฟิลเตอร์/เรียง - Updated for wider and 2 lines */}
                    {visibleColumns.subject && (
                      <th className="px-2 py-3 text-center text-emerald-50 min-w-[20rem]">
                        <div className="inline-flex items-center justify-center gap-1">
                          {t("table.subject")}

                          {/* subject — เพิ่ม showExpiry */}
                          <HeaderFilter
                            colKey="subject"
                            mode="text"
                            state={colFilters.subject}
                            onApply={(next) =>
                              setColFilters((p) => ({ ...p, subject: next }))
                            }
                            sortDir={
                              sortState?.key === "subject" ? sortState.dir : null
                            }
                            onSort={(dir) =>
                              setSortState(dir ? { key: "subject", dir } : null)
                            }
                            showExpiry={false}
                          />
                        </div>
                      </th>
                    )}

                    {/* วันหมดอายุ */}
                    {visibleColumns.expires && (
                      <th className="px-2 py-3 text-center text-emerald-50">
                        <div className="inline-flex items-center justify-center gap-1">
                          <div className="leading-tight">{t("table.expires")}</div>
                          <HeaderFilter
                            colKey="expires"
                            mode="date"
                            state={colFilters.expires}
                            onApply={(next) =>
                              setColFilters((p) => ({ ...p, expires: next }))
                            }
                            sortDir={
                              sortState?.key === "expires" ? sortState.dir : null
                            }
                            onSort={(dir) =>
                              setSortState(dir ? { key: "expires", dir } : null)
                            }
                            showExpiry // ✅ ย้ายมาที่นี่
                          />
                        </div>
                      </th>
                    )}

                    {/* ผู้เขียน + ฟิลเตอร์/เรียงแบบลิสต์ */}
                    {visibleColumns.author && (
                      <th className="px-2 py-3 text-center text-emerald-50">
                        <div className="inline-flex items-center justify-center gap-1">
                          <div className="leading-tight">{t("table.author")}</div>
                          <HeaderFilter
                            colKey="author"
                            mode="list"
                            options={authorOptions}
                            state={colFilters.author}
                            onApply={(next) =>
                              setColFilters((p) => ({ ...p, author: next }))
                            }
                            sortDir={
                              sortState?.key === "author" ? sortState.dir : null
                            }
                            onSort={(dir) =>
                              setSortState(dir ? { key: "author", dir } : null)
                            }
                          />
                        </div>
                      </th>
                    )}

                    {/* วันที่สร้าง */}
                    {visibleColumns.createdAt && (
                      <th className="px-2 py-3 text-center text-emerald-50">
                        <div className="inline-flex items-center justify-center gap-1">
                          <div className="leading-tight">{t("table.createdAt")}</div>
                          <HeaderFilter
                            colKey="createdAt"
                            mode="date"
                            state={colFilters.createdAt}
                            onApply={(next) =>
                              setColFilters((p) => ({ ...p, createdAt: next }))
                            }
                            sortDir={
                              sortState?.key === "createdAt" ? sortState.dir : null
                            }
                            onSort={(dir) =>
                              setSortState(dir ? { key: "createdAt", dir } : null)
                            }
                          />
                        </div>
                      </th>
                    )}

                    {/* Current Approver + ฟิลเตอร์/เรียง */}
                    {visibleColumns.currentApprover && (
                      <th className="px-2 py-3 text-center text-emerald-50">
                        <div className="inline-flex items-center justify-center gap-1">
                          {t("table.currentApprover")}
                          <HeaderFilter
                            colKey="current"
                            mode="list"
                            options={currentApproverOptions} // ⬅️ เพิ่ม
                            state={colFilters.current}
                            onApply={(next) =>
                              setColFilters((p) => ({ ...p, current: next }))
                            }
                            sortDir={
                              sortState?.key === "current" ? sortState.dir : null
                            }
                            onSort={(dir) =>
                              setSortState(dir ? { key: "current", dir } : null)
                            }
                          />
                        </div>
                      </th>
                    )}

                    {/* Extra Approver + ฟิลเตอร์/เรียง */}
                    {visibleColumns.extraApprover && (
                      <th className="px-2 py-3 text-center text-emerald-50">
                        <div className="inline-flex items-center justify-center gap-1">
                          {t("table.extraApprover")}
                          <HeaderFilter
                            colKey="extra"
                            mode="list"
                            options={extraApproverOptions} // ⬅️ เพิ่ม
                            state={colFilters.extra}
                            onApply={(next) =>
                              setColFilters((p) => ({ ...p, extra: next }))
                            }
                            sortDir={
                              sortState?.key === "extra" ? sortState.dir : null
                            }
                            onSort={(dir) =>
                              setSortState(dir ? { key: "extra", dir } : null)
                            }
                          />
                        </div>
                      </th>
                    )}

                    {/* Latest Comment + ฟิลเตอร์/เรียง */}
                    {visibleColumns.latestComment && (
                      <th className="px-2 py-3 text-center text-emerald-50 w-48">
                        <div className="inline-flex items-center justify-center gap-1">
                          {t("table.latestComment")}
                          <HeaderFilter
                            colKey="latest"
                            mode="text"
                            state={colFilters.latest}
                            onApply={(next) =>
                              setColFilters((p) => ({ ...p, latest: next }))
                            }
                            sortDir={
                              sortState?.key === "latest" ? sortState.dir : null
                            }
                            onSort={(dir) =>
                              setSortState(dir ? { key: "latest", dir } : null)
                            }
                            side="left"
                          />
                        </div>
                      </th>
                    )}

                    {/* CC Status + ฟิลเตอร์เท่านั้น (ไม่มี sort) */}
                    {visibleColumns.ccStatus && (
                      <th className="px-2 py-3 text-center text-emerald-50">
                        <div className="inline-flex items-center justify-center gap-1">
                          {t("table.ccStatus")}
                          <HeaderFilter
                            colKey="ccStatus"
                            mode="list"
                            options={ccStatusOptions}
                            state={colFilters.ccStatus}
                            onApply={(next) =>
                              setColFilters((p) => ({ ...p, ccStatus: next }))
                            }
                            sortDir={null}
                            onSort={() => { }}
                            side="left"
                            hideSort={true}
                          />
                        </div>
                      </th>
                    )}

                    {/* สถานะ + ฟิลเตอร์/เรียงแบบลิสต์ */}
                  </tr>
                </thead>

                <tbody
                  className="
  bg-white divide-y divide-gray-200
  [&>tr>td]:!align-top
  [&>tr>td]:!text-left
"
                >
                  {searchResultsLoading && pagedMemos.length > 0 && (
                    <tr className="bg-emerald-50/80">
                      <td
                        colSpan={tableColumnCount}
                        className="px-3 py-2 !align-middle !text-left"
                      >
                        <div
                          className="flex items-center gap-2 text-xs font-medium text-emerald-700"
                          role="status"
                          aria-live="polite"
                        >
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" />
                          <span>{t("loading")}</span>
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-emerald-100">
                            <span className="block h-full w-1/3 animate-pulse rounded-full bg-emerald-500" />
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                  {showTableSkeleton ? (
                    Array.from({ length: tableSkeletonRowCount }).map((_, rowIndex) => (
                      <tr
                        key={`memo-search-skeleton-${rowIndex}`}
                        className="animate-pulse"
                      >
                        <td className="px-2 py-3">
                          <div className="h-8 w-8 rounded-full bg-gray-200" />
                        </td>
                        {visibleColumns.number && (
                          <td className="px-2 py-3">
                            <div className="h-4 w-28 rounded bg-gray-200" />
                          </td>
                        )}
                        {visibleColumns.status && (
                          <td className="px-2 py-3">
                            <div className="h-7 w-24 rounded-full bg-gray-200" />
                            <div className="mt-2 h-3 w-20 rounded-full bg-gray-100" />
                          </td>
                        )}
                        {visibleColumns.subject && (
                          <td className="px-2 py-3 min-w-[20rem]">
                            <div className="h-4 w-11/12 rounded bg-gray-200" />
                            <div className="mt-2 h-4 w-8/12 rounded bg-gray-100" />
                          </td>
                        )}
                        {visibleColumns.expires && (
                          <td className="px-2 py-3">
                            <div className="h-4 w-20 rounded bg-gray-200" />
                            <div className="mt-2 h-3 w-14 rounded bg-gray-100" />
                          </td>
                        )}
                        {visibleColumns.author && (
                          <td className="px-2 py-3">
                            <div className="h-4 w-32 rounded bg-gray-200" />
                            <div className="mt-2 h-3 w-20 rounded bg-gray-100" />
                          </td>
                        )}
                        {visibleColumns.createdAt && (
                          <td className="px-2 py-3">
                            <div className="h-4 w-20 rounded bg-gray-200" />
                            <div className="mt-2 h-3 w-14 rounded bg-gray-100" />
                          </td>
                        )}
                        {visibleColumns.currentApprover && (
                          <td className="px-2 py-3">
                            <div className="h-4 w-36 rounded bg-gray-200" />
                            <div className="mt-2 h-3 w-28 rounded bg-gray-100" />
                          </td>
                        )}
                        {visibleColumns.extraApprover && (
                          <td className="px-2 py-3">
                            <div className="h-4 w-36 rounded bg-gray-200" />
                            <div className="mt-2 h-3 w-24 rounded bg-gray-100" />
                          </td>
                        )}
                        {visibleColumns.latestComment && (
                          <td className="px-2 py-3">
                            <div className="h-4 w-40 rounded bg-gray-200" />
                            <div className="mt-2 h-3 w-28 rounded bg-gray-100" />
                          </td>
                        )}
                        {visibleColumns.ccStatus && (
                          <td className="px-2 py-3">
                            <div className="h-4 w-24 rounded bg-gray-200" />
                          </td>
                        )}
                      </tr>
                    ))
                  ) : (
                    pagedMemos.map((memo, index) => (
                    <tr key={memo.id}>
                      {/* Order Number Cell */}
                      <td className="px-2 py-3 text-center align-middle">
                        <div className="inline-flex items-center justify-center w-8 h-8 bg-gray-100 text-gray-600 rounded-full text-xs font-medium">
                          {pageSize === "All" ? index + 1 : (page - 1) * pageSizeNum + index + 1}
                        </div>
                      </td>
                      {visibleColumns.number && (
                        <td className="px-2 py-3 align-top text-left">
                          <a
                            href={`/memo/${memo.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`เปิดรายละเอียดเอกสาร ${memo.memonumber}`}
                            aria-label={`เปิดรายละเอียดเอกสาร ${memo.memonumber}`}
                            className="
      group inline-flex w-full justify-start items-start gap-1
      font-medium text-emerald-700
      hover:text-emerald-800
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-sm
      cursor-pointer
    "
                          >
                            <span>{memo.memonumber}</span>
                            <svg
                              className="w-4 h-4 opacity-80 self-start mt-0.5 transition-transform duration-200 group-hover:translate-x-0.5"
                              viewBox="0 0 24 24"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M9 5l7 7-7 7"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                              />
                            </svg>
                          </a>
                        </td>
                      )}
                      {visibleColumns.status && (
                        <td className="px-2 py-3 text-center !align-middle">
                          <div className="flex justify-center">
                            <StatusWithProgress status={memo.status} memoId={memo.id} />
                          </div>
                        </td>
                      )}
                      {visibleColumns.subject && (
                        <td className="px-2 py-3 text-left text-gray-700 min-w-[20rem]">
                          <div className="font-medium text-gray-800 line-clamp-2 leading-relaxed">
                            {memo.subject}
                          </div>
                        </td>
                      )}

                      {/* วันหมดอายุ */}
                      {visibleColumns.expires && (
                        <td className="px-2 py-3 text-center font-semibold">
                          <div className="leading-tight">
                            {(() => {

                              if (!memo.expiresAt) {
                                return <span className="text-gray-400">-</span>;
                              }

                              const meta = getExpiryMeta(memo.expiresAt, memo.status);


                              return (
                                <>
                                  <div className="text-sm text-gray-700">
                                    {new Date(memo.expiresAt).toLocaleDateString("en-GB", {
                                      day: "2-digit",
                                      month: "2-digit",
                                      year: "numeric",
                                    })}
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    {new Date(memo.expiresAt).toLocaleTimeString("en-GB", {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </div>
                                  {!shouldHideExpiryBadge(memo.status) && (
                                    <div className={`mt-1 text-xs flex items-center justify-center gap-1 ${meta.cls}`}>
                                      {meta.icon}
                                      <span className="truncate">{meta.label}</span>
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </td>
                      )}

                      {visibleColumns.author && (
                        <td className="px-2 py-3 text-center text-gray-700">
                          <div className="leading-tight">
                            <div>
                              {[memo.user.name, memo.user.lastname]
                                .filter(Boolean)
                                .join(" ")}
                              {memo.user.nickname
                                ? ` (${memo.user.nickname})`
                                : ""}
                            </div>
                            {/* <div className="text-xs text-gray-500">
                            {memo.latestApprovedDate
                              ? new Date(
                                  memo.latestApprovedDate
                                ).toLocaleDateString("en-GB")
                              : "-"}
                          </div> */}
                          </div>
                        </td>
                      )}

                      {/* วันที่สร้าง */}
                      {visibleColumns.createdAt && (
                        <td className="px-2 py-3 text-center text-gray-700">
                          <div className="leading-tight">
                            <div className="text-sm">
                              {memo.createdAt
                                ? new Date(memo.createdAt).toLocaleDateString("en-GB", {
                                  day: "2-digit",
                                  month: "2-digit",
                                  year: "numeric",
                                })
                                : "-"}
                            </div>
                            <div className="text-xs text-gray-500">
                              {memo.createdAt
                                ? new Date(memo.createdAt).toLocaleTimeString("en-GB", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                                : ""}
                            </div>
                          </div>
                        </td>
                      )}

                      {visibleColumns.currentApprover && (
                        <td className="px-2 py-3 text-center text-gray-700">
                          {memo.currentApprover ||
                            (approverMap[memo.id]?.length ?? 0) > 0 ? (
                            <div className="text-blue-600 font-medium">
                              <div
                                className="text-left inline-block max-w-[24rem]"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {(() => {
                                  // ✅ กำหนด shape เดียวกันให้ทุกแถว
                                  type Row = {
                                    name: string;
                                    level: number;
                                    statusCode:
                                    | "waiting"
                                    | "approved"
                                    | "rejected"
                                    | "terminated";
                                    actedAt?: string;
                                    since?: string;
                                  };

                                  const rows: Row[] =
                                    (approverMap[memo.id] as Row[]) || [];

                                  const getTime = (r: Row) =>
                                    new Date(r.actedAt ?? r.since ?? 0).getTime();

                                  const waiting = rows.filter(
                                    (r) => r.statusCode === "waiting"
                                  );
                                  const rejected = rows.filter(
                                    (r) => r.statusCode === "rejected"
                                  );
                                  const approved = rows.filter(
                                    (r) => r.statusCode === "approved"
                                  );
                                  const terminated = rows.filter(
                                    (r) => r.statusCode === "terminated"
                                  );

                                  const latestByTime = (arr: Row[]) =>
                                    arr.reduce<Row | undefined>(
                                      (best, cur) =>
                                        !best || getTime(cur) > getTime(best)
                                          ? cur
                                          : best,
                                      undefined
                                    )!;

                                  let currentLevel: number;

                                  // ⬅️ ถ้ามี terminated ให้ถือว่าสิ้นสุดกระบวนการและ “คนที่ยุติ” คือ current
                                  if (terminated.length) {
                                    const lastTerm = latestByTime(terminated);
                                    currentLevel = lastTerm.level;
                                  } else if (rejected.length) {
                                    // ⬇️ ถ้าไม่ terminated ค่อยดู rejected ล่าสุด
                                    const lastRej = latestByTime(rejected);
                                    currentLevel = lastRej.level;
                                  } else if (waiting.length) {
                                    currentLevel = Math.min(
                                      ...waiting.map((r) => r.level)
                                    );
                                  } else if (approved.length) {
                                    currentLevel = Math.max(
                                      ...approved.map((r) => r.level)
                                    );
                                  } else if (rows.length) {
                                    currentLevel = rows[0].level;
                                  } else if (memo.currentApprover) {
                                    currentLevel = memo.currentApprover.level;
                                  } else {
                                    currentLevel = 0;
                                  }

                                  // ถ้าไม่มีทั้ง terminated และ rejected ค่อยยอมให้ memo.currentApprover override
                                  if (
                                    !terminated.length &&
                                    !rejected.length &&
                                    memo.currentApprover
                                  ) {
                                    currentLevel = memo.currentApprover.level;
                                  }

                                  // เลือกแถวที่จะแสดง
                                  const visible: Row[] = (() => {
                                    if (terminated.length) {
                                      // ถ้าถูก Terminated แล้ว: โหมดย่อโชว์เฉพาะผู้ที่ยุติ (ล่าสุด)
                                      return expanded[memo.id]
                                        ? rows
                                        : [latestByTime(terminated)];
                                    }
                                    if (expanded[memo.id]) return rows;
                                    if (rows.length)
                                      return rows.filter(
                                        (r) => r.level === currentLevel
                                      );
                                    if (memo.currentApprover) {
                                      return memo.currentApprover.names.map<Row>(
                                        (n) => ({
                                          name: n,
                                          level: memo.currentApprover!.level,
                                          statusCode: "waiting",
                                          actedAt: undefined,
                                          since: undefined,
                                        })
                                      );
                                    }
                                    return [];
                                  })();

                                  return (
                                    <ol className="space-y-1">
                                      {visible.map((ap, idx) => {
                                        const isCurrentLevel =
                                          ap.level === currentLevel;

                                        // ✅ ยังไม่ถึงคิว = waiting และเลเวลมากกว่า currentLevel (ยกเว้นเมื่อ terminated แล้ว)
                                        const notStartedYet =
                                          ap.statusCode === "waiting" &&
                                          ap.level > currentLevel;

                                        return (
                                          <li
                                            key={idx}
                                            className={[
                                              "rounded-md px-2 py-1",
                                              expanded[memo.id]
                                                ? isCurrentLevel
                                                  ? "bg-emerald-50 ring-1 ring-emerald-200"
                                                  : "bg-gray-50"
                                                : "bg-gray-50",
                                              notStartedYet ? "opacity-60" : "",
                                            ].join(" ")}
                                            title={`L${ap.level + 1}`}
                                          >
                                            <div className="flex items-center justify-between gap-2">
                                              <div className="min-w-0">
                                                <span
                                                  className={[
                                                    "font-semibold truncate",
                                                    notStartedYet
                                                      ? "text-gray-400"
                                                      : "text-gray-900",
                                                  ].join(" ")}
                                                >
                                                  {ap.name}
                                                </span>
                                                <span
                                                  className={[
                                                    "text-sm ml-1",
                                                    notStartedYet
                                                      ? "text-gray-300"
                                                      : "text-gray-500",
                                                  ].join(" ")}
                                                >
                                                  (L{ap.level + 1})
                                                </span>
                                              </div>

                                              {idx === 0 && (
                                                <button
                                                  type="button"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleApproverList(memo.id);
                                                  }}
                                                  className="inline-flex items-center text-black/80 hover:text-black"
                                                >
                                                  <svg
                                                    className={`w-5 h-5 transition-transform ${expanded[memo.id]
                                                      ? "rotate-180"
                                                      : ""
                                                      }`}
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                  >
                                                    <path
                                                      d="M6 9l6 6 6-6"
                                                      stroke="currentColor"
                                                      strokeWidth="2"
                                                      strokeLinecap="round"
                                                    />
                                                  </svg>
                                                </button>
                                              )}
                                            </div>

                                            {/* บรรทัดล่าง: Badge + เวลา */}
                                            <div className="mt-1 flex items-center gap-2 min-w-0 pr-6">
                                              <div className="shrink-0">
                                                <MiniStatus
                                                  code={ap.statusCode}
                                                />
                                              </div>

                                              {notStartedYet ? (
                                                <span className="flex-1 text-xs text-gray-400 italic truncate">
                                                  &nbsp;
                                                </span>
                                              ) : (
                                                <span className="flex-1 text-xs text-gray-700 truncate">
                                                  {timeAgo(
                                                    ap.actedAt ?? ap.since
                                                  )}
                                                </span>
                                              )}
                                            </div>
                                          </li>
                                        );
                                      })}
                                    </ol>
                                  );
                                })()}
                              </div>
                            </div>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                      )}
                      {visibleColumns.extraApprover && (
                        <td className="px-2 py-3 text-left text-gray-700 align-top">
                          {(() => {
                            const extra = extraMap[memo.id];
                            if (!extra || !extra.approvers?.length) {
                              return <span className="text-gray-400">-</span>;
                            }

                            type Row = ExtraApproverRow;
                            const rows = [...extra.approvers].sort((a, b) => {
                              const ao = a.order ?? Number.MAX_SAFE_INTEGER;
                              const bo = b.order ?? Number.MAX_SAFE_INTEGER;
                              if (ao !== bo) return ao - bo;
                              const at = new Date(
                                a.actedAt ?? a.since ?? 0
                              ).getTime();
                              const bt = new Date(
                                b.actedAt ?? b.since ?? 0
                              ).getTime();
                              if (at !== bt) return at - bt;
                              return a.name.localeCompare(b.name);
                            });

                            const getTime = (r: Row) =>
                              new Date(r.actedAt ?? r.since ?? 0).getTime();
                            const latestByTime = (arr: Row[]) =>
                              arr.reduce<Row | undefined>(
                                (best, cur) =>
                                  !best || getTime(cur) > getTime(best)
                                    ? cur
                                    : best,
                                undefined
                              )!;

                            const terminated = rows.filter(
                              (r) => r.statusCode === "terminated"
                            );
                            const rejected = rows.filter(
                              (r) => r.statusCode === "rejected"
                            );
                            const waiting = rows.filter(
                              (r) => r.statusCode === "waiting"
                            );
                            const approved = rows.filter(
                              (r) => r.statusCode === "approved"
                            );

                            // หา index ของ “current” (ลอจิกเดียวกับฝั่ง Current แต่ไม่อิง level)
                            let currentIndex = 0;
                            if (terminated.length) {
                              const last = latestByTime(terminated);
                              currentIndex = rows.findIndex((r) => r === last);
                            } else if (rejected.length) {
                              const last = latestByTime(rejected);
                              currentIndex = rows.findIndex((r) => r === last);
                            } else if (waiting.length) {
                              const first = waiting.sort(
                                (a, b) =>
                                  (a.order ?? 9_999) - (b.order ?? 9_999) ||
                                  getTime(a) - getTime(b)
                              )[0];
                              currentIndex = rows.findIndex((r) => r === first);
                            } else if (approved.length) {
                              const last = latestByTime(approved);
                              currentIndex = rows.findIndex((r) => r === last);
                            }

                            const list = expanded[memo.id]
                              ? rows
                              : rows.filter((_, i) => i === currentIndex);

                            return (
                              <div className="text-blue-600 font-medium">
                                <div
                                  className="text-left inline-block max-w-[24rem]"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <ol className="space-y-1">
                                    {list.map((ap, idx) => {
                                      const idxInAll = rows.indexOf(ap);

                                      const liKey = `${ap.name}-${ap.level ?? "x"
                                        }-${ap.order ?? idx}-${ap.since ?? ap.actedAt ?? ""
                                        }`;

                                      return (
                                        <li
                                          key={liKey}
                                          className="rounded-md px-2 py-1 bg-gray-50"
                                        >
                                          <div className="flex items-center justify-between gap-2">
                                            <div className="min-w-0">
                                              {/* ✅ แสดงชื่อด้วยสีปกติเสมอ */}
                                              <span className="font-semibold truncate text-gray-900">
                                                {ap.name}
                                              </span>
                                            </div>

                                            {idx === 0 && (
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  setExpanded((p) => ({
                                                    ...p,
                                                    [memo.id]: !p[memo.id],
                                                  }));
                                                }}
                                                className="inline-flex items-center text-black/80 hover:text-black"
                                              >
                                                <svg
                                                  className={`w-5 h-5 transition-transform ${expanded[memo.id]
                                                    ? "rotate-180"
                                                    : ""
                                                    }`}
                                                  viewBox="0 0 24 24"
                                                  fill="none"
                                                >
                                                  <path
                                                    d="M6 9l6 6 6-6"
                                                    stroke="currentColor"
                                                    strokeWidth="2"
                                                    strokeLinecap="round"
                                                  />
                                                </svg>
                                              </button>
                                            )}
                                          </div>

                                          <div className="mt-1 flex items-center gap-2 min-w-0 pr-6">
                                            <div className="shrink-0">
                                              <MiniStatus code={ap.statusCode} />
                                            </div>
                                            {/* ✅ เวลาใช้สีปกติ ไม่จาง */}
                                            <span className="flex-1 text-xs text-gray-700 truncate">
                                              {timeAgo(ap.actedAt ?? ap.since)}
                                            </span>
                                          </div>
                                        </li>
                                      );
                                    })}
                                  </ol>
                                </div>
                              </div>
                            );
                          })()}
                        </td>
                      )}

                      {visibleColumns.latestComment && (
                        <td className="px-2 py-3 text-gray-700 align-top overflow-visible w-48">
                          <div className="max-w-[12rem]">
                            {memo.latestComment ? (
                              <div className="leading-tight space-y-1">
                                {(() => {
                                  const { text, isAuto } =
                                    buildLatestCommentSummary(
                                      memo.latestComment,
                                      t
                                    );
                                  if (!text) return null;

                                  // สรุปบรรทัดเดียวในตาราง
                                  const summary = isAuto
                                    ? `${memo.latestComment.userName} ${text}`
                                    : `${memo.latestComment.userName}: ${text}`;

                                  // ข้อความเต็มไว้ใน tooltip (preserve \n)
                                  const fullText = isAuto
                                    ? `${memo.latestComment.userName} ${text}`
                                    : `${memo.latestComment.userName}: ${memo.latestComment.comment ?? text
                                    }`;

                                  return (
                                    <div className="relative group">
                                      <div
                                        className="block whitespace-nowrap overflow-hidden text-ellipsis"
                                        title={isAuto ? fullText : undefined}
                                        aria-label={fullText}
                                      >
                                        {summary}
                                      </div>

                                      {/* tooltip แบบ custom เฉพาะเคสมีข้อความจริง */}
                                      {!isAuto &&
                                        (memo.latestComment.comment?.trim()
                                          ?.length ?? 0) > 0 && (
                                          <div className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden group-hover:block">
                                            <div className="max-w-[42rem] whitespace-pre-line rounded-md border bg-white p-3 text-sm leading-relaxed shadow-xl ring-1 ring-black/5">
                                              {fullText}
                                            </div>
                                          </div>
                                        )}
                                    </div>
                                  );
                                })()}

                                <div className="text-xs text-gray-500">
                                  {timeAgo(memo.latestComment.createdAt)}
                                </div>

                                {/* แนบไฟล์เหมือนเดิม */}
                                {(() => {
                                  const atts =
                                    memo.latestComment?.attachments ?? [];
                                  if (!atts.length) return null;
                                  const imgs = atts.filter((a) => a.isImage);
                                  const files = atts.filter((a) => !a.isImage);
                                  return (
                                    <div className="pt-1 space-y-1">
                                      {imgs.length > 0 && (
                                        <div className="flex items-center gap-2">
                                          {imgs.slice(0, 3).map((a, idx) => {
                                            const name =
                                              a.fileName ??
                                              a.url.split("/").pop() ??
                                              "image";
                                            return (
                                              <a
                                                key={`img-${idx}`}
                                                href={a.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="block"
                                                title={name}
                                                onClick={(e) =>
                                                  e.stopPropagation()
                                                }
                                              >
                                                <img
                                                  src={a.url}
                                                  alt={name}
                                                  className="h-10 w-10 rounded object-cover border"
                                                />
                                              </a>
                                            );
                                          })}
                                          {imgs.length > 3 && (
                                            <span className="text-xs text-gray-500">
                                              +{imgs.length - 3}
                                            </span>
                                          )}
                                        </div>
                                      )}

                                      {files.length > 0 && (
                                        <div className="flex flex-wrap gap-2">
                                          {files.map((a, idx) => {
                                            const name =
                                              a.fileName ??
                                              a.url.split("/").pop() ??
                                              "attachment";
                                            return (
                                              <a
                                                key={`file-${idx}`}
                                                href={a.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                onClick={(e) =>
                                                  e.stopPropagation()
                                                }
                                                className="inline-flex items-center gap-2 max-w-[16rem] px-2 py-1 rounded border bg-gray-50 text-gray-700 hover:bg-gray-100"
                                                title={name}
                                              >
                                                <svg
                                                  className="w-4 h-4 shrink-0"
                                                  viewBox="0 0 24 24"
                                                  fill="none"
                                                  stroke="currentColor"
                                                >
                                                  <path
                                                    d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                                                    strokeWidth="2"
                                                  />
                                                  <path
                                                    d="M14 2v6h6"
                                                    strokeWidth="2"
                                                  />
                                                </svg>
                                                <span className="truncate text-xs">
                                                  {name}
                                                </span>
                                              </a>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </div>
                        </td>
                      )}

                      {/* CC Status */}
                      {visibleColumns.ccStatus && (
                        <td className="px-2 py-3 text-center text-gray-700">
                          {myCCMemoIds.has(memo.id) ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                              <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                                <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
                                <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
                              </svg>
                              CC
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                      )}

                      {/* <td
                      className="px-2 py-3 text-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => deleteMemo(memo.id)}
                        className="text-red-500 hover:text-red-700"
                        title={t("table.delete")}
                      >
                        🗑️
                      </button>
                    </td> */}
                    </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
