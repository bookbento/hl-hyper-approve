// src/component/MemoAndApproval.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { api, BASE_URL } from "../../lib/api";
import { AnimatePresence, motion } from "framer-motion";
import { FiAlertTriangle } from "react-icons/fi";
import { SlArrowDown } from "react-icons/sl";
import { useNavigate } from "react-router-dom";
import TerminateReasonModal from "./TerminateReasonModal";
import { DatePicker, Modal, Select } from "antd";
import dayjs from "dayjs";
import { ExtraApprovalCard } from "./ExtraApprovalCard";


// ===== types =====
export interface Approver {
  id: number;
  name: string;
  lastname?: string | null;
  nickname?: string | null;
  level: number;
  status: "approved" | "rejected" | "terminated" | "waiting" | string;
  loaUserPivotId: number;
  actedAt?: string | null; // ⬅️ เพิ่ม
  since?: string | null; // ⬅️ เพิ่ม
  isSigReq?: boolean;
  hasSigMarkerForThisUser?: boolean;
  approveWithCondition?: string | null;
  rejectReason?: string | null;
  terminateReason?: string | null;
}
export interface CcGroupPreviewMember {
  id: number;
  name: string;
  email?: string | null;
  profileImageUrl?: string | null; // e.g. "/uploads/avatars/123.jpg" หรือ absolute URL
  profileImagePath?: string | null; // e.g. "avatars/123.jpg" หรือ "uploads/avatars/123.jpg"
  profileImage?: string | null; // e.g. "data:image/png;base64,..." หรือ base64 ล้วน
  avatarUrl?: string | null;
  avatarPath?: string | null;
  imageUrl?: string | null;
}

export interface CcGroupPreview {
  id: number;
  name: string;
  memberCount: number;
  previewMembers: CcGroupPreviewMember[];
}
// ===== types =====
export interface SignaturePosition {
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

export interface ApproverGroup {
  level: number;
  users: Approver[];
}
// เพิ่มในไฟล์นี้
export interface CcRecipient {
  userId: number;
  name: string;
  email: string;
  addedAt: string;
  profileImage?: string | null; // base64 หรือ data:URL (เดิม)
  profileImageUrl?: string | null; // ✅ path จาก backend เช่น "/uploads/avatars/123.jpg"
}

export interface UserSignature {
  id: number;
  path: string;
  label?: string;
}

type Props = {
  // ใน type Props
  memo: {
    id: number;
    subject: string;
    memonumber: string;
    userId: number;
    user?: { id: number; name: string };
    businessUnit?: { name: string };
    department?: { name: string };
    memoType?: { name: string };
    createdAt: string;
    expiresAt?: string | null;
    signaturePositions?: SignaturePosition[];

    lastHistory?: {
      action: string;
      actiontype: string | null; // "Recall" ตอนเรียกคืน
      timestamp: string; // เวลาเกิดเหตุการณ์ล่าสุด
      userName: string;
      statusName: string | null;
    } | null;
    status?: string | null; // "Recall" / "Processing" ฯลฯ (ถ้ามี)
  };
  memoId: string | number;
  approverGroups: ApproverGroup[];
  ccRecipients: CcRecipient[];
  ccGroups?: CcGroupPreview[];
  ccGroupIds?: number[];
  statusLabel: string;
  signaturePositions?: SignaturePosition[];
  // สิทธิ/สถานะของผู้อนุมัติ
  isInApproval: boolean;
  minWaitingLevel: number | null;
  meId: number | null;

  // ลายเซ็น
  userSignatures: UserSignature[];
  defaultSignatureId: number | null;
  myDisplayName: string;
  defaultSignatureText?: string;

  // actions & helpers
  onReject: (loaUserPivotId: number) => Promise<void> | void;
  onAfterAction?: () => Promise<void> | void; // reload data
  canTerminate: boolean;
  onTerminate: (reason: string) => Promise<void> | void;
  onOpenPdf: () => void;
  showMobileActions?: boolean; // ใช้ซ่อนปุ่มบนมือถือเวลาเปิด PDF overlay
  displayNameFromId: (id?: number, fallbackName?: string) => string;
  extraBusy?: boolean;
  extraLine?: {
    id: number;
    status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "REJECTED";
    approvers: Array<{
      id: number;
      user: {
        id: number;
        name: string;
        lastname?: string | null;
        nickname?: string | null;
      };
      status?: { id: number; name: string } | null;
    }>;
  } | null;
  isReferenceMode?: boolean; // Hide action buttons when viewing as reference
  // ⬇️ NEW: Expose approval handlers for quick actions
  onApprove: (loaUserPivotId: number, requiresSignature: boolean) => void | Promise<void>;
  onApproveWithCondition: (loaUserPivotId: number, requiresSignature: boolean) => void | Promise<void>;
  jumpToComments?: () => void;
};

type ExtraAssignee = { userId: number; status: string }; // PENDING | APPROVED | REJECTED

const ROOT_URL = BASE_URL.replace(/\/api\/?$/, ""); // ตัด /api ออก (ถ้ามี)
const API_URL = `${ROOT_URL}/api`; // api root มาตรฐาน

const statusPill: Record<string, string> = {
  Approved: "bg-green-100 text-green-700",
  Rejected: "bg-orange-100 text-orange-700",
  Terminated: "bg-orange-200 text-orange-600",
  Recall: "bg-sky-100 text-sky-700",
  Processing: "bg-yellow-100 text-yellow-700",
  Draft: "bg-gray-100 text-gray-700",
  Expired: "bg-purple-100 text-purple-800",
};

const perUserBadge: Record<string, string> = {
  approved: "bg-green-100 text-green-800",
  rejected: "bg-orange-200 text-orange-800",
  terminated: "bg-red-100 text-red-800",
  waiting: "bg-blue-100 text-blue-800",
  not_required: "bg-green-50 text-green-700",
  default: "bg-gray-100 text-gray-800",
};

// ===== countdown helpers =====
function useCountdown(targetISO?: string | null, tickMs = 1000) {
  const [now, setNow] = React.useState<number>(() => Date.now());

  React.useEffect(() => {
    if (!targetISO) return;
    const iv = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(iv);
  }, [targetISO, tickMs]);

  const target = targetISO ? new Date(targetISO).getTime() : NaN;
  const valid = Number.isFinite(target);
  let remaining = valid ? target - now : NaN;
  const expired = valid ? remaining <= 0 : false;
  if (expired) remaining = 0;

  const totalSec = valid ? Math.max(0, Math.floor(remaining / 1000)) : 0;
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  return { valid, expired, days, hours, minutes, seconds };
}

// ==== auto fit helper ====
// --- auto-fit ที่ยอมรับ null-friendly refs ---
function useAutoFit(
  wrapperRef: React.RefObject<HTMLElement | null>,
  contentRef: React.RefObject<HTMLElement | null>,
  deps: React.DependencyList = []
) {
  React.useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    const fit = () => {
      const available = wrapper.clientWidth - 4;
      const need = content.scrollWidth;
      const scale = Math.max(
        0.5,
        Math.min(1, available > 0 ? available / need : 1)
      );
      content.style.transform = `scale(${scale})`;
      content.style.transformOrigin = "center center";
    };

    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    ro?.observe(wrapper);
    ro?.observe(content);
    fit();

    return () => ro?.disconnect();
  }, deps);
}

// --- เปลี่ยนชื่อเป็น CDUnit เพื่อกันชนกับตัวเดิม ---
// แทน CDUnit เดิม
const CDUnit: React.FC<{ n: number; label: string; className?: string }> = ({
  n,
  label,
  className,
}) => (
  <span className="inline-flex flex-col items-center leading-none">
    <span
      className={
        `font-mono tabular-nums font-extrabold leading-none
         text-3xl md:text-4xl ` + (className ?? "text-gray-900")
      }
      aria-label={`${n} ${label}`}
    >
      {String(n).padStart(2, "0")}
    </span>
    <span className="mt-1 uppercase tracking-[0.14em] text-[10px] md:text-xs text-gray-500">
      {label}
    </span>
  </span>
);


const UserRow: React.FC<{ u: CcRecipient; fullName: string }> = ({ u, fullName }) => {
  const src = u.profileImage ?? u.profileImageUrl ?? undefined;
  return (
    <div className="flex items-center gap-2 py-0.5 min-w-0">
      <Avatar src={src} name={fullName} userId={u.userId} sizeClass="h-5 w-5" />
      <span className="truncate">{fullName}</span>
    </div>
  );
};
// === Unified CC list: vertical (one name per line) with toggle ===
const CcUnifiedList: React.FC<{
  users: CcRecipient[];
  groups: CcGroupPreview[];
  ccNameMap: Record<number, string>;
  displayNameFromId: Props["displayNameFromId"];
}> = ({ users, groups, ccNameMap, displayNameFromId }) => {
  const LIMIT = 5;
  const [expanded, setExpanded] = React.useState(false);
  const { t } = useTranslation("memoViewer");
  // 1) hint สมาชิกจากกลุ่ม (กันเคส backend ส่ง users มาไม่ครบ)
  const hintedFromGroups = React.useMemo<CcRecipient[]>(
    () =>
      (groups ?? []).flatMap((g) =>
        (g.previewMembers ?? []).map((m) => {
          const raw =
            m.profileImage ??
            m.profileImageUrl ??
            m.avatarUrl ??
            m.imageUrl ??
            m.profileImagePath ??
            m.avatarPath ??
            null;

          let profileImage: string | null = null;
          let profileImageUrl: string | null = null;
          if (typeof raw === "string" && raw.trim()) {
            const s = raw.trim();
            if (s.startsWith("data:") || /^[A-Za-z0-9+/=\s]+$/.test(s)) {
              profileImage = s.startsWith("data:")
                ? s
                : `data:image/jpeg;base64,${s.replace(/\s/g, "")}`;
            } else {
              profileImageUrl = normalizeAssetPath(s);
            }
          }

          return {
            userId: Number(m.id) || 0,
            name: m.name ?? "",
            email: m.email ?? "",
            addedAt: "",
            profileImage,
            profileImageUrl,
          } as CcRecipient;
        })
      ),
    [groups]
  );

  // 2) รวม + ตัดซ้ำ
  const mergedUsers = React.useMemo(
    () => dedupByUserId([...(users ?? []), ...hintedFromGroups]),
    [users, hintedFromGroups]
  );

  // 3) เรียงตามชื่อที่ enrich แล้ว (ถ้าไม่มีข้อมูลให้เป็น [] ไปเลย)
  const sorted = React.useMemo(() => {
    if (!mergedUsers.length) return [];
    return [...mergedUsers].sort((a, b) => {
      const an = (ccNameMap[a.userId] || a.name || "").toString();
      const bn = (ccNameMap[b.userId] || b.name || "").toString();
      return an.localeCompare(bn, undefined, { sensitivity: "base" });
    });
  }, [mergedUsers, ccNameMap]);

  const isEmpty = sorted.length === 0;
  const visible = expanded ? sorted : sorted.slice(0, LIMIT);
  const hiddenCount = Math.max(0, sorted.length - visible.length);

  return (
    <div className="w-full">
      {isEmpty ? (
        <div className="text-sm text-gray-500">-</div>
      ) : (
        <>
          {/* list แนวตั้ง + แอนิเมชัน */}
          <motion.ul layout className="space-y-1">
            <AnimatePresence initial={false}>
              {visible.map((u, i) => {
                const fullName =
                  ccNameMap[u.userId] || displayNameFromId(u.userId, u.name);

                // แสดงดีเลย์เฉพาะ “คนที่เพิ่งถูกขยายเพิ่ม” (index ≥ LIMIT)
                const isNew = expanded && i >= LIMIT;
                const delay = isNew ? (i - LIMIT) * 0.06 : 0;

                return (
                  <motion.li
                    layout
                    key={`u-${u.userId}`}
                    className="min-w-0 overflow-hidden"
                    initial={isNew ? { opacity: 0, y: -6, height: 0 } : false}
                    animate={{ opacity: 1, y: 0, height: "auto" }}
                    exit={{ opacity: 0, y: -6, height: 0 }}
                    transition={{ duration: 0.22, ease: "easeOut", delay }}
                  >
                    <UserRow u={u} fullName={fullName} />
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </motion.ul>

          {/* toggle */}
          {sorted.length > LIMIT && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-1 text-xs text-gray-600 hover:underline"
              aria-expanded={false}
              aria-label={t("ccList.seeMoreAria", { count: hiddenCount })}
              title={t("ccList.seeMoreAria", { count: hiddenCount })}
            >
              {t("ccList.showAll", { count: hiddenCount })}
            </button>
          )}
          {sorted.length > LIMIT && expanded && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="mt-1 text-xs text-gray-600 hover:underline"
              aria-expanded={true}
            >
              {t("ccList.collapse")}
            </button>
          )}
        </>
      )}
    </div>
  );
};


// --- single-line countdown ที่ auto-fit ---
const ExpiryCountdown: React.FC<{ iso?: string | null }> = ({ iso }) => {
  const { t } = useTranslation("memoViewer");

  const { valid, expired, days, hours, minutes, seconds } = useCountdown(
    iso,
    1000
  );
  const totalKey = days * 86400 + hours * 3600 + minutes * 60 + seconds;

  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const innerRef = React.useRef<HTMLDivElement | null>(null);
  useAutoFit(wrapRef, innerRef, [totalKey]);

  if (!iso || !valid) return <span className="text-gray-500">-</span>;

  // --- expired: ใช้ layout เดียวกับ countdown ---
  if (expired) {
    return (
      <div ref={wrapRef} className="w-full flex justify-center overflow-hidden">
        <div
          ref={innerRef}
          className="inline-flex items-end gap-4 md:gap-6 whitespace-nowrap will-change-transform"
        >
          {/* ป้าย 'หมดอายุแล้ว' โทนเดียวกับตัวเลข */}
          <span
            className="inline-flex items-center px-3 py-1.5 rounded-full
                           bg-red-50 text-red-700 border border-red-200
                           font-semibold text-xs md:text-sm"
          >
            <svg
              viewBox="0 0 20 20"
              className="w-4 h-4 mr-1.5"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.72-1.36 3.485 0l6.518 11.6c.75 1.335-.213 3.001-1.742 3.001H3.48c-1.53 0-2.492-1.666-1.743-3.001l6.52-11.6zM11 14a1 1 0 11-2 0 1 1 0 012 0zm-1-2a1 1 0 01-1-1V8a1 1 0 112 0v3a1 1 0 01-1 1z"
                clipRule="evenodd"
              />
            </svg>
            {t("expired", "หมดอายุแล้ว")}
          </span>

          {/* ชุดตัวเลข 00 ให้โทนแดงเหมือนกัน */}
          <CDUnit
            n={0}
            label={t("countdown.days", "DAYS")}
            className="text-red-600"
          />
          <CDUnit
            n={0}
            label={t("countdown.hours", "HOURS")}
            className="text-red-600"
          />
          <CDUnit
            n={0}
            label={t("countdown.minutes", "MINUTES")}
            className="text-red-600"
          />
          <CDUnit
            n={0}
            label={t("countdown.seconds", "SECONDS")}
            className="text-red-600"
          />
        </div>
      </div>
    );
  }

  // --- ปกติ: นับถอยหลังพร้อมโทนสีตามความเร่งด่วน ---
  const tone =
    days === 0 && hours < 12
      ? "text-red-600"
      : days < 3
        ? "text-amber-600"
        : "text-gray-500";

  return (
    <div ref={wrapRef} className="w-full flex justify-center overflow-hidden">
      <div
        ref={innerRef}
        className="inline-flex items-end gap-4 md:gap-6 whitespace-nowrap will-change-transform"
      >
        <CDUnit n={days} label={t("countdown.days", "DAYS")} className={tone} />
        <CDUnit
          n={hours}
          label={t("countdown.hours", "HOURS")}
          className={tone}
        />
        <CDUnit
          n={minutes}
          label={t("countdown.minutes", "MINUTES")}
          className={tone}
        />
        <CDUnit
          n={seconds}
          label={t("countdown.seconds", "SECONDS")}
          className={tone}
        />
      </div>
    </div>
  );
};

function useNow(intervalMs = 60000) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(iv);
  }, [intervalMs]);
  return now;
}
const useTimeAgo = () => {
  const { t, i18n } = useTranslation(["memoViewer", "dashboard", "common"]);
  const now = useNow(60000); // ✅ บังคับ re-render ทุก 60 วินาที
  const tt = (k: string) => t(k, { ns: ["memoViewer", "dashboard", "common"] });

  return (fromISO?: string) => {
    if (!fromISO) return "-";
    const then = new Date(fromISO).getTime();
    if (isNaN(then)) return "-";
    const diff = now - then; // ✅ ใช้ now จาก state
    const abs = Math.abs(diff);

    const MIN = 60000,
      H = 60 * MIN,
      D = 24 * H,
      W = 7 * D,
      M = 30 * D,
      Y = 365 * D;
    if (abs < 45000)
      return diff >= 0 ? tt("timeago.nowPast") : tt("timeago.nowFuture");

    const table: Array<[number, string]> = [
      [Y, "year"],
      [M, "month"],
      [W, "week"],
      [D, "day"],
      [H, "hour"],
      [MIN, "minute"],
    ];
    for (const [ms, key] of table) {
      if (abs >= ms) {
        const n = Math.floor(abs / ms);
        const unit = tt(`timeago.units.${key}`);
        const unitStr =
          i18n.language.startsWith("en") && n !== 1 ? `${unit}s` : unit;
        return i18n.language.startsWith("en")
          ? diff >= 0
            ? `${n} ${unitStr} ago`
            : `${tt("timeago.futurePrefix")}${n} ${unitStr}`
          : `${diff >= 0 ? tt("timeago.pastPrefix") : tt("timeago.futurePrefix")
          }${n} ${unitStr}`;
      }
    }
    const n = Math.floor(abs / 1000);
    const unit = tt("timeago.units.second");
    return i18n.language.startsWith("en")
      ? diff >= 0
        ? `${n} ${unit}${n !== 1 ? "s" : ""} ago`
        : `${tt("timeago.futurePrefix")}${n} ${unit}${n !== 1 ? "s" : ""}`
      : `${diff >= 0 ? tt("timeago.pastPrefix") : tt("timeago.futurePrefix")
      }${n} ${unit}`;
  };
};

const useDateTimeFormatter = () => {
  const { i18n } = useTranslation();
  return React.useCallback(
    (iso?: string | null) => {
      if (!iso) return "-";
      const d = new Date(iso);
      if (isNaN(+d)) return "-";
      // ปรับ option ตามใจได้
      return new Intl.DateTimeFormat(i18n.language || undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(d);
    },
    [i18n.language]
  );
};

// ช่วยต่อ URL ให้เป็น absolute เสมอ และกัน // ซ้อน
const absolutize = (p: string) => {
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p; // เป็น absolute อยู่แล้ว
  const base = ROOT_URL.replace(/\/+$/, ""); // << ใช้ ROOT_URL
  const path = p.replace(/^\/+/, "");
  return `${base}/${path}`;
};

const looksLikePath = (s: string) =>
  s.includes("/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(s);

const looksLikeBase64 = (s: string) =>
  /^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 100; // หลวมๆ กัน false positive

const normalizeAssetPath = (p: string) => {
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p; // absolute URL อยู่แล้ว

  // สะสางสแลช/แบ็กสแลช
  const cleaned = p.trim().replace(/\\/g, "/");
  const noLead = cleaned.replace(/^\/+/, "");

  // กรณีส่งมาพร้อม api/secure-uploads หรือ secure-uploads อยู่แล้ว
  if (/^api\/secure-uploads\//i.test(noLead)) return `/${noLead}`;
  if (/^secure-uploads\//i.test(noLead)) return `/api/${noLead}`;

  // เคสเดิม ๆ ที่ชอบมา: "uploads/..." หรือ "profiles|avatars|images|signatures/..."
  if (noLead.startsWith("uploads/")) {
    // ตัด "uploads/" ออก แล้วพาไปที่ /api/secure-uploads/**
    return `/api/secure-uploads/${noLead.replace(/^uploads\//, "")}`;
  }
  if (/^(profiles|avatars|images|signatures)\//i.test(noLead)) {
    return `/api/secure-uploads/${noLead}`;
  }

  // fallback: ถือว่าเป็นไฟล์ใต้รากอัปโหลด
  return `/api/secure-uploads/${noLead}`;
};


const sigSrc = (id: number, p: string) => {
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p;
  return `${API_URL}/users/signatures/${id}/file`; // << ใช้ API_URL
};

const DetailItem = ({ label, value }: { label: string; value?: string }) => (
  <div className="flex gap-2 items-start">
    <span className="flex-shrink-0 font-medium text-gray-600">{label}:</span>
    <span className="text-gray-700 min-w-0 flex-1 [overflow-wrap:anywhere]">
      {value || "-"}
    </span>
  </div>
);

// ===== Avatar helpers =====
const getInitials = (name?: string) =>
  (name ?? "U")
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0]!.toUpperCase())
    .slice(0, 2)
    .join("") || "U";

const resolveAvatarSrc = (src?: string | null): string | null => {
  if (!src) return null;
  const s = src.trim();
  if (s.startsWith("data:")) return s;
  if (/^https?:\/\//i.test(s)) return s; // ถ้าเป็น absolute อยู่แล้ว (เช่นลิงก์ข้างบน) ใช้ได้เลย
  if (looksLikeBase64(s)) return `data:image/jpeg;base64,${s.replace(/\s/g, "")}`;

  // ⬇️ ใหม่: ทำ path ให้เป็น absolute ชี้ไปที่ backend
  const p = normalizeAssetPath(s); // -> "/uploads/profiles/xxx.png"
  return absolutize(p);            // -> "http://172.16.8.71:3001/uploads/profiles/xxx.png"
};


type AvatarProps = {
  /** raw src จาก backend/base64/dataURL/path */
  src?: string | null;
  /** ใช้ทำ alt/initials และเป็น seed สำรอง */
  name?: string | null;
  /** ใช้เป็น seed ให้ DiceBear */
  userId?: number | null;
  /** ใส่ class ขนาด เช่น "w-8 h-8" */
  sizeClass?: string;
  className?: string;
};

const Avatar: React.FC<AvatarProps> = ({
  src,
  name,
  userId,
  sizeClass = "w-8 h-8",
  className = "",
}) => {
  const initialSrc = React.useMemo(() => resolveAvatarSrc(src), [src]);
  const [imgSrc, setImgSrc] = React.useState<string | null>(initialSrc);
  const [failCount, setFailCount] = React.useState(0);

  // ✅ เพิ่มบล็อกนี้
  React.useEffect(() => {
    const next = resolveAvatarSrc(src);
    setFailCount(0); // รีเซ็ตสถานะ error/fallback
    setImgSrc(next ?? null); // อัปเดต src ตาม props ล่าสุด
  }, [src]);

  const handleError = () => {
    setFailCount((f) => {
      setImgSrc(null); // fail ครั้งแรกก็ไปตัวอักษรย่อเลย
      return f + 1;
    });
  };

  if (!imgSrc) {
    return (
      <div
        className={`${sizeClass} rounded-full bg-gradient-to-r from-[#00ffaa] to-[#00cc88]
        flex items-center justify-center font-bold text-gray-900 text-[10px] leading-none ${className}`}
        title={name ?? undefined}
        aria-label={name ?? "avatar"}
      >
        {getInitials(name ?? undefined)}
      </div>
    );
  }

  return (
    <img
      src={imgSrc}
      alt={name ?? "avatar"}
      className={`${sizeClass} rounded-full object-cover ${className}`}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={handleError}
    />
  );
};

// ---- helpers สำหรับฟอร์แมตชื่อ + ดึงข้อมูลผู้ใช้ (มีแคช) ----
const formatFullName = (u?: any) => {
  if (!u) return "";
  const ln = u.lastname ?? u.lastName ?? "";
  const nn = u.nickname ?? u.nickName ?? "";
  const base = [u.name, ln].filter(Boolean).join(" ").trim();
  return nn ? `${base} (${nn})` : base || u.name || "";
};

const useUserDisplayName = (
  id?: number,
  seed?: {
    name?: string;
    lastname?: any;
    lastName?: any;
    nickname?: any;
    nickName?: any;
  }
) => {
  const cacheRef = React.useRef<Map<number, string>>(new Map());
  const [label, setLabel] = React.useState<string>(() => formatFullName(seed));

  React.useEffect(() => {
    if (!id) return;

    // ถ้ามีในแคชแล้ว
    const cached = cacheRef.current.get(id);
    if (cached) {
      setLabel(cached);
      return;
    }

    // ถ้า seed มี ln/nick ครบ ก็ฟอร์แมตและแคชเลย
    const hasExtra = !!(
      seed?.lastname ??
      seed?.lastName ??
      seed?.nickname ??
      seed?.nickName
    );
    if (hasExtra) {
      const s = formatFullName(seed);
      cacheRef.current.set(id, s);
      setLabel(s);
      return;
    }

    // ดึงจาก backend
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/api/users/basic-info`, {
          params: { ids: id },
          withCredentials: true,
        });
        const u = Array.isArray(data)
          ? data.find((x: any) => x.id === id)
          : data;
        const s = formatFullName(u) || (seed?.name ?? "");
        if (!cancelled) {
          cacheRef.current.set(id, s);
          setLabel(s);
        }
      } catch {
        if (!cancelled) setLabel(seed?.name ?? "");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    id,
    seed?.name,
    seed?.lastname,
    seed?.lastName,
    seed?.nickname,
    seed?.nickName,
  ]);

  return label || "";
};

const UserLabel: React.FC<{ id?: number; seed?: any; className?: string }> = ({
  id,
  seed,
  className,
}) => {
  const label = useUserDisplayName(id, seed); // จะยิง /api/users/basic-info ให้เองถ้า ln/nick หาย
  return <span className={className}>{label || seed?.name || "-"}</span>;
};

const isPlaceholderLike = (s?: string | null) => {
  if (!s) return true;
  const v = String(s).trim().toLowerCase();
  return v === "" || v === "null" || v === "undefined" || v === "-";
};

// ---- normalize any CC user shape -> CcRecipient
const toCcRecipient = (r: any): CcRecipient => {
  const candidates = [
    r?.profileImageUrl,
    r?.avatarUrl,
    r?.imageUrl,
    r?.profileImagePath,
    r?.avatarPath,
    r?.profileImage,
  ];
  const u = r?.user ?? {};
  candidates.push(
    u?.profileImageUrl,
    u?.avatarUrl,
    u?.imageUrl,
    u?.profileImagePath,
    u?.avatarPath,
    u?.profileImage
  );

  let profileImageUrl: string | null = null;
  let profileImage: string | null = null;

  for (const c of candidates) {
    if (!c || typeof c !== "string") continue;
    const sRaw = c.trim();
    if (isPlaceholderLike(sRaw)) continue;

    if (sRaw.startsWith("data:") || looksLikeBase64(sRaw)) {
      // base64/dataURL ให้ชนะทันที
      profileImage = sRaw.startsWith("data:")
        ? sRaw
        : `data:image/jpeg;base64,${sRaw.replace(/\s/g, "")}`;
      break;
    } else {
      profileImageUrl = normalizeAssetPath(sRaw);
    }
  }

  return {
    userId: Number(r?.userId ?? r?.id ?? r?.user?.id) || 0,
    name: r?.name ?? r?.user?.name ?? "",
    email: r?.email ?? r?.user?.email ?? "",
    addedAt: r?.addedAt ?? r?.createdAt ?? "",
    profileImageUrl,
    profileImage,
  };
};

const dedupByUserId = (list: CcRecipient[] = []) => {
  const map = new Map<number, CcRecipient>();
  for (const u of list) {
    const id = Number(u?.userId || 0);
    if (!id) continue;
    const prev = map.get(id);
    if (!prev) {
      map.set(id, u);
      continue;
    }
    // merge แบบเลือกของที่ “มีค่า” มากกว่า
    const merged: CcRecipient = {
      userId: id,
      name: prev.name || u.name || "",
      email: prev.email || u.email || "",
      addedAt: prev.addedAt || u.addedAt || "",
      // รูป: ให้ dataURL/base64 ชนะ, ถ้าไม่มีให้ใช้ URL
      profileImage: prev.profileImage || u.profileImage || null,
      profileImageUrl: prev.profileImageUrl || u.profileImageUrl || null,
    };
    map.set(id, merged);
  }
  return Array.from(map.values());
};
const MemoAndApproval: React.FC<Props> = ({
  memo,
  memoId,
  approverGroups,
  ccRecipients,
  ccGroups: ccGroupsProp = [],
  ccGroupIds: ccGroupIdsProp = [],
  statusLabel,
  isInApproval,
  minWaitingLevel,
  meId,
  userSignatures,
  defaultSignatureId,
  myDisplayName,
  defaultSignatureText,
  onReject,
  onAfterAction,
  canTerminate,
  onTerminate,
  onOpenPdf,
  showMobileActions = true,
  displayNameFromId,
  extraBusy = false,
  extraLine = null,
  jumpToComments,
  onApprove, // <--- Correctly exposed
  onApproveWithCondition,
}) => {
  const { t } = useTranslation("memoViewer");

  // Local state


  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [terminating, setTerminating] = useState(false);
  const [terminateModalOpen, setTerminateModalOpen] = useState(false);
  const [showMemoDetails, setShowMemoDetails] = useState(false);
  const createdByLabel = useUserDisplayName(memo.user?.id, memo.user);
  const [ccGroups, setCcGroups] = useState<CcGroupPreview[]>(
    ccGroupsProp ?? []
  );
  const [ccGroupIds, setCcGroupIds] = useState<number[]>(ccGroupIdsProp ?? []);
  const [ccUsers, setCcUsers] = useState<CcRecipient[]>(
    dedupByUserId(ccRecipients ?? [])
  );

  useEffect(() => {
    if (Array.isArray(ccRecipients) && ccRecipients.length > 0) {
      setCcUsers(dedupByUserId(ccRecipients));
    }
  }, [ccRecipients]);
  const blockedByExtra = !!extraBusy;
  const isExpired = React.useMemo(() => {
    if (!memo?.expiresAt) return false;
    const t = Date.parse(memo.expiresAt);
    return Number.isFinite(t) ? t <= Date.now() : false;
  }, [memo?.expiresAt]);
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewDate, setRenewDate] = useState<dayjs.Dayjs | null>(null);
  const [renewTargetStatus, setRenewTargetStatus] = useState<"Draft" | "Processing">("Processing");
  const [renewing, setRenewing] = useState(false);
  const [extraActive, setExtraActive] = useState<ExtraLine | null>(null);
  // ✅ State for all extra approval lines (not just active)
  const [extraLines, setExtraLines] = useState<any[]>([]);

  // ✅ Fetch all extra approval lines for this memo
  React.useEffect(() => {
    if (!memoId) return;

    const fetchAllExtraLines = async () => {
      try {
        const res = await api.get(`/api/memos/${memoId}/extra-approval-lines`, {
          withCredentials: true,
        });
        setExtraLines(Array.isArray(res.data) ? res.data : []);
      } catch (err) {
        console.error("Failed to fetch extra approval lines:", err);
        setExtraLines([]);
      }
    };

    fetchAllExtraLines();
  }, [memoId]);

  // ✅ Handlers for extra approval actions
  const handleExtraApprove = React.useCallback(async (lineId: number) => {
    if (!memoId) return;
    try {
      await api.post(
        `/api/memos/${memoId}/extra-approval-lines/${lineId}/action`,
        { statusCode: "approved" },
        { withCredentials: true }
      );
      toast.success(t("extra.approveSuccess", "Extra approval approved"));
      // Refetch extra lines
      const res = await api.get(`/api/memos/${memoId}/extra-approval-lines`, {
        withCredentials: true,
      });
      setExtraLines(Array.isArray(res.data) ? res.data : []);
      // Trigger parent refresh if needed
      if (onAfterAction) {
        onAfterAction();
      }
    } catch (err) {
      console.error("Failed to approve extra line:", err);
      toast.error(t("extra.approveFailed", "Failed to approve"));
    }
  }, [memoId, onAfterAction, t]);

  const handleExtraReject = React.useCallback(async (lineId: number) => {
    if (!memoId) return;
    if (!confirm(t("extra.confirmReject", "Are you sure you want to reject?"))) {
      return;
    }
    try {
      await api.post(
        `/api/memos/${memoId}/extra-approval-lines/${lineId}/action`,
        { statusCode: "rejected" },
        { withCredentials: true }
      );
      toast.success(t("extra.rejectSuccess", "Extra approval rejected"));
      // Refetch extra lines
      const res = await api.get(`/api/memos/${memoId}/extra-approval-lines`, {
        withCredentials: true,
      });
      setExtraLines(Array.isArray(res.data) ? res.data : []);
      // Trigger parent refresh if needed
      if (onAfterAction) {
        onAfterAction();
      }
    } catch (err) {
      console.error("Failed to reject extra line:", err);
      toast.error(t("extra.rejectFailed", "Failed to reject"));
    }
  }, [memoId, onAfterAction, t]);

  const navigate = useNavigate();
  // เติมชื่อให้ช่อง text เมื่อเลือกวิธีพิมพ์
  const timeAgo = useTimeAgo();
  const formatDateTime = useDateTimeFormatter();
  // ⬇️ NEW: แคชชื่อเต็มของ CC
  const [ccNameMap, setCcNameMap] = useState<Record<number, string>>({});
  const myActionRef = React.useRef<HTMLDivElement | null>(null);
  const [flashMyAction, setFlashMyAction] = useState(false);

  const scrollToMyAction = React.useCallback(() => {
    const el =
      myActionRef.current ||
      (document.querySelector(
        '[data-my-action-anchor="true"]'
      ) as HTMLElement | null);

    if (!el) {
      toast.error("ไม่พบตำแหน่งปุ่มของคุณ");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashMyAction(true);
    window.setTimeout(() => setFlashMyAction(false), 1200);
  }, []);

  const hasMyCard = React.useMemo(
    () =>
      approverGroups.flatMap((g) => g.users ?? []).some((u) => u.id === meId),
    [approverGroups, meId]
  );

  // useEffect ที่โหลด CC จาก backend
  useEffect(() => {
    let cancelled = false;
    setCcGroups(ccGroupsProp ?? []);
    setCcGroupIds(ccGroupIdsProp ?? []);

    (async () => {
      try {
        const { data } = await api.get(`/api/memos/${memoId}/cc`, {
          withCredentials: true,
        });
        if (cancelled) return;

        const apiGroups = Array.isArray(data?.groups) ? data.groups : [];
        const apiGroupIds = Array.isArray(data?.groupIds) ? data.groupIds : [];
        const apiUsersRaw = Array.isArray(data?.users) ? data.users : [];

        const apiUsers = apiUsersRaw
          .map(toCcRecipient)
          .filter((u: { userId: number }) => u.userId);

        const hintedFromApiGroups: CcRecipient[] = apiGroups.flatMap((g: any) =>
          (g.previewMembers ?? []).map((m: any) => {
            const raw =
              m.profileImage ??
              m.profileImageUrl ??
              m.avatarUrl ??
              m.imageUrl ??
              m.profileImagePath ??
              m.avatarPath ??
              null;

            let profileImage: string | null = null;
            let profileImageUrl: string | null = null;

            if (typeof raw === "string" && !isPlaceholderLike(raw)) {
              const s = raw.trim();
              if (s.startsWith("data:") || looksLikeBase64(s)) {
                profileImage = s.startsWith("data:")
                  ? s
                  : `data:image/jpeg;base64,${s.replace(/\s/g, "")}`;
              } else {
                // ✅ สำคัญ: ไม่ absolutize
                profileImageUrl = normalizeAssetPath(s);
              }
            }

            return {
              userId: Number(m.id) || 0,
              name: m.name ?? "",
              email: m.email ?? "",
              addedAt: "",
              profileImage,
              profileImageUrl,
            } as CcRecipient;
          })
        );

        if (!ccGroupsProp?.length) setCcGroups(apiGroups);
        if (!ccGroupIdsProp?.length) setCcGroupIds(apiGroupIds);

        const fromProps = Array.isArray(ccRecipients) ? ccRecipients : [];
        // 🔧 เอา API ก่อน เพื่อให้เรคอร์ดที่ “มีรูป” ชนะตั้งแต่รอบแรก
        setCcUsers(
          dedupByUserId([...apiUsers, ...fromProps, ...hintedFromApiGroups])
        );
      } catch {
        if (cancelled) return;
        if (!ccGroupsProp?.length) setCcGroups([]);
        if (!ccGroupIdsProp?.length) setCcGroupIds([]);
        const fromProps = Array.isArray(ccRecipients) ? ccRecipients : [];
        setCcUsers(dedupByUserId(fromProps));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    memoId,
    ccGroupsProp?.length ?? 0,
    ccGroupIdsProp?.length ?? 0,
    ccRecipients?.length ?? 0,
  ]);

  // ⬇️ NEW: เติม ln/nickname ให้ CC แบบ bulk
  useEffect(() => {
    const ids = [...new Set((ccUsers ?? []).map((u) => u.userId))];
    if (!ids.length) {
      setCcNameMap({});
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/api/users/basic-info`, {
          params: { ids: ids.join(",") },
          withCredentials: true,
        });

        const map: Record<number, string> = {};
        ids.forEach((id) => {
          const u = Array.isArray(data)
            ? data.find((x: any) => x.id === id)
            : null;
          const seed = ccUsers.find((x) => x.userId === id);
          map[id] =
            (u ? formatFullName(u) : seed?.name ?? "") || (seed?.name ?? "");
        });
        if (!cancelled) setCcNameMap(map);
      } catch {
        if (!cancelled) {
          const map: Record<number, string> = {};
          ids.forEach((id) => {
            const seed = ccUsers.find((x) => x.userId === id);
            map[id] = seed?.name ?? "";
          });
          setCcNameMap(map);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ccUsers]);

  // Removed sigMethod effect

  // Removed onApprovalHandlersReady logic as handlers are passed from parent

  useEffect(() => {
    let ok = true;
    (async () => {
      try {
        // ใช้เส้นทางเดียวกับ CommentSection
        const res = await api.get(
          `/api/memos/${memoId}/extra-approval-lines/active`,
          { withCredentials: true }
        );
        if (ok) setExtraActive(res.data ?? null);
      } catch {
        if (ok) setExtraActive(null);
      }
    })();
    return () => {
      ok = false;
    };
  }, [memoId]);

  // ให้ตรงกับของแบ็กเอนด์ (approvers: [{ user: {id}, status?: {name}|null }])
  type ExtraLine = {
    id: number;
    status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "REJECTED";
    approvers: { user: { id: number }; status?: { name: string } | null }[];
  };

  // ✅ Type for extra approval lines with full details including comment
  type ExtraApprovalLineDTO = {
    id: number;
    status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "REJECTED";
    createdAt?: string;
    approvers: Array<{
      id: number;
      actedAt?: string | null;
      user: {
        id: number;
        name: string;
        lastname?: string | null;
        nickname?: string | null;
        profileImagePath?: string | null;
      };
      status?: { id: number; name: string } | null;
    }>;
    comment?: {
      id: number;
      comment: string;
      createdAt: string;
      user: {
        id: number;
        name: string;
        lastname?: string | null;
        nickname?: string | null;
      };
    } | null;
  };

  const isTerminal = useMemo(() => {
    const s = (statusLabel ?? "").toLowerCase();
    return s === "approved" || s === "terminated" || s === "recall";
  }, [statusLabel]);

  const hideExpiryCountdown = React.useMemo(
    () =>
      ["approved", "terminated"].includes((statusLabel ?? "").toLowerCase()),
    [statusLabel]
  );

  const canRenewExpiry = React.useMemo(() => {
    if (!memo?.expiresAt || !meId) return false;
    if (meId !== memo.userId) return false;
    const sl = (statusLabel ?? "").toLowerCase();
    return sl === "processing" || sl === "expired" || sl === "draft";
  }, [memo?.expiresAt, memo?.userId, meId, statusLabel]);

  const handleRenewExpiry = React.useCallback(async () => {
    if (!renewDate || !memoId) return;
    setRenewing(true);
    try {
      await api.post(`/api/memos/${memoId}/renew-expiry`, {
        expiresAt: renewDate.toISOString(),
        targetStatus: renewTargetStatus,
      });
      toast.success(t("renewExpiry.success"));
      setRenewOpen(false);
      setRenewDate(null);
      setRenewTargetStatus("Processing");
      onAfterAction?.();
    } catch (err: any) {
      const msg =
        err?.response?.data?.error ?? t("renewExpiry.fail");
      toast.error(msg);
    } finally {
      setRenewing(false);
    }
  }, [renewDate, renewTargetStatus, memoId, t, onAfterAction]);

  const myExtraWaiting = useMemo(() => {
    if (!extraActive || !meId || isTerminal) return false;
    const me = extraActive.approvers?.find((a) => a.user.id === meId);
    const isPending =
      !me?.status || me?.status?.name?.toUpperCase?.() === "WAITING";
    const lineOk = ["PENDING", "IN_PROGRESS"].includes(
      (extraActive.status ?? "").toUpperCase()
    );
    return !!me && isPending && lineOk;
  }, [extraActive, meId, isTerminal]);



  // รวม approvers ทุกคนให้เป็นแถวเดียว (เหมือน rows ใน Dashboard)
  const allApprovers = React.useMemo(
    () => approverGroups.flatMap((g) => g.users ?? []),
    [approverGroups]
  );

  // แทนบล็อก getWhen เดิม
  const safeMs = (iso?: string | null) => {
    if (!iso) return NaN;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : NaN;
  };

  const getWhen = (u: Approver) => {
    const t1 = safeMs(u.actedAt);
    const t2 = safeMs(u.since);
    const t = Number.isFinite(t1) ? t1 : t2;
    return Number.isFinite(t) ? t : -Infinity;
  };

  // หา currentLevel แบบเดียวกับ Dashboard
  const currentLevel = React.useMemo(() => {
    if (!allApprovers.length) {
      // ถ้าไม่มีข้อมูลเลย ลอง fallback ด้วย minWaitingLevel ก่อน
      return typeof minWaitingLevel === "number" ? minWaitingLevel : 0;
    }
    const terminated = allApprovers.filter((u) => u.status === "terminated");
    const rejected = allApprovers.filter((u) => u.status === "rejected");
    const waiting = allApprovers.filter((u) => u.status === "waiting");
    const approved = allApprovers.filter((u) => u.status === "approved");
    if (terminated.length) {
      // คนที่กด Terminated ล่าสุดคือตัว current
      const lastTerm = terminated.reduce(
        (best, cur) => (!best || getWhen(cur) > getWhen(best) ? cur : best),
        undefined as Approver | undefined
      )!;
      return lastTerm.level;
    }
    if (rejected.length) {
      // คนที่ reject ล่าสุด
      const lastRej = rejected.reduce(
        (best, cur) => (!best || getWhen(cur) > getWhen(best) ? cur : best),
        undefined as Approver | undefined
      )!;
      return lastRej.level;
    }

    if (waiting.length) {
      // เลเวลที่เล็กสุดของคิวปัจจุบัน
      return Math.min(...waiting.map((u) => u.level));
    }

    if (approved.length) {
      // เลเวลที่มากสุด (ไลน์จบแล้ว)
      return Math.max(...approved.map((u) => u.level));
    }

    // กรณี edge: ไม่มีสถานะข้างบนเลย
    return allApprovers[0].level ?? 0;
  }, [allApprovers, minWaitingLevel]);

  // helper กันค่าที่มาจาก string/number
  const toBool = (v: any, def = true) => {
    if (v === true || v === "true" || v === 1 || v === "1") return true;
    if (v === false || v === "false" || v === 0 || v === "0" || v == null)
      return false;
    return def;
  };

  // 1) set ของ userId ที่มี marker
  const sigUsers = React.useMemo(
    () =>
      new Set<number>(
        (memo?.signaturePositions ?? [])
          .map((p) => p.userId)
          .filter((x) => Number.isFinite(+x))
          .map((x) => +x)
      ),
    // ถ้า array ไม่มา ก็ผูกกับ length=0
    [memo?.id, (memo?.signaturePositions ?? []).length]
  );

  // ✅ Function to determine which approval level an extra line should appear after
  const getExtraLineInsertLevel = (extraLine: any): number => {
    if (!extraLine.createdAt) return -1;

    const extraCreatedTime = new Date(extraLine.createdAt).getTime();
    let insertAfterLevel = -1;

    for (const grp of approverGroups) {
      for (const user of grp.users ?? []) {
        if (user.status === "approved" && user.actedAt) {
          const userActedTime = new Date(user.actedAt).getTime();
          if (userActedTime < extraCreatedTime && grp.level > insertAfterLevel) {
            insertAfterLevel = grp.level;
          }
        }
      }
    }

    return insertAfterLevel;
  };

  // 2) enrich groups ให้มี hasSigMarkerForThisUser
  const groups = React.useMemo(
    () =>
      approverGroups.map((g) => ({
        ...g,
        users: (g.users ?? []).map((u) => ({
          ...u,
          hasSigMarkerForThisUser: sigUsers.has(+u.id),
        })),
      })),
    [approverGroups, sigUsers]
  );


  // ✅ Merge approval groups with extra approval lines
  const mergedItems = React.useMemo(() => {
    const items: Array<{
      type: "group" | "extra";
      level: number;
      data: any;
    }> = [];

    groups.forEach((grp) => {
      items.push({
        type: "group",
        level: grp.level,
        data: grp,
      });
    });

    extraLines.forEach((extraLine: any) => {
      const insertAfterLevel = getExtraLineInsertLevel(extraLine);
      const finalLevel = insertAfterLevel + 0.5;
      console.log("DEBUG: Extra line insert logic", {
        extraLineId: extraLine.id,
        insertAfterLevel,
        finalLevel,
        extraLine
      });
      items.push({
        type: "extra",
        level: finalLevel,
        data: extraLine,
      });
    });

    items.sort((a, b) => a.level - b.level);

    console.log("DEBUG: Merged items after sort", items);

    return items;
  }, [groups, extraLines, approverGroups]);

  return (
    <section className="shadow-lg rounded-lg space-y-4 overflow-hidden">
      {/* ===== Memo Details ===== */}
      <div>
        {/* ปุ่มบนมือถือ: ดู PDF - ABOVE expandable section (Mobile only) */}
        {showMobileActions && !isExpired && (
          <div className="md:hidden px-4 pt-4 pb-4">
            <button
              onClick={onOpenPdf}
              className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-xl bg-gradient-to-r from-blue-600 to-blue-700 text-white text-lg font-semibold shadow-lg hover:from-blue-700 hover:to-blue-800 active:scale-[0.98] transition-all duration-200"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className="w-6 h-6"
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
              {t("btnViewPdf")}
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowMemoDetails(!showMemoDetails)}
          className="w-full text-white bg-gradient-to-r from-[#183E33] to-[#1a4d3d] rounded-t-lg p-4 font-semibold flex items-center justify-between hover:from-[#145c4a] hover:to-[#16654f] transition-all duration-300 group shadow-md"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center group-hover:bg-white/20 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h2 className="text-lg">{t("section.memoDetails")}</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/70 hidden sm:inline">
              {showMemoDetails ? t("clickToHide", "Click to hide") : t("clickToShow", "Click to show")}
            </span>
            <svg
              className={`w-5 h-5 transition-transform duration-300 ${showMemoDetails ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>

        {showMemoDetails && (
          <>
            <div className="p-6 grid grid-cols-1 gap-2 animate-fadeIn">
              <DetailItem label={t("label.subject")} value={memo.subject} />
              <DetailItem label={t("label.memoNo")} value={memo.memonumber} />
              <DetailItem
                label={t("label.businessUnit")}
                value={memo.businessUnit?.name}
              />
              <DetailItem
                label={t("label.department")}
                value={memo.department?.name}
              />
              <DetailItem label={t("label.type")} value={memo.memoType?.name} />
              <DetailItem
                label={t("label.createdBy")}
                value={createdByLabel || "-"}
              />
              <DetailItem
                label={t("label.createdAt")}
                value={
                  memo.createdAt ? new Date(memo.createdAt).toLocaleString() : "-"
                }
              />

              {/* CC (รวมคน + กลุ่ม) */}
              <div className="flex gap-2 items-start">
                <span className="font-medium text-gray-600">
                  {t("label.cc", "CC")}:
                </span>
                <div className="flex-1">
                  <CcUnifiedList
                    users={ccUsers}
                    groups={ccGroups}
                    ccNameMap={ccNameMap}
                    displayNameFromId={displayNameFromId}
                  />
                </div>
              </div>

              {/* Status pill */}
              <div>
                <span className="font-medium text-gray-600">
                  {t("label.status")}
                </span>
                <span
                  className={`ml-2 px-3 py-1 rounded-full text-sm font-semibold ${statusPill[statusLabel] ?? "bg-gray-100 text-gray-700"
                    }`}
                >
                  {statusLabel}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <span className="font-medium text-gray-600">
                  {t("label.expiresAt", "วันหมดอายุ")}:
                </span>
              </div>

              {memo.expiresAt ? (
                hideExpiryCountdown ? (
                  // ซ่อนตัวนับเมื่อ Approved/Terminated
                  <span className="text-gray-500">-</span>
                ) : (
                  <ExpiryCountdown iso={memo.expiresAt} />
                )
              ) : (
                <span className="text-gray-500">-</span>
              )}

              {/* Renew Expiry button */}
              {canRenewExpiry && (
                <button
                  onClick={() => setRenewOpen(true)}
                  className="mt-2 px-3 py-1.5 text-sm font-medium rounded-lg bg-[#183E33] text-white hover:bg-[#145c4a] transition"
                >
                  {t("renewExpiry.btn")}
                </button>
              )}

              {/* Renew Expiry Modal */}
              <Modal
                open={renewOpen}
                title={t("renewExpiry.modalTitle")}
                onCancel={() => { setRenewOpen(false); setRenewDate(null); setRenewTargetStatus("Processing"); }}
                onOk={handleRenewExpiry}
                okText={t("renewExpiry.confirm")}
                cancelText={t("renewExpiry.cancel")}
                confirmLoading={renewing}
                okButtonProps={{ disabled: !renewDate }}
              >
                <p className="mb-3 text-gray-600">{t("renewExpiry.modalDesc")}</p>
                <DatePicker
                  showTime
                  value={renewDate}
                  onChange={(val) => setRenewDate(val)}
                  disabledDate={(current) => current && current.isBefore(dayjs(), "day")}
                  className="w-full"
                  placeholder={t("renewExpiry.pickDate")}
                />

                <p className="mt-4 mb-2 text-gray-600">{t("renewExpiry.statusLabel")}</p>
                <Select
                  value={renewTargetStatus}
                  onChange={(val) => setRenewTargetStatus(val)}
                  className="w-full"
                  options={[
                    { value: "Processing", label: t("renewExpiry.statusProcessing") },
                    { value: "Draft", label: t("renewExpiry.statusDraft") },
                  ]}
                />
              </Modal>
            </div>

            {/* ปุ่มบนมือถือ: ดู PDF + Terminate - INSIDE expandable section (Desktop only) */}
            {showMobileActions && !isExpired && (
              <div className="mt-3 hidden md:block px-4 space-y-3">

                {/* {canTerminate && (
              <button
                onClick={onTerminate}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-rose-600 text-white shadow-md hover:bg-rose-700 transition"
              >
                {t("btnTerminate")}
              </button>
            )} */}
              </div>
            )}
          </>
        )}
      </div>

      {/* ===== Approval Line ===== */}
      <div>
        <div className="bg-[#183E33] text-white p-3 font-semibold flex items-center justify-between">
          <h2>{t("section.approvalLine")}</h2>
          <button
            type="button"
            onClick={scrollToMyAction}
            disabled={!hasMyCard}
            className="inline-flex items-center gap-2 text-xs md:text-sm px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
            title={t("goToMyAction", "ไปยังปุ่มของฉัน")}
            aria-label={t("goToMyAction", "ไปยังปุ่มของฉัน")}
          >
            <SlArrowDown className="h-4 w-4" />
          </button>
        </div>

        <div className="bg-white p-5">
          {mergedItems.map((item, index) => {
            if (item.type === "group") {
              const grp = item.data as ApproverGroup;
              return (
                <div key={grp.level} className="mb-8 last:mb-0">
                  {/* Header ของระดับ */}
                  <div className="flex items-center gap-3 mb-4 p-2 border-b border-gray-200">
                    <h3 className="text-[#183E33] font-bold text-lg">
                      {t("approvalLevel", { level: grp.level + 1 })}
                    </h3>
                    <div className="bg-[#183E33] text-white w-8 h-8 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                      {grp.level + 1}
                    </div>
                  </div>

                  <ul className="space-y-4">
                    {grp.users.map((u) => {
                      const isDone = u.status === "approved";
                      const isApprovedWithCondition = isDone && !!u.approveWithCondition;
                      const isRejected = u.status === "rejected";
                      const isTerminator = u.status === "terminated";
                      const isWaiting = u.status === "waiting";
                      const isNotRequired = u.status === "not_required";

                      // Debug log for terminated users
                      if (isTerminator) {
                        console.log('[MemoAndApproval] Terminated user:', {
                          userId: u.id,
                          name: u.name,
                          status: u.status,
                          terminateReason: u.terminateReason,
                          hasTerminateReason: !!u.terminateReason,
                          fullUser: u
                        });
                      }

                      const rawIsSigReq =
                        u.isSigReq ??
                        (u as any).isSignatureRequired ??
                        (u as any).signatureRequired ??
                        (u as any).needSignature ??
                        (u as any).mustSign ??
                        (u as any).requireSignature;

                      const requiresSignature =
                        toBool(rawIsSigReq, true) &&
                        (u.hasSigMarkerForThisUser ?? false); // ← ไม่มี marker = ไม่ต้องเซ็น

                      const isNext =
                        !isTerminator &&
                        isInApproval &&
                        isWaiting &&
                        grp.level === minWaitingLevel &&
                        meId != null &&
                        meId === u.id;
                      const isMe = meId != null && meId === u.id;
                      const notStartedYet =
                        u.status === "waiting" && u.level > currentLevel;
                      const lastEventAt = memo.lastHistory?.timestamp;

                      // ✅ ถ้าเป็น waiting แล้วไม่มี since ให้ fallback เป็น lastEventAt
                      const displayISO = isWaiting
                        ? u.since ?? lastEventAt ?? memo.createdAt
                        : u.actedAt ?? lastEventAt ?? memo.createdAt;

                      const badge = perUserBadge[u.status] ?? perUserBadge.default;

                      return (
                        <li
                          key={u.loaUserPivotId}
                          className="relative overflow-hidden p-4 rounded-lg transition-all duration-200 hover:shadow-md flex flex-col gap-4 border-l-4" // NEW: relative+overflow-hidden
                          style={{
                            background: isNotRequired
                              ? "#F0FDF4"
                              : isTerminator
                                ? "#FEF2F2"
                                : isDone
                                  ? "#F0FDF4"
                                  : isRejected
                                    ? "#FFFAF0"
                                    : isWaiting
                                      ? "#EFF6FF"
                                      : "#fff",
                            borderColor: isNotRequired
                              ? "#22C55E"
                              : isTerminator
                                ? "#EF4444"
                                : isDone
                                  ? "#22C55E"
                                  : isRejected
                                    ? "#FF9966"
                                    : isWaiting
                                      ? "#93C5FD"
                                      : "#E5E7EB",
                          }}
                        >
                          {/* Level + Status badges + Name */}
                          <div className="flex flex-col gap-2 w-full">
                            {/* บรรทัดแรก: Level + Status badges (ขวา) */}
                            <div className="flex items-center justify-end gap-2 w-full">
                              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full whitespace-nowrap">
                                {t("label.level")}&nbsp;{u.level + 1}
                              </span>
                              <span
                                className={`text-xs px-2 py-1 rounded-full ${badge} whitespace-nowrap`}
                              >
                                {isNotRequired
                                  ? t("statusByUser.not_required")
                                  : isTerminator
                                    ? "Terminated"
                                    : isApprovedWithCondition
                                      ? "Approved With Conditions"
                                      : isDone
                                        ? "Approved"
                                        : isRejected
                                          ? "Rejected"
                                          : "Waiting"}
                              </span>
                            </div>

                            {/* บรรทัดที่สอง: ไอคอน + ชื่อ */}
                            <div className="flex items-center gap-4">
                              <div className="flex-shrink-0">
                                {isTerminator ? (
                                  <div className="p-2 bg-red-100 rounded-full">
                                    <svg
                                      xmlns="http://www.w3.org/2000/svg"
                                      className="h-5 w-5 text-red-600"
                                      viewBox="0 0 20 20"
                                      fill="currentColor"
                                    >
                                      <path
                                        fillRule="evenodd"
                                        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                                        clipRule="evenodd"
                                      />
                                    </svg>
                                  </div>
                                ) : isDone || isNotRequired ? (
                                  <div className="p-2 bg-green-100 rounded-full">
                                    <svg
                                      xmlns="http://www.w3.org/2000/svg"
                                      className="h-5 w-5 text-green-600"
                                      viewBox="0 0 20 20"
                                      fill="currentColor"
                                    >
                                      <path
                                        fillRule="evenodd"
                                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                        clipRule="evenodd"
                                      />
                                    </svg>
                                  </div>
                                ) : isRejected ? (
                                  <div className="p-2 bg-orange-100 rounded-full">
                                    <svg
                                      xmlns="http://www.w3.org/2000/svg"
                                      className="h-5 w-5 text-orange-500"
                                      viewBox="0 0 20 20"
                                      fill="currentColor"
                                    >
                                      <path
                                        fillRule="evenodd"
                                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                                        clipRule="evenodd"
                                      />
                                    </svg>
                                  </div>
                                ) : (
                                  <div className="p-2 bg-blue-100 rounded-full">
                                    <svg
                                      xmlns="http://www.w3.org/2000/svg"
                                      className="h-5 w-5 text-blue-500"
                                      viewBox="0 0 20 20"
                                      fill="currentColor"
                                    >
                                      <path
                                        fillRule="evenodd"
                                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                                        clipRule="evenodd"
                                      />
                                    </svg>
                                  </div>
                                )}
                              </div>
                              <p className="font-bold text-gray-800 break-words">
                                <UserLabel id={u.id} seed={u} />
                              </p>
                            </div>
                          </div>

                          {/* Show condition reason if approved with condition */}
                          {isApprovedWithCondition && u.approveWithCondition && (
                            <div className="mt-2 ml-4 pl-3 border-l-2 border-green-300 text-sm text-gray-700">
                              <span className="font-medium text-green-700">
                                {t("approvers.conditionReason", "Condition:")}
                              </span>{" "}
                              <span className="italic">{u.approveWithCondition}</span>
                            </div>
                          )}

                          {/* Show terminate reason if terminated */}
                          {isTerminator && u.terminateReason && (
                            <div className="mt-2 ml-4 pl-3 border-l-2 border-orange-300 text-sm text-gray-700">
                              <span className="font-medium text-orange-700">
                                {t("approvers.terminateReason", "Reason:")}
                              </span>{" "}
                              <span className="italic">{u.terminateReason}</span>
                            </div>
                          )}

                          {/* Show reject reason if rejected */}
                          {isRejected && u.rejectReason && (
                            <div className="mt-2 ml-4 pl-3 border-l-2 border-orange-300 text-sm text-gray-700">
                              <span className="font-medium text-orange-600">
                                {t("approvers.rejectReason", "Reason:")}
                              </span>{" "}
                              <span className="italic">{u.rejectReason}</span>
                            </div>
                          )}
                          <div className="mt-1 flex items-center gap-2 text-xs min-h-[1rem]">
                            <span className="inline-flex items-center opacity-70">
                              <svg
                                className="w-4 h-4 mr-1"
                                viewBox="0 0 20 20"
                                fill="currentColor"
                                aria-hidden="true"
                              ></svg>

                              {notStartedYet ? (
                                <span className="italic text-gray-400">&nbsp;</span>
                              ) : isNotRequired ? (
                                <span className="text-green-700 font-medium">
                                  {t("statusByUser.not_required")}
                                </span>
                              ) : (
                                <span className="text-gray-600 flex flex-wrap gap-1">
                                  <span className="whitespace-nowrap">
                                    {t(
                                      isWaiting
                                        ? "time.waitingSince"
                                        : isDone
                                          ? "time.approvedAt"
                                          : isRejected
                                            ? "time.rejectedAt"
                                            : isTerminator
                                              ? "time.terminatedAt"
                                              : "time.actedAt"
                                    )}
                                  </span>

                                  {/* absolute datetime (ตาม locale) */}
                                  <span className="whitespace-nowrap font-medium">
                                    {formatDateTime(displayISO)}
                                  </span>

                                  {/* relative time */}
                                  <span className="opacity-60">
                                    • {timeAgo(displayISO)}
                                  </span>
                                </span>
                              )}
                            </span>
                          </div>
                          {/* action */}
                          <div className="w-full">
                            <div
                              className="w-full"
                              ref={isMe ? myActionRef : undefined}
                              data-my-action-anchor={isMe ? "true" : undefined}
                            ></div>
                            {isNext && !blockedByExtra && !isExpired ? (
                              <div className="space-y-3">
                                {(() => {
                                  // ✅ ถ้าคุณมี hasSigMarkerForThisUser ให้ใช้ && รวมกันได้
                                  const requiresSignature =
                                    (u.isSigReq ?? true) &&
                                    (u.hasSigMarkerForThisUser ?? true);

                                  return (
                                    <>
                                      {/* ป้ายบอกว่าเคสนี้ไม่ต้องเซ็น */}
                                      {!requiresSignature && (
                                        <div className="rounded-md border border-blue-200 bg-blue-50 text-blue-800 text-xs px-3 py-2">
                                          {t(
                                            "approvers.noSigRequired",
                                            "ท่านมีสิทธิ์อนุมัติ แต่ไม่พบลายมือชื่อที่ต้องลงในเอกสารฉบับนี้"
                                          )}
                                        </div>
                                      )}

                                      {/* Approve */}
                                      <button
                                        onClick={() => {
                                          if (blockedByExtra || isExpired) {
                                            toast.error(
                                              isExpired
                                                ? t("expired", "หมดอายุแล้ว")
                                                : t(
                                                  "extra.busyError",
                                                  "มีไลน์อนุมัติเพิ่มเติมกำลังดำเนินการอยู่"
                                                )
                                            );
                                            return;
                                          }

                                          if (requiresSignature) {
                                            // Use parent handler
                                            onApprove(u.loaUserPivotId, true);
                                          } else {
                                            // Use parent handler
                                            onApprove(u.loaUserPivotId, false);
                                          }
                                        }}
                                        disabled={
                                          blockedByExtra || isExpired
                                        }
                                        className={`w-full px-5 py-3 text-sm font-medium rounded-lg shadow-sm
                  whitespace-normal break-words text-center leading-tight
                  transition-all duration-200
        ${blockedByExtra || isExpired
                                            ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                                            : "bg-green-700 text-white hover:bg-green-900 hover:shadow-md"
                                          }`}
                                      >
                                        {requiresSignature
                                          ? t("approvers.approve")
                                          : t(
                                            "approvers.approveNoSig",
                                            "อนุมัติโดยไม่ลงลายมือชื่อ"
                                          )}
                                      </button>

                                      {/* Approve With Condition */}
                                      <button
                                        onClick={() => {
                                          if (blockedByExtra || isExpired) {
                                            toast.error(
                                              isExpired
                                                ? t("expired", "หมดอายุแล้ว")
                                                : t(
                                                  "extra.busyError",
                                                  "มีไลน์อนุมัติเพิ่มเติมกำลังดำเนินการอยู่"
                                                )
                                            );
                                            return;
                                          }
                                          onApproveWithCondition(u.loaUserPivotId, requiresSignature);
                                        }}
                                        disabled={blockedByExtra || isExpired}
                                        className={`w-full px-5 py-3 text-sm font-medium rounded-lg shadow-sm
                  whitespace-normal break-words text-center leading-tight
                  transition-all duration-200
        ${blockedByExtra || isExpired
                                            ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                                            : "bg-amber-600 text-white hover:bg-amber-700 hover:shadow-md"
                                          }`}
                                      >
                                        {t("approvers.approveWithCondition", "Approve With Condition")}
                                      </button>

                                      {/* Need Revise & Terminate (กรณีไม่ใช่เจ้าของ) */}
                                      {(meId ?? 0) !== memo.userId && (
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-gray-200">
                                          <button
                                            onClick={async () => {
                                              if (blockedByExtra || isExpired) {
                                                toast.error(
                                                  isExpired
                                                    ? t("expired", "หมดอายุแล้ว")
                                                    : t(
                                                      "extra.busyError",
                                                      "มีไลน์อนุมัติเพิ่มเติมกำลังดำเนินการอยู่"
                                                    )
                                                );
                                                return;
                                              }
                                              setRejectingId(u.loaUserPivotId);
                                              try {
                                                await onReject(u.loaUserPivotId);
                                              } finally {
                                                setRejectingId(null);
                                              }
                                            }}
                                            disabled={
                                              blockedByExtra ||
                                              isExpired ||
                                              rejectingId === u.loaUserPivotId
                                            }
                                            className={`w-full min-w-0 px-5 py-2.5 text-sm font-medium rounded-lg shadow-sm
                      whitespace-normal break-words text-center leading-tight
                      transition-all duration-200
            ${blockedByExtra || isExpired
                                                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                                                : "bg-amber-500 text-white hover:bg-amber-600 hover:shadow-md"
                                              }
            disabled:opacity-60 disabled:cursor-not-allowed`}
                                          >
                                            {rejectingId === u.loaUserPivotId
                                              ? t("approvers.processing")
                                              : t(
                                                "btnNeedRevise",
                                                "ต้องให้ปรับปรุงเอกสาร"
                                              )}
                                          </button>

                                          {canTerminate && (
                                            <button
                                              onClick={() => {
                                                if (blockedByExtra || isExpired) {
                                                  toast.error(
                                                    isExpired
                                                      ? t("expired", "หมดอายุแล้ว")
                                                      : t(
                                                        "extra.busyError",
                                                        "มีไลน์อนุมัติเพิ่มเติมกำลังดำเนินการอยู่"
                                                      )
                                                  );
                                                  return;
                                                }
                                                setTerminateModalOpen(true);
                                              }}
                                              disabled={
                                                blockedByExtra ||
                                                isExpired ||
                                                terminating
                                              }
                                              className="w-full min-w-0 px-5 py-2.5 text-sm font-medium rounded-lg shadow-sm
                       whitespace-normal break-words text-center leading-tight
                       transition-all duration-200
                       bg-rose-600 text-white hover:bg-rose-700 hover:shadow-md
                       disabled:opacity-60 disabled:cursor-not-allowed"
                                            >
                                              {terminating
                                                ? t("approvers.processing")
                                                : t("btnTerminate")}
                                            </button>
                                          )}
                                        </div>
                                      )}

                                      {/* Terminate button removed for owner — owner should not terminate their own memo */}
                                    </>
                                  );
                                })()}
                              </div>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            } else {
              const extraLine = item.data;
              return (
                <ExtraApprovalCard
                  key={`extra-${extraLine.id}`}
                  extraLine={extraLine}
                  prettyTime={(iso: string) => timeAgo(iso)}
                  formatFullName={formatFullName}
                  Avatar={Avatar}
                  meId={meId}
                  isExpired={isExpired}
                  onApprove={handleExtraApprove}
                  onReject={handleExtraReject}
                />
              );
            }
          })}
        </div>
      </div>


      <TerminateReasonModal
        isOpen={terminateModalOpen}
        onClose={() => setTerminateModalOpen(false)}
        onConfirm={async (reason) => {
          try {
            setTerminating(true);
            await onTerminate(reason);
          } finally {
            setTerminating(false);
          }
        }}
      />
    </section>
  );
};
export default MemoAndApproval;
