// src/component/CommentSection.tsx
import React, { useCallback, useEffect, useRef, useState } from "react";

import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { PaperClipIcon } from "@heroicons/react/24/outline";
import { AiFillFilePdf, AiOutlineCloudUpload } from "react-icons/ai";
import { AnimatePresence, motion } from "framer-motion";
import { api } from "../../lib/api";
import { toSecureUploadUrl } from "../../lib/files";
import { FiSearch, FiX, FiClock, FiEye } from "react-icons/fi";
import { FaUserPlus } from "react-icons/fa";
import PdfOverlay from "./PdfOverlay";
import { ExtraApprovalCard } from "./ExtraApprovalCard";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowsRotate } from "@fortawesome/free-solid-svg-icons";

type Attachment = {
  id: number;
  url: string;
  filename: string;
  mimetype: string;
};

type Comment = {
  id: number;
  comment: string;
  isRecallExtra: boolean;
  ExtraUserid?: number | null;
  ExtraStatus?: string | null;
  extraApprovalLineId?: number | null;
  extraUser?: {
    name: string;
    lastname?: string | null;
    nickname?: string | null;
  } | null;
  createdAt: string;
  user: {
    id: number;
    name: string;
    profileImage: string | null;
    lastname?: string | null;
    nickname?: string | null;
  };
  attachments?: Attachment[];
  expiresAt?: string | null;
  hasMentions?: boolean; // ✅ Added to track if comment has mention tags
  tags?: {
    id: number;
    name: string;
    lastname?: string | null;
    nickname?: string | null;
  }[]; // ✅ List of mentioned users from backend
};

type MentionUser = {
  id: number;
  name: string;
  lastname?: string | null;
  nickname?: string | null;
  email: string;
  profileImageUrl?: string | null;
};

type Props = {
  memoId: number | undefined;
  meId: number | null;
  meProfileImagePath?: string | null;

  // ⬇️ NEW
  canCreateExtraLine?: boolean; // มีสิทธิ์สร้าง Extra line ไหม (owner หรือ approver ณ min level)
  onExtraBusyChange?: (busy: boolean) => void; // แจ้ง parent เพื่อปิดปุ่มอนุมัติหลัก (optional)
  refreshSignal?: number;
  expiresAt?: string | null;
  onCountChange?: (n: number) => void;
  hideExtraButton?: boolean;
  isReferenceMode?: boolean; // Hide comment input when viewing as reference
  isProcessing?: boolean; // ⬇️ NEW: Memo is in Processing status (statusId = 5)

  // ⬇️ NEW: For checking if "me" is mentioned
  meName?: string | null;
  meLastname?: string | null;
  meNickname?: string | null;
};

// ---- Extra-approval helpers ----
type ExtraApproverDTO = {
  id: number;
  actedAt?: string | null; // ✅ เพิ่ม
  user: {
    id: number;
    name: string;
    lastname?: string | null;
    nickname?: string | null;
    profileImagePath?: string | null;
  };
  status?: { id: number; name: string } | null; // null = waiting
};

type ExtraApprovalLineDTO = {
  id: number;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "REJECTED";
  createdById: number;
  approvers: ExtraApproverDTO[];
  createdAt?: string; // ✅ เพิ่มเพื่อให้ sorted timeline ได้
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

// ดึง extra lines ทั้งหมด (หลายการ์ด)
async function fetchAllExtraLines(memoId: number) {
  const { data } = await api.get<ExtraApprovalLineDTO[]>(
    `/api/memos/${memoId}/extra-approval-lines`,
    {
      params: { _t: Date.now() },
      withCredentials: true,
    },
  );
  return data;
}

// ✅ รับ preApprovedUsers พร้อม actedAt เพื่อ preserve เวลา approved เดิม
async function createExtraLine(
  memoId: number,
  userIds: number[],
  preApprovedUsers: { userId: number; actedAt: string | null }[] = [],
  comment?: string, // ✅ เพิ่ม comment parameter
) {
  const { data } = await api.post<ExtraApprovalLineDTO>(
    `/api/memos/${memoId}/extra-approval-lines`,
    { userIds, preApprovedUsers, comment }, // ✅ ส่ง comment ไปด้วย
    { withCredentials: true },
  );
  return data;
}

async function actExtra(
  memoId: number,
  lineId: number,
  statusCode: "approved" | "rejected",
) {
  const { data } = await api.post(
    `/api/memos/${memoId}/extra-approval-lines/${lineId}/action`,
    { statusCode },
    { withCredentials: true },
  );
  return data;
}

// ✅ API ลบ Extra line
async function removeExtraLine(memoId: number, lineId: number) {
  const { data } = await api.delete(
    `/api/memos/${memoId}/extra-approval-lines/${lineId}`,
    { withCredentials: true },
  );
  return data;
}

// ✅ API ลบ Comment
async function deleteCommentApi(commentId: number) {
  const { data } = await api.delete(`/api/comments/${commentId}`, {
    withCredentials: true,
  });
  return data;
}

// ✅ เลือก locale จาก i18n ถ้าไม่มีใช้ของเบราว์เซอร์
const pickLocale = (lng?: string) =>
  (lng && (lng.toLowerCase().startsWith("th") ? "th-TH" : lng)) ||
  navigator.language ||
  "en-US";

const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const formatAbsolute = (d: Date, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

// ถ้ามี RelativeTimeFormat ก็แปลงเป็น "x นาทีที่แล้ว"

const formatRelative = (from: Date, to: Date, locale: string) => {
  const rtf =
    (Intl as any).RelativeTimeFormat &&
    new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diffSec = Math.round((from.getTime() - to.getTime()) / 1000); // from - now (ค่าเป็นลบ)
  const abs = Math.abs(diffSec);

  const unitTable: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ];

  if (!rtf) return null; // ไม่มี RTF ให้ไปใช้ calendar-style แทนด้านล่าง

  for (const [unit, sec] of unitTable) {
    if (abs >= sec || unit === "second") {
      const value = Math.round(diffSec / sec);
      return rtf.format(value, unit);
    }
  }
  return null;
};

// แสดงสไตล์ calendar: วันนี้/เมื่อวาน/อย่างอื่น
const formatCalendar = (date: Date, locale: string, t: any) => {
  const now = new Date();
  const absText = formatAbsolute(date, locale);

  if (isSameDay(date, now)) {
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
    return t("time.todayAt", "วันนี้ {{time}}", { time });
  }
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (isSameDay(date, y)) {
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
    return t("time.yesterdayAt", "เมื่อวาน {{time}}", { time });
  }
  return absText;
};

// รวม logic: ถ้าไม่เกิน 24 ชม. พยายามใช้ relative, ถ้าไม่มีให้ใช้ calendar-style
const prettyTime = (iso: string, locale: string, t: any) => {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();

  // < 5 วินาที → "เมื่อกี้"
  if (diffMs < 5000) return t("time.justNow", "เมื่อสักครู่นี้");

  // < 24 ชั่วโมง → relative ถ้าใช้ได้
  if (diffMs < 24 * 60 * 60 * 1000) {
    const rel = formatRelative(d, now, locale);
    if (rel) return rel; // เช่น "5 minutes ago" / "5 นาทีที่แล้ว"
    return formatCalendar(d, locale, t); // fallback
  }

  // ≥ 24 ชั่วโมง → calendar/absolute
  return formatCalendar(d, locale, t);
};

const formatMentionLabel = (u: MentionUser) => {
  const full = [u.name, u.lastname].filter(Boolean).join(" ");
  return u.nickname ? `${full}(${u.nickname})` : full;
};

// --- helpers: ฟอร์แมตชื่อให้เป็น "ชื่อ นามสกุล (ชื่อเล่น)" ---
const formatFullName = (u?: any) => {
  if (!u) return "";
  const ln = u.lastname ?? u.lastName ?? "";
  const nn = u.nickname ?? u.nickName ?? "";
  const base = [u.name, ln].filter(Boolean).join(" ").trim();
  return nn ? `${base} (${nn})` : base || u.name || "";
};

// ดึง basic-info ถ้า seed ไม่มี ln/nick
const useUserDisplayName = (id?: number, seed?: any) => {
  const cacheRef = React.useRef<Map<number, string>>(new Map());
  const [label, setLabel] = React.useState<string>(() => formatFullName(seed));

  React.useEffect(() => {
    if (!id) return;

    // จาก cache
    const cached = cacheRef.current.get(id);
    if (cached) {
      setLabel(cached);
      return;
    }

    // ถ้า seed มี ln/nick ครบ ใช้เลย + แคช
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

    // โหลดจาก backend
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

// คอมโพเนนต์เล็ก ๆ สำหรับเรนเดอร์ชื่อ
const UserLabel: React.FC<{ id?: number; seed?: any; className?: string }> = ({
  id,
  seed,
  className,
}) => {
  const label = useUserDisplayName(id, seed);
  return <span className={className}>{label || seed?.name || "-"}</span>;
};

interface CommentSectionProps {
  memoId: number;
  meId: number;
  meProfileImagePath: string | null;
  canCreateExtraLine?: boolean;
  onExtraBusyChange?: (isBusy: boolean) => void;
  expiresAt?: string | null;
  onCountChange?: (count: number) => void;
  hideExtraButton?: boolean;
  isReferenceMode?: boolean;
  isProcessing?: boolean;
  meName?: string;
  meLastname?: string;
  meNickname?: string;
  onDirtyChange?: (isDirty: boolean) => void; // New prop
}

const CommentSection: React.FC<CommentSectionProps> = ({
  memoId,
  meId,
  meProfileImagePath,
  canCreateExtraLine = false,
  hideExtraButton = false,
  onExtraBusyChange,
  onCountChange,
  expiresAt,
  meName,
  meLastname,
  meNickname,
  isProcessing = false,
  onDirtyChange,
}) => {
  const { t, i18n } = useTranslation("memoViewer"); // เดิมมี t อยู่แล้ว
  const [_, forceTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => forceTick((v) => v + 1), 60 * 1000);
    return () => clearInterval(h);
  }, []);
  // ───────── local state ─────────
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState("");
  // ✅ Attachments (Multiple)
  const [attachments, setAttachments] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  // Clean up object URLs on unmount only (not on change)
  useEffect(() => {
    return () => {
      // Cleanup all URLs when component unmounts
      previewUrls.forEach((u) => {
        if (u.startsWith("blob:")) {
          URL.revokeObjectURL(u);
        }
      });
    };
  }, []); // Empty dependency array - only run on unmount

  // Create blob URLs when attachments change
  useEffect(() => {
    // Revoke old URLs that are no longer needed
    const currentUrls = new Set(previewUrls);
    const newUrls = attachments.map((f, i) => {
      // Reuse existing URL if file hasn't changed
      if (previewUrls[i] && attachments[i] === f) {
        return previewUrls[i];
      }
      // Create new URL for new file
      return URL.createObjectURL(f);
    });

    // Revoke URLs that are no longer in use
    previewUrls.forEach((url) => {
      if (url.startsWith("blob:") && !newUrls.includes(url)) {
        URL.revokeObjectURL(url);
      }
    });

    setPreviewUrls(newUrls);
  }, [attachments]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") !== -1) {
        const f = items[i].getAsFile();
        if (f) pastedFiles.push(f);
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      setAttachments((prev) => {
        const combined = [...prev, ...pastedFiles];
        if (combined.length > 6) {
          toast.error("A maximum of 6 items can be attached.");
          return combined.slice(0, 6);
        }
        return combined;
      });
    }
  }, []);

  // ✅ Drag & Drop
  const [isDragging, setIsDragging] = useState(false);

  // Track dirty state
  useEffect(() => {
    if (onDirtyChange) {
      const isDirty = newComment.trim().length > 0 || attachments.length > 0;
      onDirtyChange(isDirty);
    }
  }, [newComment, attachments, onDirtyChange]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (
      e.dataTransfer.types &&
      Array.from(e.dataTransfer.types).includes("Files")
    ) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Check if we are dragging leaving to a child element
    if (e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    // Filter allowed types
    const validFiles = files.filter(
      (f) => f.type.startsWith("image/") || f.type === "application/pdf",
    );

    if (validFiles.length > 0) {
      setAttachments((prev) => {
        const combined = [...prev, ...validFiles];
        if (combined.length > 6) {
          toast.error("A maximum of 6 items can be attached.");
          return combined.slice(0, 6);
        }
        return combined;
      });
    } else if (files.length > 0) {
      toast.error("Only images and PDF files are allowed.");
    }
  }, []);

  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewPdf, setPreviewPdf] = useState<string | null>(null);
  const [pdfLoadError, setPdfLoadError] = useState(false);
  const [pdfReloadKey, setPdfReloadKey] = useState(0);

  // ฟังก์ชันดาวน์โหลดไฟล์ที่อ่าน Content-Disposition header
  const handleDownloadAttachment = async (att: { url: string; filename: string }) => {
    try {
      const response = await fetch(att.url, {
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error('Download failed');
      }
      
      // อ่านชื่อไฟล์จาก Content-Disposition header
      const contentDisposition = response.headers.get('content-disposition');
      let filename = att.filename;
      
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
  const containerRef = useRef<HTMLDivElement>(null);

  // --- mention modal ---
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [candidates, setCandidates] = useState<MentionUser[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const mentionInputRef = useRef<HTMLInputElement | null>(null);
  // ───────── extra-approval picker ─────────
  const [extraOpen, setExtraOpen] = useState(false);
  const [extraQuery, setExtraQuery] = useState("");
  const [extraCandidates, setExtraCandidates] = useState<MentionUser[]>([]);
  // ✅ เปลี่ยนจาก single line เป็น array เพื่อแสดงหลายการ์ด
  const [extraLines, setExtraLines] = useState<ExtraApprovalLineDTO[]>([]);

  // Confirmation dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean;
    title?: string;
    message: string;
    btnConfirm?: string;
    btnCancel?: string;
    showCommentInput?: boolean;
    commentPlaceholder?: string;
    isLoading?: boolean;
    danger?: boolean;
    onConfirm: (comment?: string) => void;
  }>({
    show: false,
    message: "",
    onConfirm: () => {},
  });

  // Comment text for confirmation dialog
  const [dialogCommentText, setDialogCommentText] = useState("");

  // ✅ Derived: หา active line ล่าสุด (PENDING/IN_PROGRESS)
  const extraActive =
    extraLines.find(
      (l) => l.status === "PENDING" || l.status === "IN_PROGRESS",
    ) || null;

  // ✅ Derived: เช็คว่า user ปัจจุบันต้อง approve ใน active line ไหม
  const myExtraRow = extraActive?.approvers.find((a) => a.user.id === meId);
  const myExtraWaiting = !!myExtraRow && !myExtraRow.status;
  const [mentions, setMentions] = useState<MentionUser[]>([]);
  const [extraLoading, setExtraLoading] = useState(false);
  const [chatModalOpen, setChatModalOpen] = useState(false);
  const selRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const extraInputRef = React.useRef<HTMLInputElement | null>(null);

  const rememberSelection: React.FormEventHandler<HTMLTextAreaElement> = (
    e,
  ) => {
    const el = e.currentTarget;
    selRef.current = {
      start: el.selectionStart ?? 0,
      end: el.selectionEnd ?? 0,
    };
  };

  // Update selection on cursor movement
  const updateSelection = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    selRef.current = {
      start: el.selectionStart ?? 0,
      end: el.selectionEnd ?? 0,
    };
  };
  const isExpired = React.useMemo(() => {
    if (!expiresAt) return false;
    const t = Date.parse(expiresAt);
    return Number.isFinite(t) ? t <= Date.now() : false;
  }, [expiresAt]);

  const closeMention = () => {
    setMentionOpen(false);
    setCandidates([]);
    setMentionQuery("");
  };

  // ✅ ฟังก์ชันค้นหาสำหรับ mention (อัปเดต state `candidates`)
  const fetchMentionCandidates = React.useCallback(async (q: string) => {
    try {
      const { data } = await api.get<MentionUser[]>(
        `/api/users/search?q=${encodeURIComponent(q)}&limit=10`,
        { withCredentials: true },
      );
      setCandidates(data);
    } catch {
      setCandidates([]);
    }
  }, []);

  const fetchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const amIMentioned = React.useMemo(() => {
    if (!meId || !meName) return false;
    const label = formatMentionLabel({
      id: meId,
      name: meName,
      lastname: meLastname,
      profileImageUrl: null,
      email: "",
      nickname: meNickname,
    });
    return comments.some((c) => c.comment.includes(label));
  }, [comments, meId, meName, meLastname, meNickname]);

  // Handle mention dialog input changes (not used in inline mode)
  const handleMentionInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    // This function is kept for compatibility but not used in inline mode
    const query = e.target.value;
    setMentionQuery(query);

    if (fetchTimer.current) clearTimeout(fetchTimer.current);
    fetchTimer.current = setTimeout(() => {
      const trimmed = query.trim();
      if (trimmed) {
        fetchMentionCandidates(trimmed);
      } else {
        setCandidates([]);
      }
    }, 180);
  };

  const onMentionQueryChange: React.ChangeEventHandler<HTMLInputElement> =
    handleMentionInput;

  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Enhanced mention application
  const performApplyMentionCandidate = (user: MentionUser) => {
    const currentText = newComment;
    const mentionLabel = "@" + formatMentionLabel(user);

    // Use mentionQuery state to find the @query pattern
    // mentionQuery contains what user typed after @ (e.g., "boss")
    const query = mentionQuery;
    const searchPattern = "@" + query;

    // Find the pattern in the text
    const atIndex = currentText.lastIndexOf(searchPattern);

    let newText: string;

    if (atIndex !== -1) {
      // Found the @query pattern - replace it with the mention
      const beforeAt = currentText.slice(0, atIndex);
      const afterQuery = currentText.slice(atIndex + searchPattern.length);
      newText = beforeAt + mentionLabel + " " + afterQuery;
    } else {
      // Fallback: find just @ and replace from there to the end of the word
      const lastAt = currentText.lastIndexOf("@");
      if (lastAt !== -1) {
        // Find the end of the word after @
        let endPos = lastAt + 1;
        while (
          endPos < currentText.length &&
          currentText[endPos] !== " " &&
          currentText[endPos] !== "\n"
        ) {
          endPos++;
        }
        const beforeAt = currentText.slice(0, lastAt);
        const afterQuery = currentText.slice(endPos);
        newText = beforeAt + mentionLabel + " " + afterQuery;
      } else {
        // No @ found at all - just append the mention
        newText = currentText + " " + mentionLabel + " ";
      }
    }

    // Update React state
    setNewComment(newText);

    // Add to mentions list for backend
    setMentions((prev) =>
      prev.some((x) => x.id === user.id) ? prev : [...prev, user],
    );

    closeMention();

    // Set cursor position after the mention
    requestAnimationFrame(() => {
      if (taRef.current) {
        const mentionStartPos = newText.indexOf(mentionLabel);
        const newCursorPos =
          mentionStartPos !== -1
            ? mentionStartPos + mentionLabel.length + 1
            : newText.length;
        taRef.current.focus();
        taRef.current.setSelectionRange(newCursorPos, newCursorPos);
        selRef.current = { start: newCursorPos, end: newCursorPos };
        autoResize();
      }
    });
  };

  const applyMentionCandidate = (user: MentionUser) => {
    const name = formatMentionLabel(user);
    setConfirmDialog({
      show: true,
      title: t("mention.confirmTitle", "Confirm Mention"),
      message: t("mention.confirmMessage", { name }),
      btnConfirm: t("mention.btnConfirm", "Confirm"),
      btnCancel: t("mention.btnCancel", "Cancel"),
      showCommentInput: false,
      onConfirm: () => {
        setConfirmDialog((prev) => ({ ...prev, show: false }));
        setDialogCommentText("");
        performApplyMentionCandidate(user);
      },
    });
  };

  const applyCandidate = applyMentionCandidate;

  const onMentionKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (
    e,
  ) => {
    if (e.key === "ArrowDown" && candidates.length) {
      e.preventDefault();
      setActiveIdx((v) => (v + 1) % candidates.length);
    } else if (e.key === "ArrowUp" && candidates.length) {
      e.preventDefault();
      setActiveIdx((v) => (v - 1 + candidates.length) % candidates.length);
    } else if (e.key === "Enter" && candidates.length) {
      e.preventDefault();
      applyCandidate(candidates[activeIdx]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
    }
  };

  // ───────── data ─────────

  const fetchComments = useCallback(async () => {
    if (!memoId) return;
    try {
      const res = await api.get<Comment[]>(`/api/memos/${memoId}/comments`, {
        withCredentials: true,
      });
      const items = res.data.map((c) => ({
        ...c,
        user: {
          ...c.user,
          lastname:
            (c.user as any).lastname ?? (c.user as any).lastName ?? null,
          nickname:
            (c.user as any).nickname ?? (c.user as any).nickName ?? null,
          // รองรับได้ทั้ง profileImage / profileImageUrl / profileImagePath ที่แบ็กเอนด์อาจส่งมา
          profileImage: toSecureUploadUrl(
            (c.user as any).profileImage ??
              (c.user as any).profileImageUrl ??
              (c.user as any).profileImagePath,
          ),
        },
        attachments: (c.attachments ?? []).map((att) => ({
          ...att,
          url: toSecureUploadUrl(att.url),
        })),
      }));
      setComments(items);
      onCountChange?.(items.length);
    } catch {
      toast.error(t("comment.loadFailed", "Failed to load comments"));
    }
  }, [memoId, t]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  useEffect(() => {
    onCountChange?.(comments.length);
  }, [comments.length, onCountChange]);
  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      // กระโดดไปด้านล่างทันที ไม่มี smooth scroll
      el.scrollTop = el.scrollHeight;
    }
  }, [comments, extraLines]);
  // ✅ ดึง extra lines ทั้งหมด (หลายการ์ด)
  const refreshExtraLines = async () => {
    if (!memoId) return;
    try {
      const lines = await fetchAllExtraLines(memoId);
      setExtraLines(lines);
    } catch (error) {
      console.error("Failed to refresh extra lines", error);
    }
  };

  useEffect(() => {
    refreshExtraLines();
  }, [memoId]);

  // แจ้ง parent ให้ปิดปุ่มอนุมัติหลัก (กัน 409) เมื่อ Extra line ทำงานอยู่
  useEffect(() => {
    const busy =
      !!extraActive &&
      (extraActive.status === "PENDING" ||
        extraActive.status === "IN_PROGRESS");
    onExtraBusyChange?.(busy);
  }, [extraActive, onExtraBusyChange]);

  const handleAdd = async () => {
    if (!meId || !memoId) return;

    // Retain @ for proper highlighting of mentions
    const text = newComment.trim();
    if (!text && attachments.length === 0) return;

    // ✅ ดึงเฉพาะ mentions ที่ “ยังมีอยู่จริง” ในข้อความไว้ก่อน เพื่อเอาไปใส่ล่วงหน้า
    const activeMentions = mentions.filter((u) => {
      const label = "@" + formatMentionLabel(u);
      const re = new RegExp(`(^|\\s)${escapeRe(label)}(\\s|$)`, "i");
      return re.test(text);
    });

    // — Optimistic UI (ของเดิม) —
    const tempId = Date.now();
    const tempComment: Comment = {
      id: tempId,
      comment: text,
      isRecallExtra: false,
      createdAt: new Date().toISOString(),
      user: {
        id: meId,
        name: "You",
        profileImage: toSecureUploadUrl(meProfileImagePath ?? null),
      },
      attachments: previewUrls.map((u, i) => ({
        id: -1 - i,
        url: u,
        filename: attachments[i].name,
        mimetype: attachments[i].type,
      })),
      hasMentions: activeMentions.length > 0,
      tags: activeMentions.map((u) => ({
        id: u.id,
        name: u.name,
        lastname: u.lastname,
        nickname: u.nickname,
      })),
    };
    setComments((prev) => [...prev, tempComment]);
    setNewComment("");
    setAttachments([]); // Clear inputs

    // กระโดดไปด้านล่างทันที ไม่มี animation
    setTimeout(() => {
      const el = containerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }, 50);

    const activeMentionIds = activeMentions.map((u) => u.id);

    const form = new FormData();
    form.append("userId", String(meId));
    form.append("content", text);
    if (activeMentionIds.length) {
      form.append("mentionUserIds", JSON.stringify(activeMentionIds));
    }
    // Append all files
    attachments.forEach((file) => {
      form.append("files", file);
    });

    try {
      const res = await api.post<Comment & { attachments: Attachment[] }>(
        `/api/memos/${memoId}/comments`,
        form,
        {
          headers: { "Content-Type": "multipart/form-data" },
          withCredentials: true,
        },
      );

      const saved = res.data as any;
      const normalized: Comment = {
        ...saved,
        user: {
          ...saved.user,
          lastname:
            (saved.user as any).lastname ??
            (saved.user as any).lastName ??
            null,
          nickname:
            (saved.user as any).nickname ??
            (saved.user as any).nickName ??
            null,
          profileImage: toSecureUploadUrl(
            saved?.user?.profileImage ??
              saved?.user?.profileImageUrl ??
              saved?.user?.profileImagePath,
          ),
        },
        attachments: (saved.attachments ?? []).map((att: Attachment) => ({
          ...att,
          url: toSecureUploadUrl(att.url),
        })),
        hasMentions: saved.hasMentions ?? activeMentions.length > 0,
        tags:
          saved.tags ??
          activeMentions.map((u) => ({
            id: u.id,
            name: u.name,
            lastname: u.lastname,
            nickname: u.nickname,
          })),
      };

      setComments((prev) =>
        prev.map((c) => (c.id === tempId ? normalized : c)),
      );

      // ✅ ส่งสำเร็จแล้วเคลียร์รายการ mention
      setMentions([]);
    } catch (err: any) {
      console.error("Failed to send comment:", err);

      // Provide specific error messages
      let errorMessage = t("comment.sendFailed", "Failed to send comment");

      if (err?.response?.status === 401) {
        errorMessage = t(
          "error.noPermission",
          "You don't have permission to perform this action.",
        );
      } else if (err?.response?.status === 413) {
        errorMessage = "File size too large. Maximum 50MB per file.";
      } else if (err?.response?.data?.error) {
        errorMessage = err.response.data.error;
      }

      toast.error(errorMessage);
      setComments((prev) => prev.filter((c) => c.id !== tempId));
    }
  };

  // === Avatar (แบบเดียวกับหน้าอื่น) ===
  const getInitials = (name?: string | null) =>
    (name ?? "U")
      .split(" ")
      .filter(Boolean)
      .map((n) => n[0]!.toUpperCase())
      .slice(0, 2)
      .join("") || "U";

  const dicebearUrl = (seed: string | number) =>
    `https://api.dicebear.com/7.x/personas/svg?seed=${encodeURIComponent(
      String(seed),
    )}`;

  const Avatar: React.FC<{
    name?: string | null;
    src?: string | null;
    userId?: number | null;
    sizeClass?: string; // เช่น "w-8 h-8"
    className?: string;
  }> = ({ name, src, userId, sizeClass = "w-8 h-8", className = "" }) => {
    // src ในหน้านี้ถูก normalize ด้วย toSecureUploadUrl แล้วเป็นส่วนใหญ่
    const initialSrc = React.useMemo(
      () => (src ? toSecureUploadUrl(src) : null),
      [src],
    );
    const [imgSrc, setImgSrc] = React.useState<string | null>(initialSrc);
    const [failCount, setFailCount] = React.useState(0);

    const handleError = () => {
      setFailCount((f) => {
        const next = f + 1;
        if (next === 1)
          setImgSrc("/img/default-avatar.png"); // ขั้นที่ 1
        else if (next === 2)
          setImgSrc(dicebearUrl(userId ?? name ?? "user")); // ขั้นที่ 2
        else setImgSrc(null); // ขั้นสุดท้าย → แสดงตัวอักษรย่อ
        return next;
      });
    };

    // ขั้นสุดท้าย: วงกลมพื้นหลังไล่สี + ตัวอักษรย่อ
    if (!imgSrc) {
      return (
        <div
          className={`${sizeClass} rounded-full bg-gradient-to-r from-[#00ffaa] to-[#00cc88] flex items-center justify-center font-bold text-gray-900 ${className}`}
          title={name ?? undefined}
          aria-label={name ?? "avatar"}
        >
          {getInitials(name)}
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

  const renderWithHighlights = (raw: string, tags?: Comment["tags"]) => {
    if (!tags || tags.length === 0) return raw; // Optimization map empty strings

    const parts: React.ReactNode[] = [];
    let last = 0;

    // Get all valid mention strings from tags
    const validMentionLabels = tags.map(
      (tag) =>
        "@" +
        formatMentionLabel({
          id: tag.id || 0,
          name: tag.name,
          lastname: tag.lastname,
          nickname: tag.nickname,
          email: "",
          profileImageUrl: null,
        }),
    );

    // Sort by length descending, so we check longer names first to avoid partial matches
    validMentionLabels.sort((a, b) => b.length - a.length);

    // Build a regex to match ONLY these exact labels
    // We use word boundaries or spaces to ensure we don't match inside a larger word
    const reSource = validMentionLabels.map(escapeRe).join("|");
    if (!reSource) return raw;

    const re = new RegExp(`(${reSource})`, "g");

    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const matchText = m[1];

      if (m.index > last) {
        parts.push(raw.slice(last, m.index));
      }

      parts.push(
        <span
          key={`${m.index}-${matchText}`}
          className="px-1.5 py-0.5 mx-0.5 rounded-md bg-emerald-100 text-emerald-800 font-medium inline-block align-baseline"
        >
          {matchText}
        </span>,
      );

      last = re.lastIndex;
    }

    if (last < raw.length) {
      parts.push(raw.slice(last));
    }

    return <>{parts}</>;
  };

  const fetchExtraCandidates = useCallback(
    async (q: string) => {
      if (!memoId) return setExtraCandidates([]);
      try {
        const url = extraActive?.id
          ? `/api/memos/${memoId}/extra-approval-lines/${extraActive.id}/eligible-users`
          : `/api/memos/${memoId}/extra-approval-lines/eligible-users`;

        const { data } = await api.get(url, {
          params: { q },
          withCredentials: true,
        });

        setExtraCandidates(
          (data ?? []).map((u: any) => ({
            id: u.id,
            name: u.name,
            lastname: u.lastname ?? null,
            nickname: u.nickname ?? null,
            email: u.email,
            profileImageUrl: u.profileImagePath
              ? `/uploads/profiles/${u.profileImagePath}`
              : null,
          })),
        );
      } catch {
        setExtraCandidates([]);
      }
    },
    [memoId, extraActive?.id],
  );

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    // กด Enter ปกติ (ไม่กด Shift) = ส่ง comment
    if (e.key === "Enter" && !e.shiftKey && !mentionOpen) {
      e.preventDefault();
      handleAdd();
      return;
    }

    // กด Shift+Enter = ขึ้นบรรทัดใหม่ และขยาย textarea
    if (e.key === "Enter" && e.shiftKey && !mentionOpen) {
      // ปล่อยให้ Enter ทำงานปกติเพื่อขึ้นบรรทัดใหม่
      // แล้วเรียก autoResize หลังจาก Enter ทำงานเสร็จ
      requestAnimationFrame(() => {
        autoResize();
      });
      return;
    }

    // Close mention dialog with Escape key
    if (e.key === "Escape" && mentionOpen) {
      e.preventDefault();
      closeMention();
      taRef.current?.focus();
    }

    // Handle arrow keys and Enter when mention dialog is open
    if (mentionOpen && candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((v) => (v + 1) % candidates.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((v) => (v - 1 + candidates.length) % candidates.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        applyCandidate(candidates[activeIdx]);
      } else if (e.key === "Tab") {
        e.preventDefault();
        applyCandidate(candidates[activeIdx]);
      }
    }

    // Handle space or other characters that should close mention dialog
    if (mentionOpen && e.key === " " && mentionQuery.trim() === "") {
      closeMention();
    }
  };

  // Sync scroll between textarea and mirror
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (mirrorRef.current && e.currentTarget) {
      mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
      mirrorRef.current.scrollLeft = e.currentTarget.scrollLeft;
    }
  };

  // Handle @ character detection for auto-mention
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;

    setNewComment(value);

    // เรียก autoResize ทันทีเมื่อมีการเปลี่ยนแปลง
    requestAnimationFrame(() => {
      autoResize();
    });

    // Update cursor position
    selRef.current = {
      start: cursorPos,
      end: cursorPos,
    };

    // Check if we're currently in a mention context
    if (mentionOpen) {
      const atPosition = selRef.current.start;

      // Find the @ character by looking backwards from cursor
      let foundAtPos = -1;
      for (let i = cursorPos - 1; i >= 0; i--) {
        if (value[i] === "@") {
          // Check if this @ is at start or preceded by whitespace
          const prevChar = i > 0 ? value[i - 1] : " ";
          if (prevChar === " " || prevChar === "\n" || i === 0) {
            foundAtPos = i;
            break;
          }
        } else if (value[i] === " " || value[i] === "\n") {
          // Hit whitespace before finding @, stop looking
          break;
        }
      }

      // If no valid @ found, close mention dialog
      if (foundAtPos === -1) {
        closeMention();
        return;
      }

      // Extract text after @ up to cursor position
      const textAfterAt = value.slice(foundAtPos + 1, cursorPos);

      // Check if there's a space or newline in the text after @
      if (textAfterAt.includes(" ") || textAfterAt.includes("\n")) {
        closeMention();
        return;
      }

      // Update stored positions: start = @ position, end = current cursor position
      selRef.current = {
        start: foundAtPos,
        end: cursorPos, // Store cursor position for use in applyMentionCandidate
      };

      // Update query and filter candidates
      setMentionQuery(textAfterAt);
      setActiveIdx(0); // Reset selection to first item

      // Debounced search
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
      fetchTimer.current = setTimeout(() => {
        fetchMentionCandidates(textAfterAt.trim());
      }, 150);

      return;
    }

    // Check if user just typed @ character
    if (value[cursorPos - 1] === "@") {
      // Check if @ is at start or preceded by whitespace
      const prevChar = cursorPos > 1 ? value[cursorPos - 2] : " ";
      if (prevChar === " " || prevChar === "\n" || cursorPos === 1) {
        // Store positions: start = @ position, end = cursor position
        selRef.current = {
          start: cursorPos - 1, // Position of @
          end: cursorPos, // Cursor position (after @)
        };

        // Open mention dialog and fetch initial users
        setMentionQuery("");
        setActiveIdx(0);
        setMentionOpen(true);

        // Fetch all users initially
        fetchMentionCandidates("");
      }
    }
  };

  // Close mention dialog when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        mentionOpen &&
        taRef.current &&
        !taRef.current.contains(event.target as Node)
      ) {
        closeMention();
      }
    };

    if (mentionOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [mentionOpen]);

  const autoResize = React.useCallback(() => {
    const el = taRef.current;
    const mirror = mirrorRef.current;
    if (!el) return;

    // รีเซ็ตความสูงเป็น auto ก่อนเพื่อให้คำนวณ scrollHeight ใหม่
    el.style.height = "auto";

    // ตั้งความสูงตาม scrollHeight
    const newHeight = el.scrollHeight;
    el.style.height = `${newHeight}px`;

    // Sync mirror height ด้วย
    if (mirror) {
      mirror.style.height = `${newHeight}px`;
    }

    // ซ่อน scrollbar เพราะ textarea จะขยายตาม content
    el.style.overflowY = "hidden";
  }, []);

  React.useLayoutEffect(() => {
    autoResize();
  }, [newComment, autoResize]);

  // Combined list of comments and extra-approval lines
  const mixedItems = React.useMemo(() => {
    const items: Array<{
      type: "comment" | "extra";
      date: Date;
      id: string;
      data: any;
    }> = [];

    comments.forEach((c) => {
      // ✅ กรอง Comment ที่ผูกกับ ExtraApprovalLine ออก (ยกเว้นเป็น Recall)
      // เพื่อไม่ให้โชว์ซ้ำซ้อนกับ Comment ที่ไปโชว์ในการ์ด ExtraApprovalLine แล้ว
      if (c.extraApprovalLineId && !c.isRecallExtra) return;

      items.push({
        type: "comment",
        date: new Date(c.createdAt),
        id: `c-${c.id}`,
        data: c,
      });
    });

    if (memoId && extraLines.length > 0) {
      extraLines.forEach((line) => {
        const d = line.createdAt ? new Date(line.createdAt) : new Date();
        items.push({
          type: "extra",
          date: d,
          id: `e-${line.id}`,
          data: line,
        });
      });
    }

    // Sort ASC
    items.sort((a, b) => a.date.getTime() - b.date.getTime());
    return items;
  }, [comments, extraLines, memoId]);

  return (
    <section
      className={`flex flex-col h-full min-h-0 transition-all duration-200 relative ${
        isDragging ? "bg-indigo-50/50 ring-4 ring-indigo-100 ring-inset" : ""
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-white/60 backdrop-blur-[2px] pointer-events-none">
          <div className="bg-white p-5 rounded-2xl shadow-xl flex flex-col items-center animate-bounce-short border-4 border-indigo-50">
            <AiOutlineCloudUpload className="w-12 h-12 text-indigo-500 mb-2 drop-shadow-sm" />
            <p className="text-lg font-bold text-indigo-600">
              {t("dragDrop.dropMessage", "Drop File Here")}
            </p>
            <p className="text-xs font-medium text-gray-400 mt-0.5">
              {t("dragDrop.maxSize", "Max 50 MB")}
            </p>
          </div>
        </div>
      )}
      <div className="text-white bg-[#183E33] rounded-t-lg p-3 font-semibold flex items-center justify-between">
        <h2>Comment</h2>
        <button
          onClick={() => setChatModalOpen(true)}
          className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
          title="Expand chat"
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
              d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
            />
          </svg>
        </button>
      </div>

      {/* comment list */}
      <div
        ref={containerRef}
        className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-4 transition-colors duration-200 ${
          isDragging ? "bg-indigo-50" : "bg-gray-50"
        }`}
      >
        {mixedItems.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center">
            <div className="bg-white/80 backdrop-blur p-8 rounded-xl text-center max-w-xs">
              <PaperClipIcon className="mx-auto mb-4 w-14 h-14 text-gray-500" />
              <p className="font-medium text-gray-500 mb-1">
                {t("comment.empty.title")}
              </p>
              <p className="text-sm text-gray-400">
                {t("comment.empty.subtitle")}
              </p>
            </div>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {mixedItems.map((item) => {
              if (item.type === "comment") {
                const c = item.data as Comment;

                // ✅ Handle Recall History - ใช้ field isRecallExtra แทน prefix code
                if (c.isRecallExtra) {
                  const extraUserName = c.extraUser
                    ? `${c.extraUser.name} ${c.extraUser.lastname || ""}${c.extraUser.nickname ? ` (${c.extraUser.nickname})` : ""}`.trim()
                    : "Unknown";

                  let extraStatus = c.ExtraStatus || "Pending";
                  const names = [extraUserName];
                  const originalComment = c.comment;

                  return (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex justify-center my-4 px-2"
                    >
                      <div className="w-full max-w-md">
                        {/* Card */}
                        <div className="rounded-2xl overflow-hidden shadow-sm border border-l-4 border-[#dee2e6] border-l-[#6c757d] bg-[#f8f9fa] relative">
                          {/* Status Badge */}
                          <div className="absolute top-4 right-4">
                            <span
                              className={`px-2.5 py-1 text-xs font-semibold rounded-full ${
                                extraStatus === "Completed" ||
                                extraStatus === "Approved"
                                  ? "bg-emerald-100/80 text-emerald-700"
                                  : extraStatus === "Rejected"
                                    ? "bg-orange-100 text-orange-700"
                                    : extraStatus === "In Progress"
                                      ? "bg-blue-100/80 text-blue-700"
                                      : "bg-amber-100/80 text-amber-700"
                              }`}
                            >
                              {extraStatus.toUpperCase()}
                            </span>
                          </div>

                          {/* Header strip */}
                          <div className="flex items-center gap-3 px-4 pt-4 pb-2 pr-28">
                            {/* Rotating arrows icon */}
                            <div className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-[#e9ecef]">
                              <FontAwesomeIcon
                                icon={faArrowsRotate}
                                className="w-5 h-5 text-[#6c757d]"
                              />
                            </div>

                            <div>
                              <p className="text-sm font-semibold text-gray-800 leading-tight">
                                {t(
                                  "recallHistory.title",
                                  "Extra Approvers Removed",
                                )}
                              </p>
                            </div>
                          </div>

                          {/* Divider */}
                          <div className="mx-4 border-t border-gray-200" />

                          {/* Names list */}
                          <div className="px-4 py-3">
                            <p className="text-xs text-gray-400 mb-2">
                              {t(
                                "recallHistory.previousApprovers",
                                "Previous Extra Approvers:",
                              )}
                            </p>
                            <div className="flex flex-col gap-1">
                              {names.map((name, i) => (
                                <div
                                  key={i}
                                  className="flex items-center gap-2"
                                >
                                  <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 bg-[#e9ecef]">
                                    <svg
                                      className="w-3 h-3 text-[#6c757d]"
                                      fill="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
                                    </svg>
                                  </div>
                                  <span className="text-sm text-gray-700">
                                    {name.replace(/^-\s*/, "")}
                                  </span>
                                </div>
                              ))}
                            </div>

                            {/* Original Comment Output */}
                            {originalComment && (
                              <div className="mt-3 bg-white p-3 rounded-lg border border-gray-100 shadow-sm">
                                <p className="text-xs text-gray-400 mb-1">
                                  Original Comment:
                                </p>
                                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                                  {originalComment}
                                </p>
                              </div>
                            )}
                          </div>

                          {/* Footer */}
                          <div className="flex items-center gap-1.5 px-4 pb-3 text-[10px] text-gray-400">
                            <svg
                              className="w-3 h-3"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                              />
                            </svg>
                            <span>
                              {t(
                                "recallHistory.recalledBy",
                                "Recalled by {{name}}",
                                { name: c.user?.name || "Unknown" },
                              )}
                            </span>
                            <span>•</span>
                            <time dateTime={c.createdAt}>
                              {prettyTime(
                                c.createdAt,
                                pickLocale(i18n.language),
                                t,
                              )}
                            </time>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  );
                }

                const isMe = c.user.id === meId;
                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.2 }}
                    className={`flex ${isMe ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`flex flex-col bg-white shadow-md p-3 rounded-2xl max-w-[80%] overflow-hidden
                    ${
                      isMe
                        ? "rounded-tr-none bg-gradient-to-br from-[#183E33] to-[#0f2c23] text-white"
                        : "rounded-tl-none"
                    }`}
                    >
                      <div className="flex items-start gap-2 group">
                        {isMe ? (
                          <Avatar
                            name={c.user.name}
                            src={c.user.profileImage}
                            userId={c.user.id}
                          />
                        ) : null}

                        <div className="flex-1 min-w-0">
                          {/* Header: Name + Time + Delete */}
                          <div className="flex items-center justify-between mb-1 gap-2">
                            <p className="text-xs font-semibold truncate">
                              {isMe ? (
                                "You"
                              ) : (
                                <UserLabel id={c.user.id} seed={c.user} />
                              )}
                            </p>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <time
                                dateTime={c.createdAt}
                                title={formatAbsolute(
                                  new Date(c.createdAt),
                                  pickLocale(i18n.language),
                                )}
                                className={`text-[10px] whitespace-nowrap ${isMe ? "text-gray-300" : "text-gray-400"}`}
                              >
                                {prettyTime(
                                  c.createdAt,
                                  pickLocale(i18n.language),
                                  t,
                                )}
                              </time>
                              {isMe && c.hasMentions && (
                                <button
                                  type="button"
                                  title={t(
                                    "comment.deleteTitle",
                                    "Remove comment",
                                  )}
                                  onClick={() => {
                                    setConfirmDialog({
                                      show: true,
                                      title: t(
                                        "comment.deleteTitle",
                                        "Remove Comment",
                                      ),
                                      message: t(
                                        "comment.deleteMessage",
                                        "Are you sure you want to remove this comment? This action cannot be undone.",
                                      ),
                                      btnConfirm: t(
                                        "comment.deleteConfirmBtn",
                                        "Remove",
                                      ),
                                      btnCancel: t("extra.btnCancel", "Cancel"),
                                      danger: true,
                                      onConfirm: async () => {
                                        setConfirmDialog((prev) => ({
                                          ...prev,
                                          isLoading: true,
                                        }));
                                        try {
                                          await deleteCommentApi(c.id);
                                          setComments((prev) =>
                                            prev.filter((x) => x.id !== c.id),
                                          );
                                          toast.success(
                                            t(
                                              "comment.deleteSuccess",
                                              "Comment removed",
                                            ),
                                          );
                                          setConfirmDialog({
                                            show: false,
                                            message: "",
                                            onConfirm: () => {},
                                          });
                                        } catch {
                                          toast.error(
                                            t(
                                              "comment.deleteFailed",
                                              "Failed to remove comment",
                                            ),
                                          );
                                          setConfirmDialog((prev) => ({
                                            ...prev,
                                            isLoading: false,
                                          }));
                                        }
                                      },
                                    });
                                  }}
                                  className="p-0.5 rounded hover:bg-white/20 text-white/50 hover:text-white/90 transition-colors opacity-0 group-hover:opacity-100"
                                >
                                  <svg
                                    className="w-3.5 h-3.5"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2}
                                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                    />
                                  </svg>
                                </button>
                              )}
                            </div>
                          </div>

                          <div
                            className="text-sm whitespace-pre-wrap break-words"
                            style={{ overflowWrap: "break-word" }}
                          >
                            {renderWithHighlights(c.comment, c.tags)}
                          </div>
                        </div>

                        {!isMe ? (
                          <Avatar
                            name={c.user.name}
                            src={c.user.profileImage}
                            userId={c.user.id}
                          />
                        ) : null}
                      </div>

                      {c.attachments?.length ? (
                        <div
                          className={`mt-3 grid gap-2 ${c.attachments.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}
                        >
                          {c.attachments.map((att) =>
                            att.mimetype.startsWith("image/") ? (
                              <img
                                key={att.id}
                                src={att.url}
                                alt={att.filename}
                                className={`w-full h-32 rounded object-cover cursor-pointer hover:opacity-80 border border-gray-100 ${c.attachments?.length === 1 ? "col-span-2" : ""}`}
                                onClick={() => setPreviewImage(att.url)}
                              />
                            ) : att.mimetype === "application/pdf" ? (
                              <div
                                key={att.id}
                                onClick={() => setPreviewPdf(att.url)}
                                className={`group flex items-center gap-2 rounded-xl px-4 py-2 shadow cursor-pointer transition-colors col-span-2
    ${
      isMe
        ? "bg-white/10 text-white border border-white/20"
        : "bg-gray-100 text-gray-800 border border-gray-200"
    }
    w-full max-w-full`}
                              >
                                <AiFillFilePdf className="w-8 h-8 shrink-0" />
                                <span
                                  className="flex-1 min-w-0 truncate"
                                  title={att.filename}
                                >
                                  {att.filename}
                                </span>
                              </div>
                            ) : (
                              <div
                                key={att.id}
                                className="group flex items-center gap-2 px-3 py-2 rounded-lg bg-[#0084FF] text-white hover:bg-[#006FCC] transition-colors shadow-sm w-full max-w-full col-span-2 cursor-pointer"
                                title={att.filename}
                                onClick={() => handleDownloadAttachment(att)}
                              >
                                <PaperClipIcon className="w-4 h-4 shrink-0" />
                                <span className="flex-1 min-w-0 truncate">
                                  {att.filename}
                                </span>
                                <svg
                                  className="w-4 h-4 shrink-0"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                  />
                                </svg>
                              </div>
                            ),
                          )}
                        </div>
                      ) : null}
                    </div>
                  </motion.div>
                );
              } else {
                // =========================== EXTRA APPROVAL CARD (MAIN VIEW) ===========================
                const extra = item.data as any; // Type assertion if needed
                const myRow = extra.approvers.find(
                  (a: any) => a.user.id === meId,
                );
                const isWaiting = !!myRow && !myRow.status;
                const isCardActive =
                  extra.status === "PENDING" || extra.status === "IN_PROGRESS";

                const rawComment = Array.isArray(extra.comment)
                  ? extra.comment.length > 0
                    ? extra.comment[0]
                    : null
                  : extra.comment;

                const commentText =
                  typeof rawComment === "string"
                    ? rawComment
                    : rawComment && typeof rawComment === "object"
                      ? rawComment.comment
                      : null;

                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.3 }}
                    className="my-6"
                  >
                    <div className="border border-gray-200 rounded-xl shadow-sm bg-white overflow-hidden w-full max-w-md mx-auto ring-1 ring-black/5">
                      <div className="bg-gray-50/80 px-4 py-3 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div>
                              <h3 className="font-bold text-gray-900 text-sm leading-tight">
                                {t("extra.requestTitle", "Approval Request")}
                              </h3>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[10px] uppercase tracking-wider font-semibold text-gray-500">
                                  {t("extra.type", "EXTRA")}
                                </span>
                                <span className="text-[10px] text-gray-400">
                                  •{" "}
                                  {prettyTime(
                                    item.date.toISOString(),
                                    pickLocale(i18n.language),
                                    t,
                                  )}
                                </span>
                              </div>
                            </div>
                          </div>
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border uppercase tracking-wide ${
                              extra.status === "COMPLETED"
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                : extra.status === "REJECTED"
                                  ? "bg-orange-100 text-orange-700 border-orange-200"
                                  : "bg-amber-50 text-amber-700 border-amber-200"
                            }`}
                          >
                            {extra.status}
                          </span>
                        </div>
                        {/* ✅ Display comment prominently in header (Main View) */}
                        {commentText && (
                          <div className="mt-3 p-3 bg-white/60 border border-gray-200 rounded-lg">
                            <p className="text-xs font-semibold text-gray-600 mb-1.5">
                              {t("extra.commentLabel", "Comment")}:
                            </p>
                            <p className="text-[15px] text-gray-900 font-medium whitespace-pre-wrap break-words leading-relaxed">
                              {commentText}
                            </p>
                          </div>
                        )}
                      </div>
                      <div className="p-4 bg-white">
                        <div className="space-y-3">
                          {extra.approvers.map((a: any) => {
                            const statusName = a.status?.name ?? "Waiting";
                            const fullName =
                              [a.user.name, a.user.lastname]
                                .filter(Boolean)
                                .join(" ") +
                              (a.user.nickname ? ` (${a.user.nickname})` : "");

                            return (
                              <div
                                key={a.id}
                                className="flex items-center justify-between group"
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <Avatar
                                    name={fullName || `User #${a.user.id}`}
                                    src={
                                      a.user.profileImagePath
                                        ? toSecureUploadUrl(
                                            a.user.profileImagePath,
                                          )
                                        : null
                                    }
                                    userId={a.user.id}
                                    sizeClass="w-8 h-8"
                                  />
                                  <div className="flex flex-col min-w-0">
                                    <span className="text-sm font-medium text-gray-900 truncate">
                                      {fullName || `User #${a.user.id}`}
                                    </span>
                                    <span className="text-xs text-gray-500">
                                      {statusName}
                                      {a.actedAt &&
                                        ` • ${prettyTime(
                                          a.actedAt,
                                          pickLocale(i18n.language),
                                          t,
                                        )}`}
                                    </span>
                                  </div>
                                </div>
                                {statusName === "Approved" ? (
                                  <div className="text-emerald-500 bg-emerald-50 p-1.5 rounded-full">
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M5 13l4 4L19 7"
                                      />
                                    </svg>
                                  </div>
                                ) : statusName === "Rejected" ? (
                                  <div className="text-orange-500 bg-orange-50 p-1.5 rounded-full">
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M6 18L18 6M6 6l12 12"
                                      />
                                    </svg>
                                  </div>
                                ) : (
                                  <div className="text-amber-500 bg-amber-50 p-1.5 rounded-full">
                                    <FiClock className="w-4 h-4" />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex flex-wrap gap-3 items-center justify-between">
                        {isWaiting && isCardActive && !isExpired && (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={async () => {
                                if (hideExtraButton || !memoId || !extra)
                                  return;
                                try {
                                  await actExtra(memoId, extra.id, "approved");
                                  await refreshExtraLines();
                                  toast.success("อนุมัติ (Extra) แล้ว");
                                } catch {
                                  toast.error("Failed");
                                }
                              }}
                              disabled={hideExtraButton}
                              className="px-4 py-1.5 bg-emerald-600 text-white text-sm font-bold rounded-lg hover:bg-emerald-700 shadow-sm transition-all"
                            >
                              {t("extra.approve", "Approve")}
                            </button>
                            <button
                              onClick={async () => {
                                if (hideExtraButton || !memoId || !extra)
                                  return;
                                if (!confirm("Are you sure?")) return;
                                try {
                                  await actExtra(memoId, extra.id, "rejected");
                                  await refreshExtraLines();
                                  toast.success("ปฏิเสธ (Extra) แล้ว");
                                } catch {
                                  toast.error("Failed");
                                }
                              }}
                              disabled={hideExtraButton}
                              className="px-4 py-1.5 bg-amber-600 text-white text-sm font-bold rounded-lg hover:bg-amber-700 transition-all"
                            >
                              {t("extra.reject", "Reject")}
                            </button>
                          </div>
                        )}
                        {extra.status === "PENDING" &&
                          extra.createdById === meId &&
                          memoId && (
                            <button
                              onClick={() => {
                                setConfirmDialog({
                                  show: true,
                                  title: t(
                                    "extra.removeLineTitle",
                                    "Remove Approval Line",
                                  ),
                                  message: t(
                                    "extra.removeLineMessage",
                                    "Are you sure you want to remove this extra approval line? This action cannot be undone.",
                                  ),
                                  btnConfirm: t(
                                    "extra.removeLineConfirmBtn",
                                    "Remove",
                                  ),
                                  btnCancel: t("extra.btnCancel", "Cancel"),
                                  danger: true,
                                  onConfirm: async () => {
                                    setConfirmDialog((prev) => ({
                                      ...prev,
                                      isLoading: true,
                                    }));
                                    try {
                                      await removeExtraLine(memoId, extra.id);
                                      await refreshExtraLines();
                                      toast.success(
                                        t(
                                          "extra.removeLineSuccess",
                                          "Approval line removed",
                                        ),
                                      );
                                      setConfirmDialog({
                                        show: false,
                                        message: "",
                                        onConfirm: () => {},
                                      });
                                    } catch {
                                      toast.error(
                                        t(
                                          "extra.removeLineFailed",
                                          "Failed to remove approval line",
                                        ),
                                      );
                                      setConfirmDialog((prev) => ({
                                        ...prev,
                                        isLoading: false,
                                      }));
                                    }
                                  },
                                });
                              }}
                              className="px-3 py-1.5 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors ml-auto"
                            >
                              {t("extra.removeLineBtn", "Remove")}
                            </button>
                          )}
                      </div>
                    </div>
                  </motion.div>
                );
              }
            })}
          </AnimatePresence>
        )}
      </div>

      {/* Input area */}
      <div
        className={`relative p-3 bg-white  border-t border-gray-200 transition-colors ${
          isDragging ? "bg-indigo-50" : ""
        }`}
      >
        <input
          id="comment-attach"
          type="file"
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx"
          multiple // ✅ Allow multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);

            if (!files.length) return;

            // Validate file types and sizes
            const ALLOWED_TYPES = [
              "image/png",
              "image/jpeg",
              "image/jpg",
              "image/gif",
              "image/webp",
              "application/pdf",
              "application/msword",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "application/vnd.ms-powerpoint",
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              "application/vnd.ms-excel",
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "text/csv",
              "application/csv",
            ];

            const ALLOWED_EXTENSIONS = [
              ".png",
              ".jpg",
              ".jpeg",
              ".gif",
              ".webp",
              ".pdf",
              ".doc",
              ".docx",
              ".ppt",
              ".pptx",
              ".xls",
              ".xlsx",
              ".csv",
            ];

            const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

            const invalidFiles: string[] = [];
            const oversizedFiles: string[] = [];
            const validFiles: File[] = [];

            files.forEach((file) => {
              const ext =
                "." + (file.name.split(".").pop()?.toLowerCase() || "");
              const isValidType =
                ALLOWED_TYPES.includes(file.type) ||
                ALLOWED_EXTENSIONS.includes(ext);
              const isValidSize = file.size <= MAX_FILE_SIZE;

              if (!isValidType) {
                invalidFiles.push(file.name);
              } else if (!isValidSize) {
                oversizedFiles.push(file.name);
              } else {
                validFiles.push(file);
              }
            });

            // Show error messages
            if (invalidFiles.length > 0) {
              toast.error(
                `Unsupported file type: ${invalidFiles.join(", ")}. Only images, PDF, Word, Excel, and PowerPoint files are allowed.`,
              );
            }

            if (oversizedFiles.length > 0) {
              toast.error(
                `File too large: ${oversizedFiles.join(", ")}. Maximum size is 50MB per file.`,
              );
            }

            // Add valid files
            if (validFiles.length > 0) {
              setAttachments((prev) => {
                const combined = [...prev, ...validFiles];
                if (combined.length > 6) {
                  toast.error("Maximum 6 files can be attached.");
                  return combined.slice(0, 6);
                }
                return combined;
              });
            }

            // Reset input
            e.target.value = "";
          }}
        />

        {/* Container for Input + Highlight Overlay with gray background */}
        <div
          className="relative group bg-gray-100 rounded-lg p-3 mb-3"
          style={{ minHeight: "60px" }}
        >
          {/* Mirror Overlay for Highlights */}
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className="absolute top-0 left-0 w-full px-3 py-3 text-sm leading-5 font-sans whitespace-pre-wrap break-words pointer-events-none overflow-visible rounded-lg z-0"
            style={{
              paddingRight: "12px",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
            }}
          >
            <div className="text-gray-900">
              {renderWithHighlights(newComment)}
              {newComment.endsWith("\n") && <br />}
            </div>
          </div>
          <textarea
            ref={taRef}
            className="relative z-10 w-full rounded-lg px-0 py-0 text-sm focus:outline-none leading-5 bg-transparent text-transparent caret-gray-900 placeholder:text-gray-400 selection:bg-blue-400 selection:text-white scrollbar-hide resize-none"
            rows={1}
            wrap="soft"
            placeholder={t("comment.inputPlaceholder")}
            value={newComment}
            onChange={handleTextareaChange}
            onScroll={handleScroll}
            onPaste={handlePaste}
            onInput={autoResize}
            onFocus={autoResize}
            onKeyDown={onKeyDown}
            onClick={updateSelection}
            onKeyUp={updateSelection}
            onSelect={updateSelection}
            style={{
              overflowY: "hidden",
              wordBreak: "break-word",
              overflowWrap: "anywhere",
              minHeight: "60px",
              scrollbarWidth: "none",
              msOverflowStyle: "none",
            }}
          />

          {/* Preview Area (Grid 3 Columns) - Inside gray box, below text */}
          {previewUrls.length > 0 && (
            <div className="mt-3 grid grid-cols-4 gap-2">
              {previewUrls.map((url, i) => {
                const file = attachments[i];
                const isPdf = file?.type === "application/pdf";
                return (
                  <div
                    key={url}
                    className={`relative group ${isPdf ? "col-span-3 h-14 flex items-center gap-3 px-3 bg-white border border-gray-200 rounded-lg" : "w-20 h-20"}`}
                  >
                    {isPdf ? (
                      <>
                        <AiFillFilePdf className="w-6 h-6 text-red-500 shrink-0" />
                        <span className="text-sm text-gray-700 truncate">
                          {file?.name ||
                            t("comment.pdfDocument", "PDF Document")}
                        </span>
                      </>
                    ) : (
                      <img
                        src={url}
                        className="w-full h-full object-cover rounded-lg border border-gray-200"
                      />
                    )}

                    {/* Remove Button (Top-Right) */}
                    <button
                      type="button"
                      onClick={() => {
                        setAttachments((prev) =>
                          prev.filter((_, idx) => idx !== i),
                        );
                      }}
                      className={`absolute bg-black/50 hover:bg-red-500 text-white p-1 rounded-full transition-colors opacity-0 group-hover:opacity-100 ${isPdf ? "right-2" : "top-1 right-1"}`}
                      title="Remove"
                    >
                      <FiX className="w-3 h-3" />
                    </button>

                    {/* Preview Button (Center) */}
                    <button
                      type="button"
                      onClick={() => {
                        if (isPdf) {
                          setPreviewPdf(url);
                        } else {
                          setPreviewImage(url);
                        }
                      }}
                      className={`absolute text-white p-1 rounded-full transition-all opacity-0 group-hover:opacity-100 ${isPdf ? "right-10 bg-black/50 hover:bg-black/70" : "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 scale-90 group-hover:scale-100"}`}
                      title="Preview"
                    >
                      <FiEye className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Action buttons row at bottom */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="comment-attach"
            title={t("comment.attachFile", "Attach file")}
            className="inline-flex items-center justify-center p-2 rounded-full border border-gray-200 hover:bg-gray-100 text-gray-700 cursor-pointer focus:outline-none focus:ring-2 focus:ring-gray-300 transition-colors"
          >
            <PaperClipIcon className="w-5 h-5" />
            <span className="sr-only">
              {t("comment.attachFile", "Attach file")}
            </span>
          </label>

          {/* Create Extra Line Button */}
          <button
            type="button"
            title={
              !isProcessing
                ? t("extra.notProcessingWarning")
                : t("extra.create", "Add Extra Approval")
            }
            disabled={isExpired || !isProcessing}
            onClick={() => {
              if (isExpired || !isProcessing) return;
              setMentionOpen(false);
              setExtraOpen(true);
            }}
            className="inline-flex items-center justify-center p-2 rounded-full border border-gray-200 hover:bg-gray-100 text-emerald-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FaUserPlus className="w-5 h-5" />
          </button>

          <div className="flex-1"></div>

          <button
            onClick={handleAdd}
            disabled={!newComment.trim() && attachments.length === 0}
            className="p-2 rounded-full bg-[#183e33] hover:bg-green-700 disabled:bg-gray-300 transition"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-5 h-5 text-white"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {/* Inline mention dropdown */}
        {mentionOpen && (
          <div
            className="absolute bottom-full left-0 right-0 mb-2 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-48 overflow-auto"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {candidates.length === 0 ? (
              <div className="px-4 py-3 text-sm text-gray-500">
                {mentionQuery.trim()
                  ? t("mention.noResults")
                  : t("mention.hint")}
              </div>
            ) : (
              candidates.map((u, idx) => (
                <button
                  key={u.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyCandidate(u);
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-gray-50 transition-colors ${
                    idx === activeIdx
                      ? "bg-blue-50 border-l-2 border-blue-500"
                      : ""
                  }`}
                >
                  <Avatar
                    name={formatMentionLabel(u)}
                    src={
                      u.profileImageUrl
                        ? toSecureUploadUrl(u.profileImageUrl)
                        : null
                    }
                    userId={u.id}
                    sizeClass="w-7 h-7"
                  />

                  {/* User name + email */}
                  <div className="flex-1 min-w-0">
                    {/* Name line */}
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {formatMentionLabel(u)}
                    </div>

                    {/* Email line */}
                    {u.email && (
                      <div className="text-xs text-gray-500 truncate">
                        {u.email}
                      </div>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
        {extraOpen && (
          <>
            {/* overlay ปิดกล่อง */}
            <div
              className="fixed inset-0 z-[60] bg-transparent"
              onMouseDown={() => setExtraOpen(false)}
            />

            {/* กล่องเลือกผู้อนุมัติพิเศษ */}
            <div
              className={`fixed z-[70] w-[min(36rem,calc(100vw-2rem))] bg-white border border-gray-200 rounded-2xl shadow-xl transition-all ${
                chatModalOpen
                  ? "bottom-[calc(5vh+6rem)] left-[max(5vw+1rem,calc(50vw-27rem))]"
                  : "bottom-20 right-5"
              }`}
              onMouseDown={(e) => e.stopPropagation()} // กัน overlay กินคลิก
              onClick={(e) => e.stopPropagation()}
            >
              {/* หัวกล่อง + ช่องค้นหา (ตกแต่ง) */}
              <div className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-gray-200">
                {/* Header row */}
                <div className="px-3 pt-3 pb-2 flex items-center gap-3">
                  <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-emerald-50 text-emerald-700">
                    <FaUserPlus className="w-4 h-4" />
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-900 truncate">
                      {t("extra.title", "Extra approval")}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {t("extra.searchHint")}
                    </div>
                  </div>

                  <button
                    className="inline-flex items-center justify-center w-8 h-8 rounded-full text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition"
                    onClick={() => setExtraOpen(false)}
                    title={t("btnClose")}
                    aria-label={t("btnClose")}
                  >
                    <FiX className="w-4 h-4" />
                  </button>
                </div>

                {/* Search bar */}
                <div className="px-3 pb-3">
                  <div className="relative">
                    <FiSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    {/* ปุ่มเคลียร์เมื่อมีข้อความ */}
                    {extraQuery && (
                      <button
                        type="button"
                        aria-label={t("btnClear", "Clear")}
                        title={t("btnClear", "Clear")}
                        onClick={() => {
                          setExtraQuery("");
                          setExtraCandidates([]);
                          requestAnimationFrame(() =>
                            extraInputRef.current?.focus(),
                          );
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-7 h-7 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                      >
                        <FiX className="w-4 h-4" />
                      </button>
                    )}

                    <input
                      ref={extraInputRef}
                      value={extraQuery}
                      onChange={(e) => {
                        const q = e.target.value;
                        setExtraQuery(q);
                        if (q.trim()) fetchExtraCandidates(q.trim());
                        else setExtraCandidates([]);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setExtraOpen(false);
                        }
                      }}
                      placeholder={t(
                        "extra.searchPlaceholder",
                        "Search by name or email",
                      )}
                      className="w-full rounded-xl bg-gray-50 pl-9 pr-10 py-2 text-sm border border-gray-200 outline-none transition"
                    />
                  </div>
                </div>
              </div>

              {/* Search results */}
              <div className="mt-2 max-h-72 overflow-auto">
                {extraQuery.trim() && extraCandidates.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-gray-500">
                    No matching users were found.
                  </div>
                ) : (
                  extraCandidates.map((u) => {
                    // Check if there are pending approvals to disable the button
                    const hasPendingApprovals = extraActive?.approvers.some(
                      (a) => !a.status || a.status.name === "Waiting",
                    );
                    const isDisabled = extraLoading || hasPendingApprovals;

                    return (
                      <button
                        key={u.id}
                        type="button"
                        disabled={isDisabled}
                        title={undefined}
                        onMouseDown={(e) => {
                          e.preventDefault();

                          if (!memoId || extraLoading || hasPendingApprovals)
                            return;

                          // Show custom confirmation dialog
                          const userName = formatMentionLabel(u);
                          const confirmMessage = extraActive
                            ? t("extra.confirmAddMessage", { name: userName })
                            : t("extra.confirmCreateMessage", {
                                name: userName,
                              });

                          setDialogCommentText(""); // Reset comment text
                          setConfirmDialog({
                            show: true,
                            title: t(
                              "extra.confirmTitle",
                              "Confirm Extra Approver",
                            ),
                            message: confirmMessage,
                            btnConfirm: t("extra.btnConfirm", "Confirm"),
                            btnCancel: t("extra.btnCancel", "Cancel"),
                            showCommentInput: true,
                            commentPlaceholder: t(
                              "extra.commentPlaceholder",
                              "Enter reason for adding this approver (optional)",
                            ),
                            onConfirm: async (comment?: string) => {
                              // Show loading state in dialog
                              setConfirmDialog((prev) => ({
                                ...prev,
                                isLoading: true,
                              }));

                              try {
                                setExtraLoading(true);

                                // Log the comment if provided
                                if (comment?.trim()) {
                                  console.log(
                                    "Extra approver comment:",
                                    comment,
                                  );
                                }

                                // ✅ NEW LOGIC: Always create a fresh line with all users starting as "Waiting"
                                // Check if there's an active line waiting for approval
                                if (
                                  extraActive &&
                                  extraActive.approvers.some((a) => !a.status)
                                ) {
                                  toast.error(
                                    t(
                                      "extra.pendingExists",
                                      "กรุณารอการอนุมัติก่อนเพิ่มคนใหม่",
                                    ),
                                  );
                                  return;
                                }

                                // ✅ FIX: Do NOT inherit approvals from previous lines
                                // Each new extra approval line should start fresh with all users as "Waiting"
                                // preApprovedUsers should only be used when APPENDING to an existing line
                                const newUserIds = [u.id]; // Only the newly selected user

                                try {
                                  // ✅ Create new line with empty preApprovedUsers (all start as "Waiting")
                                  const created = await createExtraLine(
                                    memoId,
                                    newUserIds,
                                    [], // Empty array - no pre-approved users
                                    comment, // ✅ Send comment text
                                  );
                                  await refreshExtraLines();
                                  await fetchComments();
                                  toast.success(
                                    t("extra.created", "สร้าง Extra line แล้ว"),
                                  );

                                  window.dispatchEvent(
                                    new CustomEvent("memo:extra-created", {
                                      detail: { memoId, lineId: created.id },
                                    }),
                                  );
                                } catch (e: any) {
                                  if (e?.response?.status === 403) {
                                    toast.error(
                                      t(
                                        "error.noPermission",
                                        "You don't have permission to perform this action.",
                                      ),
                                    );
                                  } else if (e?.response?.status === 409) {
                                    // ✅ Check for MEMO_STATUS_CHANGED error first
                                    if (
                                      e?.response?.data?.code ===
                                      "MEMO_STATUS_CHANGED"
                                    ) {
                                      const statusCode =
                                        e?.response?.data?.statusCode ||
                                        "UNKNOWN";
                                      const errorMsg = t(
                                        `error.statusChanged.${statusCode}`,
                                        t("error.statusChanged.UNKNOWN"),
                                      );
                                      toast.error(errorMsg, {
                                        duration: 5000,
                                      });
                                      // Auto-refresh data
                                      await refreshExtraLines();
                                      await fetchComments();
                                    } else {
                                      toast.error(
                                        t(
                                          "extra.activeAlready",
                                          "มี Extra line ที่กำลังทำงานอยู่แล้ว",
                                        ),
                                      );
                                    }
                                    await refreshExtraLines();
                                  } else {
                                    const msg =
                                      e?.response?.data?.error || e?.message;
                                    toast.error(
                                      msg ||
                                        t(
                                          "extra.saveFail",
                                          "สร้าง Extra line ไม่สำเร็จ",
                                        ),
                                    );
                                  }
                                  return;
                                }

                                // Close modal and clear search after successful add
                                setExtraOpen(false);
                                setExtraQuery("");
                                setExtraCandidates([]);
                              } catch (e: any) {
                                toast.error(e?.message || t("extra.saveFail"));
                              } finally {
                                setExtraLoading(false);
                                // Close dialog and reset
                                setConfirmDialog({
                                  show: false,
                                  message: "",
                                  onConfirm: () => {},
                                });
                                setDialogCommentText("");
                              }
                            },
                          });
                        }}
                        className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-amber-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Avatar
                          name={formatMentionLabel(u)}
                          src={
                            u.profileImageUrl
                              ? toSecureUploadUrl(u.profileImageUrl)
                              : null
                          }
                          userId={u.id}
                          sizeClass="w-7 h-7"
                        />
                        <div className="flex-1">
                          <div className="text-sm font-medium">
                            {formatMentionLabel(u)}
                          </div>
                          <div className="text-[11px] text-gray-500">
                            {u.email}
                          </div>
                        </div>
                        {extraLoading && (
                          <div className="text-xs text-gray-500">
                            {t("extra.saving", "กำลังเพิ่ม...")}
                          </div>
                        )}
                      </button>
                    );
                  })
                )}
              </div>

              {/* Warning message when buttons are disabled due to pending approvals */}
              {extraActive &&
                extraActive.approvers.some(
                  (a) => !a.status || a.status.name === "Waiting",
                ) && (
                  <div className="mx-3 mb-3 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start gap-2">
                    <svg
                      className="w-4 h-4 mt-0.5 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span>{t("extra.pendingApprovalsWarning")}</span>
                  </div>
                )}
            </div>
          </>
        )}
      </div>

      {/* Extended Chat Modal */}
      {chatModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div
            className={`bg-white rounded-2xl shadow-2xl w-[90vw] h-[90vh] max-w-4xl flex flex-col border border-gray-200 transition-all duration-200 relative ${
              isDragging
                ? "bg-indigo-50/50 ring-4 ring-indigo-200 ring-inset"
                : ""
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {isDragging && (
              <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-white/60 backdrop-blur-[2px] pointer-events-none">
                <div className="bg-white p-8 rounded-3xl shadow-2xl flex flex-col items-center animate-bounce-short border-4 border-indigo-50">
                  <AiOutlineCloudUpload className="w-20 h-20 text-indigo-500 mb-4 drop-shadow-sm" />
                  <p className="text-2xl font-extrabold text-indigo-600">
                    {t("dragDrop.dropMessage", "Drop File Here")}
                  </p>
                  <p className="text-base font-medium text-gray-400 mt-1">
                    {t("dragDrop.maxSize", "Max 50 MB")}
                  </p>
                </div>
              </div>
            )}
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Comment</h3>
              <button
                onClick={() => setChatModalOpen(false)}
                className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <svg
                  className="w-5 h-5 text-gray-500"
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

            {/* Modal Content - Comments List */}
            <div
              className={`flex-1 overflow-y-auto p-4 space-y-4 transition-colors duration-200 ${
                isDragging ? "bg-indigo-50" : "bg-gray-50"
              }`}
            >
              {comments.length === 0 && (!memoId || !extraActive) ? (
                <div className="flex-1 flex flex-col items-center justify-center">
                  <div className="bg-white/80 backdrop-blur p-8 rounded-xl text-center max-w-xs">
                    <PaperClipIcon className="mx-auto mb-4 w-14 h-14 text-gray-500" />
                    <p className="font-medium text-gray-500 mb-1">
                      {t("comment.empty.title")}
                    </p>
                    <p className="text-sm text-gray-400">
                      {t("comment.empty.subtitle")}
                    </p>
                  </div>
                </div>
              ) : (
                <AnimatePresence initial={false}>
                  {(() => {
                    const items: Array<{
                      type: "comment" | "extra";
                      date: Date;
                      id: string;
                      data: any;
                    }> = [];

                    comments.forEach((c) => {
                      // ✅ กรอง Comment ที่ผูกกับ ExtraApprovalLine ออก (ยกเว้นเป็น Recall)
                      if (c.extraApprovalLineId && !c.isRecallExtra) return;

                      items.push({
                        type: "comment",
                        date: new Date(c.createdAt),
                        id: `c-${c.id}`,
                        data: c,
                      });
                    });

                    // ✅ แสดงทุก extra lines เป็นการ์ดแยก (Modal)
                    if (memoId && extraLines.length > 0) {
                      extraLines.forEach((line) => {
                        const d = line.createdAt
                          ? new Date(line.createdAt)
                          : new Date();
                        items.push({
                          type: "extra",
                          date: d,
                          id: `e-${line.id}`,
                          data: line,
                        });
                      });
                    }

                    // Sort ASC
                    items.sort((a, b) => a.date.getTime() - b.date.getTime());

                    return items.map((item) => {
                      if (item.type === "comment") {
                        const c = item.data as Comment;

                        // ✅ Recall History Card (Modal)
                        if (c.isRecallExtra) {
                          const isLegacy =
                            !c.extraUser &&
                            c.comment.includes("Previous Extra Approvers:");
                          let names: string[] = [];
                          let originalComment = "";
                          let extraStatus = "";

                          if (isLegacy) {
                            names = c.comment
                              .split("\n")
                              .map((l) => l.trim())
                              .filter(Boolean)
                              .slice(1);
                          } else {
                            const extraUserName = c.extraUser
                              ? `${c.extraUser.name} ${c.extraUser.lastname || ""}${c.extraUser.nickname ? ` (${c.extraUser.nickname})` : ""}`.trim()
                              : "Unknown";
                            extraStatus = c.ExtraStatus || "Pending";
                            names = [extraUserName];
                            originalComment = c.comment;
                          }

                          return (
                            <motion.div
                              key={item.id}
                              initial={{ opacity: 0, y: 5 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="flex justify-center my-4 px-2"
                            >
                              <div className="w-full max-w-md">
                                <div
                                  className="rounded-2xl overflow-hidden shadow-sm border relative"
                                  style={{
                                    background: "#f8f9fa",
                                    borderColor: "#dee2e6",
                                    borderLeft: "4px solid #6c757d",
                                  }}
                                >
                                  {/* Status Badge */}
                                  {!isLegacy && extraStatus && (
                                    <div className="absolute top-4 right-4">
                                      <span
                                        className={`px-2.5 py-1 text-xs font-semibold rounded-full ${
                                          extraStatus === "Completed" ||
                                          extraStatus === "Approved"
                                            ? "bg-emerald-100/80 text-emerald-700"
                                            : extraStatus === "Rejected"
                                              ? "bg-orange-500 text-orange-700"
                                              : extraStatus === "In Progress"
                                                ? "bg-blue-100/80 text-blue-700"
                                                : "bg-amber-100/80 text-amber-700"
                                        }`}
                                      >
                                        {extraStatus.toUpperCase()}
                                      </span>
                                    </div>
                                  )}

                                  {/* Header */}
                                  <div className="flex items-center gap-3 px-4 pt-4 pb-2">
                                    <div
                                      className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
                                      style={{ background: "#e9ecef" }}
                                    >
                                      <FontAwesomeIcon
                                        icon={faArrowsRotate}
                                        className="w-5 h-5"
                                        style={{ color: "#6c757d" }}
                                      />
                                    </div>
                                    <div>
                                      <p
                                        className="text-[10px] font-bold uppercase tracking-widest"
                                        style={{ color: "#6c757d" }}
                                      >
                                        {t(
                                          "recallHistory.label",
                                          "Recall History",
                                        )}
                                      </p>
                                      <p className="text-sm font-semibold text-gray-800 leading-tight">
                                        {t(
                                          "recallHistory.title",
                                          "Extra Approvers Removed",
                                        )}
                                      </p>
                                    </div>
                                  </div>
                                  {/* Divider */}
                                  <div className="mx-4 border-t border-gray-200" />
                                  {/* Names list */}
                                  <div className="px-4 py-3">
                                    <p className="text-xs text-gray-400 mb-2">
                                      {t(
                                        "recallHistory.previousApprovers",
                                        "Previous Extra Approvers:",
                                      )}
                                    </p>
                                    <div className="flex flex-col gap-1">
                                      {names.map((name, i) => (
                                        <div
                                          key={i}
                                          className="flex items-center gap-2"
                                        >
                                          <div
                                            className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                                            style={{ background: "#e9ecef" }}
                                          >
                                            <svg
                                              className="w-3 h-3"
                                              style={{ color: "#6c757d" }}
                                              fill="currentColor"
                                              viewBox="0 0 24 24"
                                            >
                                              <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
                                            </svg>
                                          </div>
                                          <span className="text-sm text-gray-700">
                                            {name.replace(/^-\s*/, "")}
                                          </span>
                                        </div>
                                      ))}
                                    </div>

                                    {/*Comment Output */}
                                    {!isLegacy && originalComment && (
                                      <div className="mt-3 bg-white p-3 rounded-lg border border-gray-100 shadow-sm">
                                        <p className="text-xs text-gray-400 mb-1">
                                          Original Comment:
                                        </p>
                                        <p className="text-sm text-gray-700 whitespace-pre-wrap">
                                          {originalComment}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                  {/* Footer */}
                                  <div className="flex items-center gap-1.5 px-4 pb-3 text-[10px] text-gray-400">
                                    <svg
                                      className="w-3 h-3"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                      strokeWidth={2}
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                                      />
                                    </svg>
                                    <span>
                                      {t(
                                        "recallHistory.recalledBy",
                                        "Recalled by {{name}}",
                                        { name: c.user.name },
                                      )}
                                    </span>
                                    <span>•</span>
                                    <time dateTime={c.createdAt}>
                                      {prettyTime(
                                        c.createdAt,
                                        pickLocale(i18n.language),
                                        t,
                                      )}
                                    </time>
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          );
                        }

                        const isMe = c.user.id === meId;
                        return (
                          <motion.div
                            key={item.id}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.2 }}
                            className={`flex ${isMe ? "justify-end" : "justify-start"}`}
                          >
                            <div
                              className={`flex flex-col bg-white shadow-md p-3 rounded-2xl max-w-[80%] overflow-hidden
                          ${
                            isMe
                              ? "rounded-tr-none bg-gradient-to-br from-[#183E33] to-[#0f2c23] text-white"
                              : "rounded-tl-none"
                          }`}
                            >
                              <div className="flex items-start gap-2 group">
                                {isMe ? (
                                  <Avatar
                                    name={c.user.name}
                                    src={c.user.profileImage}
                                  />
                                ) : null}

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between mb-1 gap-2">
                                    <p className="text-xs font-semibold truncate">
                                      {isMe ? (
                                        "You"
                                      ) : (
                                        <UserLabel
                                          id={c.user.id}
                                          seed={c.user}
                                        />
                                      )}
                                    </p>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <p className="text-[10px] text-gray-400">
                                        <time
                                          dateTime={c.createdAt}
                                          title={formatAbsolute(
                                            new Date(c.createdAt),
                                            pickLocale(i18n.language),
                                          )}
                                        >
                                          {prettyTime(
                                            c.createdAt,
                                            pickLocale(i18n.language),
                                            t,
                                          )}
                                        </time>
                                      </p>
                                      {isMe && c.hasMentions && (
                                        <button
                                          type="button"
                                          title={t(
                                            "comment.deleteTitle",
                                            "Remove comment",
                                          )}
                                          onClick={() => {
                                            setConfirmDialog({
                                              show: true,
                                              title: t(
                                                "comment.deleteTitle",
                                                "Remove Comment",
                                              ),
                                              message: t(
                                                "comment.deleteMessage",
                                                "Are you sure you want to remove this comment? This action cannot be undone.",
                                              ),
                                              btnConfirm: t(
                                                "comment.deleteConfirmBtn",
                                                "Remove",
                                              ),
                                              btnCancel: t(
                                                "extra.btnCancel",
                                                "Cancel",
                                              ),
                                              danger: true,
                                              onConfirm: async () => {
                                                setConfirmDialog({
                                                  show: false,
                                                  message: "",
                                                  onConfirm: () => {},
                                                });
                                                try {
                                                  await deleteCommentApi(c.id);
                                                  setComments((prev) =>
                                                    prev.filter(
                                                      (x) => x.id !== c.id,
                                                    ),
                                                  );
                                                  toast.success(
                                                    t(
                                                      "comment.deleteSuccess",
                                                      "Comment removed",
                                                    ),
                                                  );
                                                } catch {
                                                  toast.error(
                                                    t(
                                                      "comment.deleteFailed",
                                                      "Failed to remove comment",
                                                    ),
                                                  );
                                                }
                                              },
                                            });
                                          }}
                                          className="p-0.5 rounded hover:bg-white/20 text-white/50 hover:text-white/90 transition-colors opacity-0 group-hover:opacity-100"
                                        >
                                          <svg
                                            className="w-3.5 h-3.5"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                          >
                                            <path
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              strokeWidth={2}
                                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                            />
                                          </svg>
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  <p
                                    className="text-sm whitespace-pre-wrap break-words"
                                    style={{ overflowWrap: "break-word" }}
                                  >
                                    {renderWithHighlights(c.comment, c.tags)}
                                  </p>
                                </div>

                                {!isMe ? (
                                  <Avatar
                                    name={c.user.name}
                                    src={c.user.profileImage}
                                  />
                                ) : null}
                              </div>

                              {c.attachments?.length ? (
                                <div className="mt-3 grid gap-2 grid-cols-3 max-sm:grid-cols-2">
                                  {c.attachments.map((att) =>
                                    att.mimetype.startsWith("image/") ? (
                                      <img
                                        key={att.id}
                                        src={att.url}
                                        alt={att.filename}
                                        className={`w-52 h-52 max-sm:w-24 max-sm:h-24 rounded object-cover cursor-pointer hover:opacity-80 ${c.attachments?.length === 1 ? "col-span-2" : ""}`}
                                        onClick={() => setPreviewImage(att.url)}
                                      />
                                    ) : att.mimetype === "application/pdf" ? (
                                      <div
                                        key={att.id}
                                        onClick={() => setPreviewPdf(att.url)}
                                        className={`group flex items-center gap-2 rounded-xl px-4 py-2 shadow cursor-pointer transition-colors col-span-2
          ${
            isMe
              ? "bg-white/10 text-white border border-white/20"
              : "bg-gray-100 text-gray-800 border border-gray-200"
          }
          w-full max-w-full`}
                                      >
                                        <AiFillFilePdf className="w-8 h-8 shrink-0" />
                                        <span
                                          className="flex-1 min-w-0 truncate"
                                          title={att.filename}
                                        >
                                          {att.filename}
                                        </span>
                                      </div>
                                    ) : (
                                      <div
                                        key={att.id}
                                        className="group flex items-center gap-2 px-3 py-2 rounded-lg bg-[#0084FF] text-white hover:bg-[#006FCC] transition-colors shadow-sm w-full max-w-full col-span-2 cursor-pointer"
                                        title={att.filename}
                                        onClick={() => handleDownloadAttachment(att)}
                                      >
                                        <PaperClipIcon className="w-4 h-4 shrink-0" />
                                        <span className="flex-1 min-w-0 truncate">
                                          {att.filename}
                                        </span>
                                        <svg
                                          className="w-4 h-4 shrink-0"
                                          fill="none"
                                          stroke="currentColor"
                                          viewBox="0 0 24 24"
                                        >
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                          />
                                        </svg>
                                      </div>
                                    ),
                                  )}
                                </div>
                              ) : null}
                            </div>
                          </motion.div>
                        );
                      } else {
                        // =========================== EXTRA APPROVAL CARD ===========================
                        const extra = item.data as any; // Type assertion if needed based on your types
                        const myRow = extra.approvers.find(
                          (a: any) => a.user.id === meId,
                        );
                        const isWaiting = !!myRow && !myRow.status;
                        const isCardActive =
                          extra.status === "PENDING" ||
                          extra.status === "IN_PROGRESS";

                        // ✅ Extract the actual comment object whether it's an array or a single object
                        const rawComment = Array.isArray(extra.comment) 
                          ? (extra.comment.length > 0 ? extra.comment[0] : null) 
                          : extra.comment;

                        const commentText = typeof rawComment === "string" 
                          ? rawComment 
                          : (rawComment && typeof rawComment === "object" ? rawComment.comment : null);

                        return (
                          <motion.div
                            key={item.id}
                            initial={{ opacity: 0, y: 10, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            transition={{ duration: 0.3 }}
                          >
                            <div className="border border-gray-200 rounded-xl shadow-sm bg-white overflow-hidden w-full max-w-md mx-auto ring-1 ring-black/5">
                              <div className="bg-gray-50/80 px-4 py-3 border-b border-gray-200">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <div>
                                      <h3 className="font-bold text-gray-900 text-sm leading-tight">
                                        {t(
                                          "extra.requestTitle",
                                          "Approval Request",
                                        )}
                                      </h3>
                                      <div className="flex items-center gap-1.5 mt-0.5">
                                        <span className="text-[10px] uppercase tracking-wider font-semibold text-gray-500">
                                          {t("extra.type", "EXTRA")}
                                        </span>
                                        <span className="text-[10px] text-gray-400">
                                          •{" "}
                                          {prettyTime(
                                            item.date.toISOString(),
                                            pickLocale(i18n.language),
                                            t,
                                          )}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                  <span
                                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border uppercase tracking-wide ${
                                      extra.status === "COMPLETED"
                                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                        : extra.status === "REJECTED"
                                          ? "bg-rose-50 text-rose-700 border-rose-200"
                                          : "bg-amber-50 text-amber-700 border-amber-200"
                                    }`}
                                  >
                                    {extra.status}
                                  </span>
                                </div>
                                {/* ✅ Display comment prominently in header (Modal) */}
                                {commentText && (
                                  <div className="mt-3 p-3 bg-white/60 border border-gray-200 rounded-lg">
                                    <p className="text-xs font-semibold text-gray-600 mb-1.5">
                                      {t("extra.commentLabel", "Comment / Reason")}:
                                    </p>
                                    <p className="text-[15px] text-gray-900 font-medium whitespace-pre-wrap break-words leading-relaxed">
                                      {commentText}
                                    </p>
                                  </div>
                                )}
                              </div>
                              <div className="p-4 bg-white">
                                <div className="space-y-3">
                                  {extra.approvers.map((a: any) => {
                                    const statusName =
                                      a.status?.name ?? "Waiting";
                                    const fullName =
                                      [a.user.name, a.user.lastname]
                                        .filter(Boolean)
                                        .join(" ") +
                                      (a.user.nickname
                                        ? ` (${a.user.nickname})`
                                        : "");

                                    return (
                                      <div
                                        key={a.id}
                                        className="flex items-center justify-between group"
                                      >
                                        <div className="flex items-center gap-3 min-w-0">
                                          <Avatar
                                            name={
                                              fullName || `User #${a.user.id}`
                                            }
                                            src={
                                              a.user.profileImagePath
                                                ? toSecureUploadUrl(
                                                    a.user.profileImagePath,
                                                  )
                                                : null
                                            }
                                            userId={a.user.id}
                                            sizeClass="w-8 h-8"
                                          />
                                          <div className="flex flex-col min-w-0">
                                            <span className="text-sm font-medium text-gray-900 truncate">
                                              {fullName || `User #${a.user.id}`}
                                            </span>
                                            <span className="text-xs text-gray-500">
                                              {statusName}
                                              {a.actedAt &&
                                                ` • ${prettyTime(
                                                  a.actedAt,
                                                  pickLocale(i18n.language),
                                                  t,
                                                )}`}
                                            </span>
                                          </div>
                                        </div>
                                        {statusName === "Approved" ? (
                                          <div className="text-emerald-500 bg-emerald-50 p-1.5 rounded-full">
                                            <svg
                                              className="w-4 h-4"
                                              fill="none"
                                              viewBox="0 0 24 24"
                                              stroke="currentColor"
                                            >
                                              <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth={2}
                                                d="M5 13l4 4L19 7"
                                              />
                                            </svg>
                                          </div>
                                        ) : statusName === "Rejected" ? (
                                          <div className="text-amber-500 bg-amber-50 p-1.5 rounded-full">
                                            <svg
                                              className="w-4 h-4"
                                              fill="none"
                                              viewBox="0 0 24 24"
                                              stroke="currentColor"
                                            >
                                              <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth={2}
                                                d="M6 18L18 6M6 6l12 12"
                                              />
                                            </svg>
                                          </div>
                                        ) : (
                                          <div className="text-amber-500 bg-amber-50 p-1.5 rounded-full">
                                            <FiClock className="w-4 h-4" />
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                              <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex flex-wrap gap-3 items-center justify-between">
                                {isWaiting && isCardActive && !isExpired && (
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={async () => {
                                        if (
                                          hideExtraButton ||
                                          !memoId ||
                                          !extra
                                        )
                                          return;
                                        try {
                                          await actExtra(
                                            memoId,
                                            extra.id,
                                            "approved",
                                          );
                                          await refreshExtraLines();
                                          toast.success("อนุมัติ (Extra) แล้ว");
                                        } catch {
                                          toast.error("Failed");
                                        }
                                      }}
                                      disabled={hideExtraButton}
                                      className="px-4 py-1.5 bg-emerald-600 text-white text-sm font-bold rounded-lg hover:bg-emerald-700 shadow-sm transition-all"
                                    >
                                      {t("extra.approve", "Approve")}
                                    </button>
                                    <button
                                      onClick={async () => {
                                        if (
                                          hideExtraButton ||
                                          !memoId ||
                                          !extra
                                        )
                                          return;
                                        if (!confirm("Are you sure?")) return;
                                        try {
                                          await actExtra(
                                            memoId,
                                            extra.id,
                                            "rejected",
                                          );
                                          await refreshExtraLines();
                                          toast.success("ปฏิเสธ (Extra) แล้ว");
                                        } catch {
                                          toast.error("Failed");
                                        }
                                      }}
                                      disabled={hideExtraButton}
                                      className="px-4 py-1.5 bg-amber-600 text-white text-sm font-bold rounded-lg hover:bg-amber-700 transition-all"
                                    >
                                      {t("extra.reject", "Reject")}
                                    </button>
                                  </div>
                                )}
                                {extra.status === "PENDING" &&
                                  extra.createdById === meId &&
                                  memoId && (
                                    <button
                                      onClick={() => {
                                        setConfirmDialog({
                                          show: true,
                                          title: t(
                                            "extra.removeLineTitle",
                                            "Remove Approval Line",
                                          ),
                                          message: t(
                                            "extra.removeLineMessage",
                                            "Are you sure you want to remove this extra approval line? This action cannot be undone.",
                                          ),
                                          btnConfirm: t(
                                            "extra.removeLineConfirmBtn",
                                            "Remove",
                                          ),
                                          btnCancel: t(
                                            "extra.btnCancel",
                                            "Cancel",
                                          ),
                                          danger: true,
                                          onConfirm: async () => {
                                            setConfirmDialog((prev) => ({
                                              ...prev,
                                              isLoading: true,
                                            }));
                                            try {
                                              await removeExtraLine(
                                                memoId,
                                                extra.id,
                                              );
                                              await refreshExtraLines();
                                              toast.success(
                                                t(
                                                  "extra.removeLineSuccess",
                                                  "Approval line removed",
                                                ),
                                              );
                                              setConfirmDialog({
                                                show: false,
                                                message: "",
                                                onConfirm: () => {},
                                              });
                                            } catch {
                                              toast.error(
                                                t(
                                                  "extra.removeLineFailed",
                                                  "Failed to remove approval line",
                                                ),
                                              );
                                              setConfirmDialog((prev) => ({
                                                ...prev,
                                                isLoading: false,
                                              }));
                                            }
                                          },
                                        });
                                      }}
                                      className="px-3 py-1.5 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors ml-auto"
                                    >
                                      {t("extra.removeLineBtn", "Remove")}
                                    </button>
                                  )}
                              </div>
                            </div>
                          </motion.div>
                        );
                      }
                    });
                  })()}
                </AnimatePresence>
              )}
            </div>

            {/* Modal Footer - Input Area */}

            <div
              className={`border-t border-gray-200 p-4 transition-colors ${
                isDragging ? "bg-indigo-50" : "bg-white"
              }`}
            >
              <input
                id="modal-comment-attach"
                type="file"
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);

                  if (!files.length) return;

                  // Validate file types and sizes
                  const ALLOWED_TYPES = [
                    "image/png",
                    "image/jpeg",
                    "image/jpg",
                    "image/gif",
                    "image/webp",
                    "application/pdf",
                    "application/msword",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "application/vnd.ms-powerpoint",
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    "application/vnd.ms-excel",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "text/csv",
                    "application/csv",
                  ];

                  const ALLOWED_EXTENSIONS = [
                    ".png",
                    ".jpg",
                    ".jpeg",
                    ".gif",
                    ".webp",
                    ".pdf",
                    ".doc",
                    ".docx",
                    ".ppt",
                    ".pptx",
                    ".xls",
                    ".xlsx",
                    ".csv",
                  ];

                  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

                  const invalidFiles: string[] = [];
                  const oversizedFiles: string[] = [];
                  const validFiles: File[] = [];

                  files.forEach((file) => {
                    const ext =
                      "." + (file.name.split(".").pop()?.toLowerCase() || "");
                    const isValidType =
                      ALLOWED_TYPES.includes(file.type) ||
                      ALLOWED_EXTENSIONS.includes(ext);
                    const isValidSize = file.size <= MAX_FILE_SIZE;

                    if (!isValidType) {
                      invalidFiles.push(file.name);
                    } else if (!isValidSize) {
                      oversizedFiles.push(file.name);
                    } else {
                      validFiles.push(file);
                    }
                  });

                  // Show error messages
                  if (invalidFiles.length > 0) {
                    toast.error(
                      `Unsupported file type: ${invalidFiles.join(", ")}. Only images, PDF, Word, Excel, and PowerPoint files are allowed.`,
                    );
                  }

                  if (oversizedFiles.length > 0) {
                    toast.error(
                      `File too large: ${oversizedFiles.join(", ")}. Maximum size is 50MB per file.`,
                    );
                  }

                  // Add valid files
                  if (validFiles.length > 0) {
                    setAttachments((prev) => {
                      const combined = [...prev, ...validFiles];
                      if (combined.length > 6) {
                        toast.error("Maximum 6 files can be attached.");
                        return combined.slice(0, 6);
                      }
                      return combined;
                    });
                  }

                  // Reset input
                  e.target.value = "";
                }}
              />

              {/* Container for Input + Highlight Overlay with gray background */}
              <div className="relative group bg-gray-100 rounded-lg p-3 mb-3">
                {/* Mirror Overlay for Highlights */}
                <div
                  ref={mirrorRef}
                  aria-hidden="true"
                  className="absolute inset-0 w-full px-3 py-3 text-sm leading-5 font-sans whitespace-pre-wrap break-words pointer-events-none overflow-visible rounded-lg"
                  style={{
                    top: 0,
                    left: 0,
                    paddingRight: "12px",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                  }}
                >
                  <div className="text-gray-900">
                    {renderWithHighlights(newComment)}
                    {newComment.endsWith("\n") && <br />}
                  </div>
                </div>

                <textarea
                  ref={taRef}
                  className="relative z-10 w-full rounded-lg px-0 py-0 text-sm focus:outline-none leading-5 bg-transparent text-transparent caret-gray-900 placeholder:text-gray-400 selection:bg-blue-400 selection:text-white scrollbar-hide resize-none"
                  rows={3}
                  wrap="soft"
                  placeholder={t("comment.inputPlaceholder")}
                  value={newComment}
                  onChange={handleTextareaChange}
                  onScroll={handleScroll}
                  onPaste={handlePaste}
                  onInput={autoResize}
                  onFocus={autoResize}
                  onClick={updateSelection}
                  onKeyUp={updateSelection}
                  onSelect={updateSelection}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !mentionOpen) {
                      e.preventDefault();
                      handleAdd();
                    }
                    // Handle mention dialog keyboard navigation
                    if (mentionOpen && candidates.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setActiveIdx((v) => (v + 1) % candidates.length);
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setActiveIdx(
                          (v) =>
                            (v - 1 + candidates.length) % candidates.length,
                        );
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        applyCandidate(candidates[activeIdx]);
                      } else if (e.key === "Tab") {
                        e.preventDefault();
                        applyCandidate(candidates[activeIdx]);
                      }
                    }
                    if (e.key === "Escape" && mentionOpen) {
                      e.preventDefault();
                      closeMention();
                    }
                  }}
                  style={{
                    overflowY: "hidden",
                    wordBreak: "break-word",
                    overflowWrap: "anywhere",
                    scrollbarWidth: "none",
                    msOverflowStyle: "none",
                  }}
                />

                {/* Preview Area (Grid 3 Columns) - Inside gray box, below text */}
                {previewUrls.length > 0 && (
                  <div className="mt-3 grid grid-cols-4 max-sm:grid-cols-3 gap-2">
                    {previewUrls.map((url, i) => {
                      const file = attachments[i];
                      const isPdf = file?.type === "application/pdf";
                      return (
                        <div
                          key={url}
                          className={`relative group ${isPdf ? "col-span-3 h-14 flex items-center gap-3 px-3 bg-white border border-gray-200 rounded-lg" : "w-32 h-32"}`}
                        >
                          {isPdf ? (
                            <>
                              <AiFillFilePdf className="w-6 h-6 text-red-500 shrink-0" />
                              <span className="text-sm text-gray-700 truncate">
                                {file?.name ||
                                  t("comment.pdfDocument", "PDF Document")}
                              </span>
                            </>
                          ) : (
                            <img
                              src={url}
                              className="w-32 h-32 object-cover rounded-lg border border-gray-200"
                            />
                          )}

                          {/* Remove Button */}
                          <button
                            type="button"
                            onClick={() => {
                              setAttachments((prev) =>
                                prev.filter((_, idx) => idx !== i),
                              );
                            }}
                            className={`absolute bg-black/50 hover:bg-red-500 text-white p-1.5 rounded-full transition-colors opacity-0 group-hover:opacity-100 ${isPdf ? "right-2" : "top-1 right-1"}`}
                            title="Remove"
                          >
                            <FiX className="w-4 h-4" />
                          </button>

                          {/* Preview Button */}
                          <button
                            type="button"
                            onClick={() => {
                              if (isPdf) {
                                setPreviewPdf(url);
                              } else {
                                setPreviewImage(url);
                              }
                            }}
                            className={`absolute text-white p-1.5 rounded-full transition-all opacity-0 group-hover:opacity-100 ${isPdf ? "right-10 bg-black/50 hover:bg-black/70" : "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 scale-90 group-hover:scale-100"}`}
                            title="Preview"
                          >
                            <FiEye className="w-4 h-4" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Inline mention dropdown */}
                {mentionOpen && (
                  <div
                    className="absolute bottom-full left-0 right-0 mb-2 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-48 overflow-auto"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {candidates.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-gray-500">
                        {mentionQuery.trim()
                          ? t("mention.noResults")
                          : t("mention.hint")}
                      </div>
                    ) : (
                      candidates.map((u, idx) => (
                        <button
                          key={u.id}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyCandidate(u);
                          }}
                          className={`w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-gray-50 transition-colors ${
                            idx === activeIdx
                              ? "bg-blue-50 border-l-2 border-blue-500"
                              : ""
                          }`}
                        >
                          <Avatar
                            name={formatMentionLabel(u)}
                            src={
                              u.profileImageUrl
                                ? toSecureUploadUrl(u.profileImageUrl)
                                : null
                            }
                            userId={u.id}
                            sizeClass="w-7 h-7"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900 truncate">
                              {formatMentionLabel(u)}
                            </div>
                            {u.email && (
                              <div className="text-xs text-gray-500 truncate">
                                {u.email}
                              </div>
                            )}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Action buttons row at bottom */}
              <div className="flex items-center gap-2">
                <label
                  htmlFor="modal-comment-attach"
                  title={t("comment.attachFile", "Attach file")}
                  className="inline-flex items-center justify-center p-2 rounded-full border border-gray-200 hover:bg-gray-100 text-gray-700 cursor-pointer transition-colors"
                >
                  <PaperClipIcon className="w-5 h-5" />
                </label>

                {/* Create Extra Line Button */}
                <button
                  type="button"
                  title={
                    !isProcessing
                      ? t("extra.notProcessingWarning")
                      : t("extra.create", "Add Extra Approval")
                  }
                  disabled={isExpired || !isProcessing}
                  onClick={() => {
                    if (isExpired || !isProcessing) return;
                    setMentionOpen(false);
                    setExtraOpen(true);
                  }}
                  className="inline-flex items-center justify-center p-2 rounded-full border border-gray-200 hover:bg-gray-100 text-emerald-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <FaUserPlus className="w-5 h-5" />
                </button>

                <div className="flex-1"></div>

                <button
                  onClick={handleAdd}
                  disabled={!newComment.trim() && attachments.length === 0}
                  className="p-2 rounded-full bg-[#183e33] hover:bg-green-700 disabled:bg-gray-300 transition"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="w-5 h-5 text-white"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Custom Confirmation Dialog */}
      {confirmDialog.show && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-[90vw] max-w-md p-6 border border-gray-200">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                {confirmDialog.title || t("extra.confirmTitle")}
              </h3>
              <p className="text-sm text-gray-600 mb-3">
                {confirmDialog.message}
              </p>

              {/* Comment textarea (conditional) */}
              {confirmDialog.showCommentInput && (
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t("extra.commentLabel", "Comment / Reason")}
                  </label>
                  <textarea
                    value={dialogCommentText}
                    onChange={(e) => setDialogCommentText(e.target.value)}
                    placeholder={
                      confirmDialog.commentPlaceholder ||
                      t("extra.commentPlaceholder", "Enter reason (optional)")
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent resize-none text-sm"
                    rows={3}
                    maxLength={500}
                  />
                  <div className="mt-1 text-xs text-gray-500 text-right">
                    {dialogCommentText.length}/500
                  </div>
                </div>
              )}
            </div>
            <div className="flex gap-3 justify-end mt-6">
              <button
                disabled={confirmDialog.isLoading}
                onClick={() => {
                  setConfirmDialog({
                    show: false,
                    message: "",
                    onConfirm: () => {},
                  });
                  setDialogCommentText("");
                }}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {confirmDialog.btnCancel || t("extra.btnCancel")}
              </button>
              <button
                disabled={confirmDialog.isLoading}
                onClick={() => confirmDialog.onConfirm(dialogCommentText)}
                className={`px-4 py-2 rounded-lg text-white transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 ${
                  confirmDialog.danger
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-emerald-600 hover:bg-emerald-700"
                }`}
              >
                {confirmDialog.isLoading && (
                  <svg
                    className="animate-spin w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                )}
                {confirmDialog.isLoading
                  ? t("extra.saving", "กำลังบันทึก...")
                  : confirmDialog.btnConfirm || t("extra.btnConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Preview Modal (High Z-Index) */}
      {previewImage && (
        <div
          className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center"
          onClick={() => setPreviewImage(null)}
        >
          <button
            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors backdrop-blur-sm"
            onClick={(e) => {
              e.stopPropagation();
              setPreviewImage(null);
            }}
          >
            <FiX className="w-6 h-6" />
          </button>
          <img
            src={previewImage || ""}
            alt="Full preview"
            className="max-w-[90vw] max-h-[90vh] rounded shadow-lg"
          />
        </div>
      )}

      {previewPdf && (
        <PdfOverlay
          src={previewPdf}
          downloadUrl={previewPdf} // In this context, the src is the download URL
          onClose={() => {
            setPreviewPdf(null);
            setPdfLoadError(false);
            setPdfReloadKey(0);
          }}
        />
      )}
    </section>
  );
};

export default CommentSection;
