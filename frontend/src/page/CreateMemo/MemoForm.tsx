import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import axios, { type AxiosProgressEvent, type AxiosRequestConfig } from "axios";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Marker } from "./Marker";
import toast from "react-hot-toast";
import { AiFillCaretRight, AiFillCaretLeft } from "react-icons/ai";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import type { DropResult } from "@hello-pangea/dnd";
import { Eye, Signature, UserPlus, Users, Mail, Building2, Plus, Search, Loader2, X, ChevronUp, ChevronDown, Minus, Maximize } from "lucide-react";
import { toSecureUploadUrl } from "../../lib/files";
import DateTimeInline from "./DateTimeInline";
import { createPortal, flushSync } from "react-dom";
import { api } from "../../lib/api";
import { ReferenceMemoSelector } from "../../components/ReferenceMemo";
import type { ReferenceMemoSummary } from "../../components/ReferenceMemo";
import "./CreateMemo.css";

const formatCC = (u: {
  name?: string;
  lastname?: string | null; // camel-case แบบเดิม
  lastName?: string | null; // Pascal camel จาก API
  nickname?: string | null;
  nickName?: string | null;
  email?: string;
}) => {
  const ln = (u as any).lastname ?? (u as any).lastName ?? null;
  const nn = (u as any).nickname ?? (u as any).nickName ?? null;
  const base = [u?.name, ln].filter(Boolean).join(" ").trim();
  return nn ? `${base} (${nn})` : base || u?.email || "";
};

const pickAvatarPath = (obj: any) =>
  obj?.profileImageUrl ??
  obj?.profileImagePath ??
  obj?.profileImage ??
  obj?.avatarUrl ??
  obj?.avatarPath ??
  obj?.imageUrl ??
  obj?.photoUrl ??
  obj?.profile_image_url ??
  obj?.profileImageRelativePath ??
  obj?.profile?.imageUrl ?? // ⬅️ nested ที่เจอบ่อย
  obj?.profile?.avatarUrl ?? // ⬅️ nested
  null;

const toUserLite = (src: any): UserLite => {
  const obj = src?.user ? { ...src.user, id: src.user.id ?? src.userId } : src;
  const ln = obj.lastname ?? obj.lastName ?? null;
  const nn = obj.nickname ?? obj.nickName ?? null;

  const raw = pickAvatarPath(obj);
  const abs = raw ? toSecureUploadUrl(raw) : null;

  return {
    id: obj.id ?? src.userId,
    name: obj.name,
    lastname: ln,
    nickname: nn,
    email: obj.email,
    team: obj.team?.name ?? obj.team ?? null,
    department: obj.department?.name ?? obj.department ?? null,
    profileImageUrl: abs,
  };
};

const toCcGroupLite = (src: any): CcGroupLite => {
  const id = src.id ?? src.groupId ?? src.group?.id ?? null;
  const name = src.name ?? src.group?.name ?? "";
  const membersRaw =
    src.previewMembers ??
    src.members ??
    src.group?.previewMembers ??
    src.group?.members ??
    [];

  const memberCount = Number.isFinite(Number(src.memberCount))
    ? Number(src.memberCount)
    : Number.isFinite(Number(src.count))
      ? Number(src.count)
      : (membersRaw ?? []).length;

  const membersLite = (membersRaw ?? []).map(toUserLite);

  return {
    id,
    name,
    memberCount,
    previewMembers: membersLite, // 👈 ตอนนี้คือ “เต็มชุด” ไม่หั่นแล้ว
    memberIds: Array.isArray((src as any).memberIds)
      ? (src as any).memberIds
      : membersLite.map((m: { id: any }) => m.id), // optional เผื่อใช้กับ /basic-info
  };
};

// สร้าง src รูปให้พร้อมใช้ (มี fallback)
const getAvatarSrc = (url: string | null | undefined, _id?: number) =>
  url ?? null;

interface BusinessUnit {
  id: number;
  name: string;
  abbreviation?: string | null;
}

interface Department {
  id: number;
  name: string;
  abbreviation?: string | null;
}

interface ExistingFile {
  id: number;
  fileName: string;
  url?: string;
  pageCount?: number;
}

interface User {
  id: number;
  name: string;
  lastname?: string | null;
  nickname?: string | null;
  email: string;
}

interface Level {
  level: number;
  name: string;
  users: {
    loaUserPivotId: number;
    status: string;
    isSigReq: boolean;
    user: User;
  }[];
}

interface FilePosition {
  id: string | number;
  userId: number;
  fileId?: number;
  page: number;
  x: number;
  y: number;
  sizePct?: number;
  date?: string;
  level?: number; // Approval level this position belongs to
}
interface MemoNumberDbPosition {
  id: string | number;
  fileId?: number;
  page: number;
  x: number;
  y: number;
  sizePct?: number;
}
interface MemoData {
  subject: string;
  memoType?: { id: number };
  mainFiles: ExistingFile[];
  attachedFiles?: ExistingFile[];
  signaturePositions?: FilePosition[];
  datePositions?: FilePosition[];
  notePositions?: (FilePosition & { text: string })[];
  memoNumberPositions?: MemoNumberDbPosition[];
  expiresAt?: string | null;
}

interface Approver {
  id: number;
  name: string;
  lastname?: string | null;
  nickname?: string | null;
  role: string;
  level: number;
  loaUserPivotId: number;
  status: string;
  isSigReq: boolean;
  displayName?: string;

  // ⬇⬇ แก้สองบรรทัดนี้
  slotType?:
  | "FIXED_USER"
  | "MEMO_REQUESTER"
  | "DEPARTMENT_HEAD"
  | "FLEXIBLE_SLOT"
  | null;
  roleDescription?: string | null;
  approvalRequirement?: "ALL" | "ANY";

  isFlexibleSlot?: boolean;
  wasFlexibleSlot?: boolean; // ✅ NEW: เคยเป็น flexible มาก่อนหรือไม่

  // Delegation fields
  originalApproverId?: number; // Original approver ID before delegation
  originalApproverName?: string; // Original approver name before delegation
  isDelegated?: boolean; // Whether this approver is delegated
  templatePivotId?: number | null;
}

interface ApprovalLine {
  id: number;
  name: string;
  levels: Level[];
}

interface SignaturePosition {
  id: string;
  fileIdx: number;
  userId: number;
  pageInFile: number;
  x: number;
  y: number;
  sizePct: number;
  level?: number; // Approval level this signature belongs to
}

interface DatePosition {
  id: string;
  fileIdx: number;
  userId: number;
  pageInFile: number;
  x: number;
  y: number;
  date: string;
  sizePct: number;
  level?: number; // Approval level this date belongs to
}

interface NotePosition {
  id: string;
  fileIdx: number;
  pageInFile: number;
  x: number;
  y: number;
  text: string;
  sizePct: number;
}

interface MemoNumberPosition {
  id: string;
  fileIdx: number;
  pageInFile: number;
  x: number;
  y: number;
  sizePct: number;
}

export type MemoFormProps = {
  mode: "create" | "edit";
  memoId?: number;

  // 👉 callback หลังเซฟเสร็จ
  onSaved?: () => void;

  // 👉 callback ตอนกด Cancel (รองรับ async ด้วย)
  onCancel?: () => void | Promise<void>;
};

type OrderToken =
  | { token: `old:${number}`; kind: "old"; oldId: number } // ไฟล์เก่าจาก DB
  | { token: `new:${number}`; kind: "new"; newIdx: number }; // ไฟล์ใหม่ (index ใน state files)
type UserLite = {
  id: number;
  name: string;
  lastname?: string | null; // 👈 เพิ่ม
  nickname?: string | null;
  email: string;
  team?: string | null;
  department?: string | null;
  profileImageUrl: string | null; // 👈 เปลี่ยนจาก profileImage เป็น profileImageUrl
};
type CcGroupLite = {
  id: number;
  name: string;
  memberCount: number;
  previewMembers?: UserLite[];
  memberIds?: number[]; // 👈 add
};

const makeOldToken = (id: number): OrderToken => ({
  token: `old:${id}`,
  kind: "old",
  oldId: id,
});
const makeNewToken = (idx: number): OrderToken => ({
  token: `new:${idx}`,
  kind: "new",
  newIdx: idx,
});
interface FileSource {
  file?: File;
  url?: string;
  arrayBuffer?: ArrayBuffer;
}

interface MemoType {
  id: number;
  name: string;
  team?: { id: number; name: string } | null;
  abbreviation?: string;
  businessUnit?: { id: number; name: string } | null;
  department?: { id: number; name: string } | null; // ✅ Add department from memotype
  approvalLineId?: number | null; // Add approval line ID for automatic selection
  defaultTypeFileId?: number | null;
}

type TypeMainFile = {
  id: number;
  fileName: string;
  filePath: string;
  size: number;
  orderNo: number;
};

const sigKey = (ap: Approver, idx?: number) =>
  ap.loaUserPivotId && ap.loaUserPivotId !== 0
    ? ap.loaUserPivotId
    : ap.id ?? idx!;

// Helper function to format file size
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

// ✅ UNIVERSAL AVATAR (no DiceBear)
const getInitials = (
  name?: string,
  lastname?: string | null,
  email?: string
) => {
  const base = [name, lastname].filter(Boolean).join(" ").trim() || email || "";
  if (!base) return "U";
  const parts = base.split(/\s+/).filter(Boolean);
  const initials = (parts[0]?.[0] || "") + (parts[1]?.[0] || "");
  return initials.toUpperCase().slice(0, 2) || "U";
};

type AvatarProps = {
  url?: string | null;
  name?: string;
  lastname?: string | null;
  email?: string;
  /** xs=20px, sm=32px, md=40px, lg=48px */
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  title?: string;
};

const sizeToClass = (s: AvatarProps["size"]) => {
  switch (s) {
    case "xs":
      return { box: "w-5 h-5", text: "text-[10px]" };
    case "sm":
      return { box: "w-8 h-8", text: "text-sm" };
    case "lg":
      return { box: "w-12 h-12", text: "text-lg" };
    case "md":
    default:
      return { box: "w-10 h-10", text: "text-base" };
  }
};

const Avatar: React.FC<AvatarProps> = ({
  url,
  name,
  lastname,
  email,
  size = "sm",
  className = "",
  title,
}) => {
  const [broken, setBroken] = React.useState(false);
  const s = sizeToClass(size);
  const initials = getInitials(name, lastname, email);
  const alt =
    title || [name, lastname].filter(Boolean).join(" ") || email || "avatar";

  if (url && !broken) {
    return (
      <img
        src={url}
        alt={alt}
        title={alt}
        className={`${s.box} rounded-full object-cover ${className}`}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)} // ⬅️ ถ้าโหลดรูปพัง → ใช้อักษรย่อแทน
      />
    );
  }

  // ⬇️ Fallback: วงกลมอักษรย่อ พร้อมไล่เฉดสีตามที่กำหนด
  return (
    <div
      className={`${s.box} rounded-full bg-gradient-to-r from-[#00ffaa] to-[#00cc88] 
                  flex items-center justify-center font-bold text-gray-900 ${className}`}
      title={alt}
      aria-label={alt}
    >
      <span className={s.text}>{initials}</span>
    </div>
  );
};

const MemoForm: React.FC<MemoFormProps> = ({ mode, memoId }) => {
  const { t } = useTranslation("memoForm");
  const [searchParams] = useSearchParams();
  const [fileUrls, setFileUrls] = useState<FileSource[]>([]);
  const [step, setStep] = useState(1);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [userId, setUserId] = useState<number | "">("");
  const [subject, setSubject] = useState("");
  const [memoNumber, setMemoNumber] = useState<string>("");
  const [businessUnitId, setBusinessUnitId] = useState<number | "">("");
  const [departmentId, setDepartmentId] = useState<number | "">("");
  const [businessUnits, setBusinessUnits] = useState<BusinessUnit[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [approvalLines, setApprovalLines] = useState<ApprovalLine[]>([]);
  const [statusId] = useState<1>(1);
  const [flashMissingIdxs, setFlashMissingIdxs] = useState<number[]>([]);
  const originalApproversRef = useRef<Approver[] | null>(null);
  const [selectedApprovalLine, setSelectedApprovalLine] =
    useState<ApprovalLine | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [existingMainFiles, setExistingMainFiles] = useState<ExistingFile[]>(
    []
  );
  const [saving, setSaving] = useState(false);
  const [removedExistingFileIds, setRemovedExistingFileIds] = useState<
    number[]
  >([]);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [attachedFileUrls, setAttachedFileUrls] = useState<FileSource[]>([]);
  const [existingAttachedFiles, setExistingAttachedFiles] = useState<
    ExistingFile[]
  >([]);
  const [removedAttachedFileIds, setRemovedAttachedFileIds] = useState<
    number[]
  >([]);
  const [urlLinks, setUrlLinks] = useState<Array<{ url: string; title: string }>>([]);
  const [urlInput, setUrlInput] = useState("");
  const [urlTitleInput, setUrlTitleInput] = useState("");
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [orderTokens, setOrderTokens] = useState<OrderToken[]>([]);
  const [originalApprovalLineId, setOriginalApprovalLineId] = useState<
    number | null
  >(null);
  const [hideSigBtn, setHideSigBtn] = useState<Record<number, boolean>>({});

  const [memoTypeName, setMemoTypeName] = useState<string>("");
  const isSigRequired = (ap: Approver, idx: number) => wantSigOf(ap, idx);
  const wantSigOf = (ap: Approver, idx: number) => {
    const k = sigKey(ap, idx);
    if (k in hideSigBtn) return !hideSigBtn[k]; // ถ้าเคยกด toggle ใช้ค่านี้
    return ap.isSigReq ?? true; // ถ้าไม่เคยเปลี่ยน ใช้ค่าที่มาจาก backend
  };
  const toggleSigRequired = (ap: Approver, idx: number) => {
    const k = sigKey(ap, idx);
    setCanSaveLine(true);

    // คำนวณ state ถัดไปของ "ซ่อน/ไม่ต้องเซ็น"
    const nextHide = k in hideSigBtn ? !hideSigBtn[k] : !(ap.isSigReq ?? true);

    setHideSigBtn((prev) => {
      const prevHide = k in prev ? prev[k] : !(ap.isSigReq ?? true);
      return { ...prev, [k]: !prevHide };
    });

    // ถ้ากลายเป็น "ไม่ต้องเซ็น" → ล้าง marker ของคนนั้นให้หมด
    if (nextHide) {
      setSigPositions((prev) => {
        const copy = { ...prev };
        delete copy[idx];
        return copy;
      });
      setDatePositions((prev) => {
        const copy = { ...prev };
        delete copy[idx];
        return copy;
      });
    }
  };
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomLevel, setZoomLevel] = useState(1);
  // Chrome-style discrete zoom steps
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  const ZOOM_MIN = ZOOM_STEPS[0];
  const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
  const nextZoomUp = (cur: number) => { for (const s of ZOOM_STEPS) { if (s > cur + 0.001) return s; } return ZOOM_MAX; };
  const nextZoomDown = (cur: number) => { for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) { if (ZOOM_STEPS[i] < cur - 0.001) return ZOOM_STEPS[i]; } return ZOOM_MIN; };
  const pageRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const [loadedPageCounts, setLoadedPageCounts] = useState<number[]>([]);
  // Map: "fileIdx-pageNum" -> widthPt (for A3/A4 mixed-size PDFs)
  const [pageWidthPtMap, setPageWidthPtMap] = useState<Record<string, number>>({});
  const [oldIdToIndex, setOldIdToIndex] = useState<Record<number, number>>({});
  const [placingFor, setPlacingFor] = useState<
    | { type: "signature" | "date" | "both"; approverIndex: number }
    | { type: "memonumber" | "note"; approverIndex: -1 }
    | null
  >(null);

  const [sigPositions, setSigPositions] = useState<
    Record<number, SignaturePosition[]>
  >({});
  const [datePositions, setDatePositions] = useState<
    Record<number, DatePosition[]>
  >({});
  const [notePositions, setNotePositions] = useState<NotePosition[]>([]);
  const [memoNumberPositions, setMemoNumberPositions] = useState<
    MemoNumberPosition[]
  >([]);
  
  // Note input modal state
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteModalText, setNoteModalText] = useState("");
  const [pendingNotePosition, setPendingNotePosition] = useState<{
    fileIdx: number;
    pageInFile: number;
    x: number;
    y: number;
  } | null>(null);
  
  const [applyToAllPagesPerApprover, setApplyToAllPagesPerApprover] = useState<Record<number, boolean>>({});
  const [isPlacingSignatures, setIsPlacingSignatures] = useState(false);
  const [showSignatureLocations, setShowSignatureLocations] = useState<Record<number, boolean>>({});
  const hasLoadedRef = useRef(false);
  const [memoTypes, setMemoTypes] = useState<MemoType[]>([]);
  const [memoTypeId, setMemoTypeId] = useState<number | "">("");
  const [typeFiles, setTypeFiles] = useState<TypeMainFile[]>([]);
  const [typeDefaultFileId, setTypeDefaultFileId] = useState<number | null>(null);
  const [typeLoading, setTypeLoading] = useState(false);
  const [addSelected, setAddSelected] = useState<UserLite[]>([]);
  const [expandedGroup, setExpandedGroup] = useState<Record<number, boolean>>(
    {}
  );
  const [groupMembers, setGroupMembers] = useState<Record<number, UserLite[]>>(
    {}
  );
  const [groupLoading, setGroupLoading] = useState<Record<number, boolean>>({});
  const [isDraggingMain, setIsDraggingMain] = useState(false);
  const [isDraggingAttach, setIsDraggingAttach] = useState(false);
  const isAddSelected = (id: number) => addSelected.some((u) => u.id === id);

  const toggleAddSelect = (u: UserLite) =>
    setAddSelected((prev) =>
      prev.some((x) => x.id === u.id)
        ? prev.filter((x) => x.id !== u.id)
        : [...prev, u]
    );
  // helper: ตรวจว่ามี memberIds จริงไหม
  const hasMemberIds = (
    obj: unknown
  ): obj is CcGroupLite & { memberIds: number[] } => {
    return !!obj && Array.isArray((obj as any).memberIds);
  };

  const toggleGroupInline = async (g: CcGroupLite) => {
    const isCurrentlyExpanded = expandedGroup[g.id];
    
    // If not expanded, expand it. If expanded, collapse it.
    setExpandedGroup((prev) => ({ ...prev, [g.id]: !isCurrentlyExpanded }));

    // If we're collapsing, no need to load members
    if (isCurrentlyExpanded) return;

    // If members are already loaded, no need to fetch again
    if (groupMembers[g.id]?.length) return;

    setGroupLoading((p) => ({ ...p, [g.id]: true }));
    try {
      // 1) ใช้ previewMembers ก่อน
      const seeded = Array.isArray(g.previewMembers)
        ? g.previewMembers.map(toUserLite)
        : [];
      if (seeded.length > 0) {
        setGroupMembers((p) => ({ ...p, [g.id]: seeded }));

        // 🔧 ถ้า preview ขาด lastname/nickname → hydrate เพิ่ม
        const needIds = [
          ...new Set(
            seeded.filter((m) => !m.lastname || !m.nickname).map((m) => m.id)
          ),
        ];
        if (needIds.length) {
          const { data } = await axios.get(`/api/users/basic-info`, {
            params: { ids: needIds.join(",") },
            withCredentials: true,
          });
          const arr = Array.isArray(data?.users)
            ? data.users
            : Array.isArray(data)
              ? data
              : [];
          const map = new Map(arr.map((u: any) => [u.id, u]));
          setGroupMembers((p) => ({
            ...p,
            [g.id]: (p[g.id] || []).map((m) =>
              map.has(m.id) ? toUserLite({ ...m, ...map.get(m.id)! }) : m
            ),
          }));
        }
        return; // ✅ จบเคสมี preview แล้ว
      }

      // 2) ไม่มี preview → ใช้ memberIds (ถ้ามี) ดึงโปรไฟล์เต็ม
      if (hasMemberIds(g)) {
        const ids = [...new Set(g.memberIds)].filter(
          (n) => Number.isFinite(n) && n > 0
        );
        if (ids.length === 0) {
          setGroupMembers((p) => ({ ...p, [g.id]: [] }));
          return;
        }
        await api.get("/api/users/basic-info", {
          params: { ids: ids.join(",") },
        });
      }

      // 3) fallback
      setGroupMembers((p) => ({ ...p, [g.id]: [] }));
    } catch (e) {
      console.error("load group members failed", e);
      const fallback = Array.isArray(g.previewMembers)
        ? g.previewMembers.map(toUserLite)
        : [];
      setGroupMembers((p) => ({ ...p, [g.id]: fallback }));
    } finally {
      setGroupLoading((p) => ({ ...p, [g.id]: false }));
    }
  };

  const clearAddSelection = () => setAddSelected([]);

  // Helper function to resolve delegation for approvers
  const resolveApproverDelegation = useCallback(async (approvers: Approver[]): Promise<Approver[]> => {
    if (approvers.length === 0) return approvers;

    try {
      const { data } = await api.post("/api/memos/users-delegation-info", {
        userIds: approvers.map(ap => ap.id)
      }, { withCredentials: true });

      const delegationMap = new Map();
      data.forEach((info: any) => {
        delegationMap.set(info.originalUserId, info);
      });

      const resolvedApprovers = approvers.map(approver => {
        const delegationInfo = delegationMap.get(approver.id);
        
        if (delegationInfo?.isDelegated && delegationInfo?.effectiveUser) {
          // Create display name for delegated user
          const delegatedDisplayName = [
            delegationInfo.effectiveUser.name, 
            delegationInfo.effectiveUser.lastname
          ].filter(Boolean).join(" ") + 
          (delegationInfo.effectiveUser.nickname ? ` (${delegationInfo.effectiveUser.nickname})` : "");
          
          // Replace the approver with the delegated user
          return {
            ...approver,
            id: delegationInfo.effectiveUser.id,
            name: delegationInfo.effectiveUser.name,
            lastname: delegationInfo.effectiveUser.lastname,
            nickname: delegationInfo.effectiveUser.nickname,
            displayName: delegatedDisplayName, // Update display name
            // Keep original approver info for reference
            originalApproverId: approver.id,
            originalApproverName: delegationInfo.delegationInfo?.originalUserName || approver.displayName || approver.name,
            isDelegated: true
          };
        }
        
        return approver;
      });
      
      return resolvedApprovers;
    } catch (error) {
      console.error("Failed to resolve delegation:", error);
      return approvers; // Return original approvers if delegation resolution fails
    }
  }, []);

  // Load delegation info for approvers
  const loadDelegationInfo = useCallback(async (approverIds: number[]) => {
    if (approverIds.length === 0) {
      setDelegationInfos({});
      return;
    }

    try {
      const { data } = await api.post("/api/memos/users-delegation-info", {
        userIds: approverIds
      }, { withCredentials: true });

      const delegationMap: Record<number, any> = {};
      data.forEach((info: any) => {
        delegationMap[info.originalUserId] = {
          isDelegated: info.isDelegated,
          delegationInfo: info.delegationInfo,
          effectiveUser: info.effectiveUser // The user who should be displayed
        };
      });
      
      setDelegationInfos(delegationMap);
    } catch (error) {
      console.error("Failed to load delegation info:", error);
    }
  }, []);

  // Load delegation info when approvers change
  useEffect(() => {
    const approverIds = approvers
      .filter(a => a.id && !a.isFlexibleSlot)
      .map(a => a.id);
    
    if (approverIds.length > 0) {
      loadDelegationInfo(approverIds);
    }
  }, [approvers, loadDelegationInfo]);

  const [canSaveLine, setCanSaveLine] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const [addQuery, setAddQuery] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addResults, setAddResults] = useState<UserLite[]>([]);

  // Reference memo state
  const [selectedReferences, setSelectedReferences] = useState<ReferenceMemoSummary[]>([]);

  // Delegation state
  const [delegationInfos, setDelegationInfos] = useState<Record<number, {
    isDelegated: boolean;
    delegationInfo?: {
      originalUserId: number;
      originalUserName: string;
      delegatedUserName: string;
      startDate: string;
      endDate: string;
    };
    effectiveUser?: {
      id: number;
      name: string;
      lastname: string | null;
      nickname: string | null;
    };
  }>>({});

  // 👇 วางไว้ใกล้ ๆ helper อื่น ๆ
  const normalizeIsSigReq = (
    raw: any,
    userId: number,
    memo?: MemoData
  ): boolean => {
    const direct =
      raw?.isSigReq ??
      raw?.isSigRequired ??
      raw?.requireSignature ??
      raw?.requiresSignature ??
      raw?.needSignature ??
      raw?.needsSignature;

    if (typeof direct === "boolean") return direct; // ⬅️ เชื่อค่าจาก backend ก่อน

    // ค่อย fallback จาก marker (กรณี backend ไม่มีข้อมูล)
    const markers = memo?.signaturePositions ?? [];
    return Array.isArray(markers) && markers.some((p) => p.userId === userId);
  };

  const extractRequiredMap = (memo: any) => {
    const m = new Map<number, boolean>();

    // เคสที่ดีสุด: มีตาราง action/override ของเมโม (ชื่อฟิลด์แล้วแต่หลังบ้านคุณ)
    const actions =
      memo?.approverActions ??
      memo?.approversOverride ?? // เผื่อชื่อแบบนี้
      memo?.requiredSigners ?? // หรือแบบนี้
      [];

    for (const a of actions) {
      const v =
        a?.isSigReq ??
        a?.isSigRequired ??
        a?.requireSignature ??
        a?.requiresSignature;
      if (typeof v === "boolean") {
        if (Number.isFinite(a?.loaUserPivotId))
          m.set(Number(a.loaUserPivotId), v);
        else if (Number.isFinite(a?.userId)) m.set(Number(a.userId), v);
      }
    }

    // fallback ขั้นสุดท้าย: มี marker = ต้องเซ็น
    for (const p of memo?.signaturePositions ?? []) {
      if (Number.isFinite(p?.userId)) m.set(Number(p.userId), true);
    }
    return m;
  };
  // ===== anchor box for the floating Add User panel =====
  const [anchorBox, setAnchorBox] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // เพิ่มตรงบนไฟล์ (ข้าง ๆ useRef อื่น ๆ)
  const addPanelRef = useRef<HTMLDivElement>(null);

  // แก้ฟังก์ชันเดิม
  const updateAnchorFromEl = (el: HTMLElement | null) => {
    if (!el) return setAnchorBox(null);
    const r = el.getBoundingClientRect();

    // ขนาดจริงของ panel (ถ้าเพิ่งเปิด ยังวัดไม่ได้ ให้เดาไว้ก่อน)
    const panelRect = addPanelRef.current?.getBoundingClientRect();
    const ph = panelRect?.height ?? 0;
    const pwGuess = Math.min(520, window.innerWidth - 24);
    const pw = panelRect?.width ?? pwGuess;

    // clamp ซ้าย/ขวา ไม่ให้ออกนอกขอบ
    const left = Math.max(
      window.scrollX + 12,
      Math.min(
        window.scrollX + r.left,
        window.scrollX + window.innerWidth - pw - 12
      )
    );

    // clamp บน/ล่าง ไม่ให้ออกนอกขอบ (กันล้นล่างด้วยความสูงจริงของ panel)
    const top = Math.max(
      window.scrollY + 12,
      Math.min(
        window.scrollY + r.bottom + 8,
        window.scrollY + window.innerHeight - ph - 12
      )
    );

    setAnchorBox({ top, left, width: pw });
  };

  useEffect(() => {
    if (!addOpen) return;
    const el = (window as any).__flexAnchorEl as HTMLElement | null;

    // วัดหลังเปิด 1 เฟรม เพื่อได้ขนาดจริงของ panel
    const raf = requestAnimationFrame(() => updateAnchorFromEl(el));

    const onMove = (e: Event) => {
      // ✅ ตอนนี้ addPanelRef มีของจริงแล้ว เช็คได้ว่าเลื่อน “ใน” panel ไหม
      if (
        addPanelRef.current &&
        e.target instanceof Node &&
        addPanelRef.current.contains(e.target)
      ) {
        return; // เลื่อนภายใน panel: ไม่ต้อง reposition
      }
      updateAnchorFromEl(el);
    };

    const opts = { passive: true, capture: true } as const;
    window.addEventListener("scroll", onMove, opts);
    window.addEventListener("resize", onMove, opts);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onMove, opts as any);
      window.removeEventListener("resize", onMove, opts as any);
    };
  }, [addOpen]);
  // ใกล้ ๆ useSearchParams()
  // REMOVED: No longer reading typeName from URL to prevent duplicate fetches
  // useEffect(() => {
  //   const n = searchParams.get("typeName");
  //   if (n) setMemoTypeName(decodeURIComponent(n));
  // }, [searchParams]);

  // Clean up flexible slot selection when modal closes
  useEffect(() => {
    if (!addOpen) {
      delete (window as any).selectingForFlexibleSlot;
    }
  }, [addOpen]);

  const { orderedUrls, orderedPageCounts, totalPages } = React.useMemo(() => {
    if (!orderTokens.length) {
      return {
        orderedUrls: [] as FileSource[],
        orderedPageCounts: [] as number[],
        totalPages: 0,
      };
    }

    const urls: FileSource[] = [];
    const pages: number[] = [];
    const oldCount = Object.keys(oldIdToIndex).length;

    for (const tok of orderTokens) {
      if (tok.kind === "old") {
        const oldIdx = oldIdToIndex[tok.oldId];
        if (oldIdx !== undefined && fileUrls[oldIdx]) {
          urls.push(fileUrls[oldIdx]);
          pages.push(loadedPageCounts[oldIdx] || 0);
        }
      } else {
        const idx = oldCount + tok.newIdx;
        if (fileUrls[idx]) {
          urls.push(fileUrls[idx]);
          pages.push(loadedPageCounts[idx] || 0);
        }
      }
    }

    return {
      orderedUrls: urls,
      orderedPageCounts: pages,
      totalPages: pages.reduce((s, c) => s + c, 0),
    };
  }, [orderTokens, fileUrls, loadedPageCounts, oldIdToIndex]);

  const [expiryAtLocal, setExpiryAtLocal] = useState<string>("");
  // ISO -> ค่า string สำหรับ <input type="datetime-local">
  const toDatetimeLocalValue = (iso?: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
      d.getDate()
    )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // ค่า string ของ <input type="datetime-local"> -> ISO (UTC, ลงท้าย Z)
  const fromDatetimeLocalToISO = (local: string) => {
    if (!local) return "";
    const d = new Date(local); // parse แบบ local time
    if (isNaN(d.getTime())) return "";
    return d.toISOString();
  };

  // ด้านบนของ MemoForm component
  const memoTypeInputRef = useRef<HTMLInputElement>(null);

  // ปรับ validateStep1
  const validateStep1 = () => {
    if (subject.trim() === "") {
      toast.error(t("errors.subjectRequired") || "กรุณากรอกหัวข้อเรื่อง");
      subjectRef.current?.focus();
      return false;
    }
    if (memoTypeId === "") {
      toast.error(t("errors.memoTypeRequired") || "กรุณาเลือกประเภทเอกสาร");
      memoTypeInputRef.current?.focus(); // <-- เปลี่ยนมาโฟกัสที่ input ค้นหา
      return false;
    }
    return true;
  };

  const visibleTypeFiles = React.useMemo(() => {
    if (typeDefaultFileId != null) {
      const defaultFile = typeFiles.find((f) => f.id === typeDefaultFileId);
      return defaultFile ? [defaultFile] : typeFiles;
    }
    return typeFiles;
  }, [typeFiles, typeDefaultFileId]);

  // Initialize showTitleEmphasis based on URL params (check if typeId exists)
  const hasTypeIdParam = searchParams.get("typeId") !== null;
  const [showTitleEmphasis, setShowTitleEmphasis] = useState(hasTypeIdParam && mode === "create");
  const [showMainFileEmphasis, setShowMainFileEmphasis] = useState(mode === "create"); // Always show in create mode
  const isProgrammaticFocusRef = useRef(false); // Track if focus was triggered programmatically

  const navigate = useNavigate();
  const subjectRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null); // ← NEW
  const attachedInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus Title input when navigating from document type selection
  useEffect(() => {
    if (mode !== "create") return;
    const typeIdParam = searchParams.get("typeId");

    if (typeIdParam) {
      // Show the emphasis animation
      setShowTitleEmphasis(true);
      // Main file emphasis is always on in create mode, no need to set here

      // Auto-focus the Title input after a short delay to ensure DOM is ready
      const focusTimer = setTimeout(() => {
        isProgrammaticFocusRef.current = true; // Mark as programmatic focus
        subjectRef.current?.focus();
        // Reset the flag after a brief moment
        setTimeout(() => {
          isProgrammaticFocusRef.current = false;
        }, 50);
      }, 100);

      return () => clearTimeout(focusTimer);
    }
  }, [mode, searchParams]);

  const [containerWidth, setContainerWidth] = useState(0);
  // --- CC state ---
  const [ccQuery, setCcQuery] = useState("");
  const [ccResults, setCcResults] = useState<UserLite[]>([]);
  const [ccSelected, setCcSelected] = useState<UserLite[]>([]);
  const [ccLoading, setCcLoading] = useState(false);
  const [isCcOpen, setIsCcOpen] = useState(false);
  const [ccGroupResults, setCcGroupResults] = useState<CcGroupLite[]>([]);
  const [ccSelectedGroups, setCcSelectedGroups] = useState<CcGroupLite[]>([]);

  // (ถ้าอยากมีแท็บกรอง) all / users / groups
  const [ccTab, setCcTab] = useState<"all" | "users" | "groups">("all");
  
  const humanSize = (n?: number) => {
    if (!Number.isFinite(n as number)) return "-";
    let s = Number(n),
      i = 0;
    const u = ["B", "KB", "MB", "GB", "TB"];
    while (i < u.length - 1 && s >= 1024) {
      s /= 1024;
      i++;
    }
    return `${s.toFixed(1)} ${u[i]}`;
  };

  const displayName = (a: Approver | undefined) => {
    if (!a) return "";
    
    // Since we now resolve delegation at load time, just show the current approver's name
    return [a.name, a.lastname].filter(Boolean).join(" ") +
      (a.nickname ? ` (${a.nickname})` : "");
  };

  // ----- Helper functions to check step completion -----
  const isStep1Completed = () => {
    // Step 1 is completed when:
    // 1. Title (subject) has been added
    // 2. At least one PDF main file has been uploaded
    const hasTitle = subject.trim().length > 0;
    const hasMainFile = files.length > 0 || existingMainFiles.length > 0;
    return hasTitle && hasMainFile;
  };

  const isStep2Completed = () => {
    // Step 2 is completed when:
    // 1. All approvers who require signature have signature placed
    // 2. All approvers who require signature have date stamp placed
    const allRequiredSigsPlaced = approvers.every((ap, idx) => {
      const needsSig = wantSigOf(ap, idx);
      if (!needsSig) return true; // Skip if signature not required
      
      const hasSig = sigPositions[idx] !== undefined;
      const hasDate = datePositions[idx] !== undefined;
      
      return hasSig && hasDate;
    });
    
    return allRequiredSigsPlaced && approvers.length > 0;
  };

  // ----- ฟังก์ชันเปลี่ยนสเต็ปแบบไม่มี validation -----
  const goToStep = (target: number) => {
    setStep(target);
  };

  const loadData = useCallback(async () => {
    if (mode !== "edit" || !memoId) return;

    // ก่อนโหลด data ใหม่
    setCurrentPage(1);
    setLoadedPageCounts([]);
    setFileUrls((prev) => {
      prev.forEach((o) => {
        if (o.url?.startsWith("blob:")) {
          URL.revokeObjectURL(o.url);
        }
      });
      return [];
    });

    setSigPositions({});
    setDatePositions({});
    setNotePositions([]);
    setNotePositions([]);
    setExistingMainFiles([]);
    setRemovedExistingFileIds([]);
    setFiles([]);
    setUrlLinks([]); // ✅ Clear URL links before loading new data
    setExistingAttachedFiles([]); // ✅ Clear existing attached files
    setAttachedFiles([]); // ✅ Clear new attached files
    setRemovedAttachedFileIds([]); // ✅ Clear removed attached file IDs

    try {
      // ---------- 1. โหลด Memo ----------
      const { data: d } = await axios.get<MemoData>(`/api/memos/${memoId}`, {
        withCredentials: true,
      });

      // ---------- 2. ฟิลด์ทั่วไป ----------
      setSubject(d.subject);
      setMemoTypeId(d.memoType?.id ?? "");
      setMemoNumber((d as any)?.memoNumberRecord?.memonumber ?? "");
      setExpiryAtLocal(toDatetimeLocalValue((d as any)?.expiresAt ?? null));
      setBusinessUnitId((d as any)?.businessUnitId ?? "");
      setDepartmentId((d as any)?.departmentId ?? "");
      // ---------- 3. ไฟล์ PDF ----------
      const seenIds = new Set<number>();
      const filesArr = d.mainFiles
        .filter((f) => {
          if (seenIds.has(f.id)) return false;
          seenIds.add(f.id);
          return true;
        })
        // ⬇️ เรียงตาม orderNo เพื่อให้ลำดับถูกต้อง
        .sort((a, b) => {
          const orderA = (a as any).orderNo ?? (a as any).order ?? 0;
          const orderB = (b as any).orderNo ?? (b as any).order ?? 0;
          return orderA - orderB;
        });

      // ── 3.1) ดึงไบนารี่ (ArrayBuffer) และสร้าง Blob URL ──
      const blobUrls = await Promise.all(
        filesArr.map(async (f) => {
          const { data } = await axios.get<ArrayBuffer>(
            `/api/memos/${memoId}/pdf?fileId=${f.id}`,
            { responseType: "arraybuffer", withCredentials: true }
          );

          // สร้าง Blob แล้วเป็น Blob URL
          const blob = new Blob([data], { type: "application/pdf" });
          const blobUrl = URL.createObjectURL(blob);
          return blobUrl;
        })
      );

      // เก็บลง state เพื่อให้ UI ใช้ได้
      setFileUrls(blobUrls.map((u) => ({ file: undefined, url: u })));

      // ── 3.2) นับจำนวนหน้าของแต่ละ Blob URL ──
      const pageCounts = await Promise.all(
        blobUrls.map(async (url, index) => {
          try {
            const doc = await pdfjs.getDocument(url).promise;
            // Read per-page widths for A3/A4 mixed-size support
            const sizes: Record<string, number> = {};
            for (let p = 1; p <= doc.numPages; p++) {
              const pg = await doc.getPage(p);
              const vp = pg.getViewport({ scale: 1 });
              sizes[`${index}-${p}`] = vp.width;
            }
            setPageWidthPtMap(prev => ({ ...prev, ...sizes }));
            return doc.numPages;
          } catch (err) {
            console.error(
              `      ❌ เกิด error ขณะ pdf.js โหลด URL[${index}]`,
              err
            );
            return 0;
          }
        })
      );
      setLoadedPageCounts(pageCounts);

      // ── 3.3) เก็บ meta ของไฟล์เก่า ──
      const existingMeta = filesArr.map((f, i: number) => {
        const meta = {
          id: f.id,
          fileName: f.fileName,
          url: f.url,
          pageCount: pageCounts[i],
        };
        return meta;
      });
      setExistingMainFiles(existingMeta);

      // Load existing URL links
      const existingUrlLinks = (d.attachedFiles ?? [])
        .filter((f: any) => f.isUrl)
        .map((f: any) => ({
          url: f.url || "",
          title: f.fileName || f.url || "",
        }));
      setUrlLinks(existingUrlLinks);

      // Filter out URL links from existingAttachedFiles (they're shown separately)
      const fileAttachments = (d.attachedFiles ?? []).filter((f: any) => !f.isUrl);
      setExistingAttachedFiles(fileAttachments);

      // ---------- NEW: set orderTokens เริ่มจากไฟล์เก่าตาม orderNo ----------
      setOrderTokens(existingMeta.map((f) => makeOldToken(f.id)));

      // ล้างไฟล์ใหม่ (ในโหมด edit)
      setFiles([]);
      // -------------------------------------------------

      // ── 3.4) สร้าง map จาก id → index ──
      const id2idx: Record<number, number> = {};
      filesArr.forEach((f, i: number) => {
        id2idx[f.id] = i;
      });
      setOldIdToIndex(id2idx);
      const [, lineRes] = await Promise.all([
        axios.get(`/api/memos/${memoId}`, { withCredentials: true }),
        axios.get(`/api/memos/${memoId}/approval-line`, {
          withCredentials: true,
        }),
      ]);
      const lineData = lineRes.data; // มาจาก  GET /memos/:id/approval-line
      setOriginalApprovalLineId(lineData.id); // 👈  เก็บ id จริงไว้
      setSelectedApprovalLine(lineData);
      // ---------- 4. Approvers (ใช้ lineRes) ---
      // หลังจากได้ lineData แล้ว
      const reqMap = extractRequiredMap(d);

      const flat: Approver[] = lineData.levels.flatMap(
        (lv: any, lvlIdx: number) =>
          lv.users.map((u: any) => {
            const userInfo = u.user ?? u;
            const isFlex = !!(u.slotType && u.slotType !== "FIXED_USER");

            // ค่า isSigReq ตามเดิม (saved/normalize)
            const pivotKey = u.loaUserPivotId ?? userInfo.loaUserPivotId;
            const saved =
              pivotKey != null && reqMap.has(pivotKey)
                ? reqMap.get(pivotKey)!
                : reqMap.has(userInfo.id)
                  ? reqMap.get(userInfo.id)!
                  : undefined;
            const sig =
              saved !== undefined
                ? saved
                : normalizeIsSigReq(u, userInfo.id, d);

            return {
              id:
                userInfo.id ??
                (isFlex ? -(u.loaUserPivotId || Date.now()) : undefined),
              name:
                userInfo.name ??
                (isFlex ? u.roleDescription || u.slotType : ""),
              lastname: userInfo.lastname ?? null,
              nickname: userInfo.nickname ?? null,
              displayName: isFlex && !userInfo.id
                ? `${u.roleDescription || u.slotType} (Click to select)`
                : makeDisplayName(userInfo),
              role: lv.name,
              level: lv.level ?? lvlIdx,
              loaUserPivotId: u.loaUserPivotId,
              status: u.status,
              isSigReq: Boolean(sig),

              // 🔻 ตรงนี้คือ field ที่เก็บลง state.approvers
              slotType: u.slotType ?? null,
              roleDescription: u.roleDescription ?? null,
              approvalRequirement: u.approvalRequirement ?? "ALL",
              isFlexibleSlot: isFlex && !userInfo.id,

              wasFlexibleSlot: false, // ไม่แสดงปุ่ม "Change user"
              // ⬅️ ถ้าต้องการ templatePivotId ตรงนี้ยัง “ไม่ได้เก็บ”
              templatePivotId:
                typeof u.templatePivotId === "number"
                  ? u.templatePivotId                  // เคส API ส่งมาให้แล้ว
                  : typeof u.loaUserTemplateId === "number"
                    ? u.loaUserTemplateId                // เผื่อคุณใช้ชื่ออื่น
                    : typeof u.loaUserPivotId === "number"
                      ? u.loaUserPivotId                   // fallback (เมโมเก่า ๆ)
                      : null,
            } as Approver;
          })
      );

      // Resolve delegation for loaded approvers
      const resolvedApprovers = await resolveApproverDelegation(flat);

      setApprovers(removeDuplicateApprovers(resolvedApprovers));
      setHideSigBtn(
        Object.fromEntries(resolvedApprovers.map((ap, i) => [sigKey(ap, i), !ap.isSigReq]))
      );
      originalApproversRef.current = resolvedApprovers;

      // Helper function to find approver index by userId and level
      // When same user appears at multiple levels, we need to match both userId AND level
      const findApproverIndex = (uid: number, level?: number | null): number => {
        if (level !== undefined && level !== null) {
          // Find approver with matching userId AND level
          const idx = resolvedApprovers.findIndex((a) => a.id === uid && a.level === level);
          if (idx !== -1) return idx;
        }
        // Fallback: find first occurrence by userId only (for backward compatibility)
        return resolvedApprovers.findIndex((a) => a.id === uid);
      };

      // ---------- 5. Marker ----------
      const sigByIdx: Record<number, SignaturePosition[]> = {};
      d.signaturePositions?.forEach((p: FilePosition) => {
        // Find the correct approver index using both userId and level
        const idx = findApproverIndex(p.userId, p.level);
        if (idx === -1) return;
        (sigByIdx[idx] ??= []).push({
          id: String(p.id),
          userId: p.userId,
          fileIdx: id2idx[p.fileId || 0],
          pageInFile: p.page,
          x: Number(p.x),
          y: Number(p.y),
          sizePct: p.sizePct ?? 100,
          level: p.level, // เก็บ level ด้วย
        });
      });

      const dateByIdx: Record<number, DatePosition[]> = {};
      d.datePositions?.forEach((p: FilePosition) => {
        // Find the correct approver index using both userId and level
        const idx = findApproverIndex(p.userId, p.level);
        if (idx === -1) return;
        (dateByIdx[idx] ??= []).push({
          id: String(p.id),
          userId: p.userId,
          fileIdx: id2idx[p.fileId || 0],
          pageInFile: p.page,
          x: p.x,
          y: p.y,
          date: p.date || "",
          sizePct: p.sizePct ?? 100,
          level: p.level, // เก็บ level ด้วย
        });
      });

      // ✅ โหลด notePositions
      const noteList: NotePosition[] = [];
      (d.notePositions ?? []).forEach((p: any) => {
        noteList.push({
          id: String(p.id),
          fileIdx: id2idx[p.fileId || 0] ?? 0,
          pageInFile: p.page,
          x: Number(p.x),
          y: Number(p.y),
          text: p.text || "",
          sizePct: p.sizePct ?? 100,
        });
      });

      // ✅ โหลด memoNumberPositions
      const memoNumList: MemoNumberPosition[] = [];
      (d.memoNumberPositions ?? []).forEach((p) => {
        memoNumList.push({
          id: String(p.id),
          fileIdx: id2idx[p.fileId || 0] ?? 0,
          pageInFile: p.page,
          x: Number(p.x),
          y: Number(p.y),
          sizePct: p.sizePct ?? 100,
        });
      });
      setMemoNumberPositions(memoNumList);

      setSigPositions(sigByIdx);
      setDatePositions(dateByIdx);
      setNotePositions(noteList);
      setMemoNumberPositions(memoNumList);

      // ---------- 6. Load Reference Memos ----------
      try {
        const { data: references } = await axios.get(`/api/memos/${memoId}/references`, {
          withCredentials: true,
        });
        if (Array.isArray(references)) {
          setSelectedReferences(references);
        }
      } catch (refErr) {
        console.error("❌ Failed to load reference memos", refErr);
        // Don't show error toast for references as it's not critical
      }
    } catch (err) {
      console.error("❌ Failed to load memo data", err);
      toast.error("โหลดข้อมูลไม่สำเร็จ");
    }
  }, [mode, memoId]);

  const makeDisplayName = useCallback(
    (u: { name: string; lastname?: string | null; nickname?: string | null }) =>
      [u.name, u.lastname].filter(Boolean).join(" ") +
      (u.nickname ? ` (${u.nickname})` : ""),
    []
  );

  // Helper function to remove duplicate approvers
  const removeDuplicateApprovers = useCallback(
    (approvers: Approver[]): Approver[] => {
      const uniqueApprovers: Approver[] = [];
      const seenKeys = new Set<string>();

      approvers.forEach((approver) => {
        const key = `${approver.id}-${approver.level}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          uniqueApprovers.push(approver);
        } else {
          console.warn("Duplicate approver found and removed:", approver);
        }
      });

      return uniqueApprovers;
    },
    []
  );

  // MemoForm.tsx
  const hydrateMissingApproverNames = async (current: Approver[]) => {
    const needIds = [
      ...new Set(
        current.filter((a) => !a.isDelegated && (!a.lastname || !a.nickname)).map((a) => a.id)
      ),
    ].filter((n) => Number.isFinite(n) && n > 0);
    if (!needIds.length) return;

    try {
      // Use the new bulk endpoint instead of individual user calls
      const { data: users } = await axios.get<User[]>(`/api/users/basic-info`, {
        params: { ids: needIds.join(",") },
        withCredentials: true,
      });

      const map = new Map(users.map((u) => [u.id, u]));
      setApprovers((prev) =>
        prev.map((a) => {
          // Don't overwrite delegated approvers
          if (a.isDelegated) return a;
          
          const u = map.get(a.id);
          return u
            ? {
              ...a,
              lastname: u.lastname ?? a.lastname ?? null,
              nickname: u.nickname ?? a.nickname ?? null,
              displayName:
                [u.name, u.lastname].filter(Boolean).join(" ") +
                (u.nickname ? ` (${u.nickname})` : ""),
            }
            : a;
        })
      );
    } catch (e) {
      console.error("hydrateMissingApproverNames failed", e);
    }
  };

  useEffect(() => {
    if (!addOpen) clearAddSelection();
  }, [addOpen]);
  useEffect(() => {
    const max = Math.max(totalPages, 1);
    setCurrentPage((p) => Math.min(Math.max(p, 1), max));
  }, [totalPages]);
  useEffect(() => {
    if (mode !== "edit" || !memoId) return;

    (async () => {
      try {
        const { data: ccPayload } = await axios.get(`/api/memos/${memoId}/cc`, {
          withCredentials: true,
        });

        // ----- USERS -----
        const userArr = Array.isArray(ccPayload)
          ? ccPayload
          : ccPayload?.users ?? ccPayload?.ccUsers ?? [];
        const ccUsersLite = (userArr ?? []).map(toUserLite);
        setCcSelected(ccUsersLite);

        // hydrate ชื่อ/ชื่อเล่นที่ยังขาด
        const needIds = [
          ...new Set(
            ccUsersLite
              .filter(
                (u: { lastname: any; nickname: any }) =>
                  !u.lastname || !u.nickname
              )
              .map((u: { id: any }) => u.id)
          ),
        ];
        if (needIds.length) {
          const { data: users } = await axios.get<User[]>(
            `/api/users/basic-info`,
            {
              params: { ids: needIds.join(",") },
              withCredentials: true,
            }
          );
          const map = new Map(users.map((u) => [u.id, u]));
          setCcSelected((prev) =>
            prev.map((u) =>
              map.has(u.id) ? toUserLite({ ...u, ...map.get(u.id)! }) : u
            )
          );
        }

        // ----- GROUPS -----
        // กรณี 1: ได้ object ของ group มาเลย (groups / ccGroups)
        let groupsSrc =
          (Array.isArray(ccPayload)
            ? []
            : ccPayload?.groups ?? ccPayload?.ccGroups) || [];

        // กรณี 2: ได้เป็นตัวเลข (groupIds) → ต้อง hydrate รายละเอียด
        const groupIdsRaw = Array.isArray(ccPayload)
          ? []
          : ccPayload?.groupIds ?? [];
        const numericIds = (groupIdsRaw || [])
          .map((g: any) => Number(g?.id ?? g))
          .filter((n: any) => Number.isFinite(n)) as number[];

        if ((!groupsSrc || groupsSrc.length === 0) && numericIds.length) {
          // คุณควรมี endpoint แบบนี้ (ทำง่ายมากฝั่งหลังบ้าน):
          // GET /api/cc-groups/basic-info?ids=1,2,3
          const { data: groupObjs } = await axios.get(
            `/api/cc-groups/basic-info`,
            {
              params: { ids: numericIds.join(",") },
              withCredentials: true,
            }
          );
          groupsSrc = Array.isArray(groupObjs) ? groupObjs : [];
        }

        const ccGroupsLite: CcGroupLite[] = (groupsSrc || [])
          .map(toCcGroupLite)
          .filter((g: any) => g?.id && g?.name); // กันทรงแปลก

        setCcSelectedGroups(ccGroupsLite);
      } catch (e) {
        console.error("load CC (users/groups) error", e);
      }
    })();
  }, [mode, memoId]);

  useEffect(() => {
    const q = addQuery.trim();
    if (!addOpen || q.length < 2) {
      setAddResults([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        setAddLoading(true);
        // When selecting for a flexible slot, don't exclude any users from search
        // The same user can be assigned to different levels
        // Duplicate check at same level is handled by the alreadyIn check in the UI
        const flexibleSlotInfo = (window as any).selectingForFlexibleSlot;
        
        let excludeIds = "";
        if (!flexibleSlotInfo) {
          // Only exclude users when adding new approvers (not replacing flexible slots)
          // Even then, allow same user at different levels
          excludeIds = approvers
            .filter((a) => !a.isFlexibleSlot && typeof a.id === 'number' && a.id > 0)
            .map((a) => a.id)
            .join(",");
        }
        // When selecting for flexible slot, don't exclude anyone - allow same user at different levels
        
        const { data } = await axios.get("/api/users/search", {
          params: { q, limit: 10, ...(excludeIds ? { exclude: excludeIds } : {}) },
          withCredentials: true,
          signal: controller.signal,
        });
        setAddResults((Array.isArray(data) ? data : []).map(toUserLite));
      } finally {
        setAddLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [addQuery, addOpen, approvers]);

  useEffect(() => {
    const idNum = Number(memoTypeId);
    if (!idNum) {
      setTypeFiles([]);
      setTypeDefaultFileId(null);
      return;
    }

    const controller = new AbortController();
    (async () => {
      try {
        setTypeLoading(true);
        const params = mode === "edit" ? { includeDeleted: true } : {};
        const { data } = await axios.get(`/api/memotypes/${idNum}`, {
          params,
          withCredentials: true,
          signal: controller.signal,
        });

        // ✅ ใช้ชื่อ field ให้ตรงกับ API ปัจจุบัน
        const files: TypeMainFile[] = data?.typeFiles ?? data?.mainFiles ?? [];
        const defaultFileId: number | null = data?.defaultTypeFileId ?? null;

        setTypeFiles(files);
        setTypeDefaultFileId(defaultFileId);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          console.error("load type files error", e);
          toast.error("โหลดไฟล์ของประเภทเอกสารไม่สำเร็จ");
          setTypeFiles([]);
        }
      } finally {
        setTypeLoading(false);
      }
    })();

    return () => controller.abort();
  }, [memoTypeId]);

  // Handler for memo type selection that also auto-selects approval line

  const handleMemoTypeChange = useCallback(
    async (typeId: number | "") => {
      setMemoTypeId(typeId);

      if (typeId !== "" && typeof typeId === "number") {
        const selectedType = memoTypes.find((type) => type.id === typeId);
        
        // ✅ Update BU and Department from selected MemoType
        if (selectedType) {
          setBusinessUnitId(selectedType.businessUnit?.id ?? "");
          setDepartmentId(selectedType.department?.id ?? "");
        }
        
        if (selectedType && (selectedType as any).approvalLineId) {
          const approvalLineId = (selectedType as any).approvalLineId;
          let matchingLine: ApprovalLine | undefined;
          setApprovalLines((currentLines) => {
            matchingLine = currentLines.find(
              (line) => line.id === approvalLineId
            );
            return currentLines;
          });

          // If the approval line is not in the current user's team lines, fetch it from the document type
          if (!matchingLine) {
            try {
              const { data: typeDetails } = await axios.get(
                `/api/memotypes/${typeId}`,
                {
                  withCredentials: true,
                }
              );

              if (
                typeDetails.approvalLevels &&
                typeDetails.approvalLevels.length > 0
              ) {
                console.log("=== TYPE DETAILS APPROVAL LEVELS ===");
                console.log("Type Details:", typeDetails);
                console.log("Approval Levels:", typeDetails.approvalLevels);
                typeDetails.approvalLevels.forEach((level: any, levelIdx: number) => {
                  console.log(`Level ${levelIdx}:`, level);
                  level.users.forEach((user: any, userIdx: number) => {
                    console.log(`  User ${userIdx}:`, {
                      id: user.id,
                      name: user.name,
                      slotType: user.slotType,
                      approvalRequirement: user.approvalRequirement
                    });
                  });
                });
                console.log("=====================================");
                matchingLine = {
                  id: approvalLineId,
                  name: typeDetails.name + " Approval Line",
                  levels: typeDetails.approvalLevels.map((level: any) => ({
                    level: level.level,
                    name: `Level ${level.level + 1}`,
                    users: level.users.map((user: any, userIndex: number) => {
                      // Handle both fixed users and flexible slots
                      if (user.slotType === "FIXED_USER" && user.id) {
                        // Fixed user with actual user data
                        return {
                          id: user.loaUserPivotId, // ✅ pivot id สำหรับ templatePivotId
                          loaUserPivotId: user.loaUserPivotId,
                          templatePivotId: user.loaUserPivotId, // ✅ เก็บ templatePivotId
                          status: "PENDING",
                          isSigReq: user.isSigReq !== false,
                          slotType: user.slotType,
                          roleDescription: user.roleDescription,
                          approvalRequirement: user.approvalRequirement ?? "ALL",
                          user: {
                            id: user.id,
                            name: user.name || "Unknown",
                            lastname: user.lastname || null,
                            nickname: user.nickname || null,
                            email: user.email || "",
                          },
                        };
                      } else {
                        const flexibleId = -(
                          approvalLineId * 100000 +
                          level.level * 1000 +
                          userIndex +
                          1
                        );

                        return {
                          // ✅ เก็บ id pivot เดิมจาก backend ไว้ใน loaUserPivotId
                          loaUserPivotId: user.loaUserPivotId,
                          status: "PENDING",
                          isSigReq: user.isSigReq !== false,
                          slotType: user.slotType,
                          roleDescription: user.roleDescription,
                          approvalRequirement: user.approvalRequirement ?? "ALL",

                          // จะใส่หรือไม่ใส่ก็ได้ เพราะตอน flatten เราใช้ u.user.id อยู่แล้ว
                          id: user.loaUserPivotId,
                          templatePivotId: user.loaUserPivotId,

                          // fake user id เอาไว้ใช้เป็นตัวแทนช่องว่างใน UI
                          user: {
                            id: flexibleId,
                            name:
                              user.displayName ||
                              user.roleDescription ||
                              user.slotType,
                            lastname: null,
                            nickname: null,
                            email: "",
                          },

                          wasFlexibleSlot: true,
                        };
                      }
                    }),
                  })),
                };

                // Add this line to the approval lines list for future reference (if not already exists)
                setApprovalLines((prev) => {
                  const exists = prev.some(
                    (line) => line.id === matchingLine!.id
                  );
                  if (exists) {
                    return prev;
                  }
                  return [...prev, matchingLine!];
                });
              }
            } catch (error) {
              console.error(
                "Failed to fetch document type approval line:",
                error
              );
              toast.error("Failed to load approval line from document type");
            }
          }

          if (matchingLine) {
            setSelectedApprovalLine(matchingLine);
            // Use the same logic as handleApprovalLineChange to set approvers
            const flat: Approver[] = matchingLine.levels.flatMap((lv, lvlIdx) =>
              lv.users.map((u: any) => {
                const userInfo = u.user ?? u;
                const isFlexible = u.slotType && u.slotType !== "FIXED_USER";

                return {
                  id: userInfo.id,
                  name: userInfo.name,
                  lastname: userInfo.lastname ?? null,
                  nickname: userInfo.nickname ?? null,
                  displayName: isFlexible
                    ? `${u.roleDescription || u.slotType} (Click to select)`
                    : makeDisplayName(userInfo),
                  role: lv.name,
                  level: lv.level ?? lvlIdx,
                  loaUserPivotId: u.loaUserPivotId,
                  status: u.status,
                  isSigReq: u.isSigReq,
                  slotType: u.slotType,
                  roleDescription: u.roleDescription,
                  approvalRequirement: u.approvalRequirement ?? "ALL",
                  isFlexibleSlot: isFlexible,
                  templatePivotId:
                    u.templatePivotId ?? u.loaUserPivotId ?? null,
                } as Approver;
              })
            );

            // Resolve delegation for loaded approvers
            const resolvedApprovers = await resolveApproverDelegation(flat);

            setApprovers(removeDuplicateApprovers(resolvedApprovers));
            setHideSigBtn(
              Object.fromEntries(
                resolvedApprovers.map((ap, i) => [sigKey(ap, i), !(ap.isSigReq ?? true)])
              )
            );
            setCanSaveLine(false);
          }
        } else {
          // If no approval line is associated with the type, clear the selection
          setSelectedApprovalLine(null);
          setApprovers([]);
        }
      } else {
        // ✅ If no type is selected, clear approval line, approvers, and BU/Department
        setSelectedApprovalLine(null);
        setApprovers([]);
        setBusinessUnitId("");
        setDepartmentId("");
      }
    },
    [memoTypes, makeDisplayName, resolveApproverDelegation]
  );

  useEffect(() => {
    // มี typeId แล้วไม่ต้องทำ
    if (memoTypeId !== "") return;
    if (!memoTypeName || memoTypes.length === 0) return;

    const match = memoTypes.find(
      (t) =>
        (t.name || "").trim().toLowerCase() ===
        memoTypeName.trim().toLowerCase()
    );
    if (match) {
      // ตั้งทั้ง id และคงชื่อไว้เพื่อแสดง
      handleMemoTypeChange(match.id);
    }
  }, [memoTypeName, memoTypes, memoTypeId, handleMemoTypeChange]);

  // Handle URL parameter for automatic document type selection
  useEffect(() => {
    if (mode !== "create") return;

    const typeIdParam = searchParams.get("typeId");

    if (typeIdParam && memoTypes.length > 0) {
      const typeId = parseInt(typeIdParam, 10);
      if (!isNaN(typeId) && memoTypes.some((type) => type.id === typeId)) {
        const selectedType = memoTypes.find((type) => type.id === typeId);

        // Console log for testing purposes
        console.log("=== MEMO CREATION PAGE - DOCUMENT TYPE INFO ===");
        console.log("Document Type ID:", typeId);
        console.log("Document Type Name (from data):", selectedType?.name || "N/A");
        console.log("Line of Approval ID:", (selectedType as any)?.approvalLineId || "N/A");
        console.log("Line of Approval Name:", (selectedType as any)?.approvalLine?.name || selectedType?.name || "N/A");
        console.log("===============================================");

        // Use the async handler to set memo type and approval line
        handleMemoTypeChange(typeId);
        
        // Debug approval requirements
        setTimeout(() => {
          console.log("=== APPROVAL REQUIREMENTS DEBUG ===");
          console.log("Current approvers:", approvers.map(ap => ({
            id: ap.id,
            name: ap.name,
            level: ap.level,
            approvalRequirement: ap.approvalRequirement
          })));
          console.log("Grouped approvers:", groupedApprovers.map(group => ({
            level: group.level,
            items: group.items.map(item => ({
              id: item.ap.id,
              name: item.ap.name,
              approvalRequirement: item.ap.approvalRequirement
            }))
          })));
          console.log("=======================================");
        }, 1000);
      }
    }
  }, [mode, searchParams, memoTypes, handleMemoTypeChange]);

  // DISABLED: Auto-loading PDF feature - memo creation should start blank
  // useEffect(() => {
  //   // ทำเฉพาะตอนสร้างใหม่เท่านั้น
  //   if (mode !== "create") return;
  //   if (!typeDefaultMainFileId) return;
  //   if (autoLoadedFromType) return;

  //   // ถ้ามีไฟล์หลักอยู่แล้ว ไม่ต้อง auto-load
  //   if (files.length > 0 || orderTokens.length > 0) return;

  //   const f = typeFiles.find((x) => x.id === typeDefaultMainFileId);
  //   if (!f) return;

  //   const ext = (f.fileName.split(".").pop() || "").toLowerCase();
  //   // auto-load เฉพาะ PDF
  //   if (ext !== "pdf") return;

  //   const url = toSecureUploadUrl(f.filePath);
  //   if (!url) return;

  //   (async () => {
  //     try {
  //       // ดึงไฟล์ PDF เป็นไบนารี
  //       const { data: buf } = await axios.get<ArrayBuffer>(url, {
  //         responseType: "arraybuffer",
  //         withCredentials: true,
  //       });
  //       const blob = new Blob([buf], { type: "application/pdf" });
  //       // สร้าง File จริง ๆ เพื่อให้ตอน save โยนขึ้น FormData ได้
  //       const file = new File([blob], f.fileName, { type: "application/pdf" });
  //       const objectUrl = URL.createObjectURL(file);

  //       // นับจำนวนหน้า
  //       const doc = await pdfjs.getDocument(objectUrl).promise;
  //       const pages = doc.numPages;

  //       // อัปเดต state ให้เหมือนผู้ใช้อัปโหลดเอง
  //       setFiles((prev) => {
  //         const startIdx = prev.length;
  //         setOrderTokens((prevTok) => [...prevTok, makeNewToken(startIdx)]);
  //         return [...prev, file];
  //       });
  //       setFileUrls((prev) => [...prev, { file, url: objectUrl }]);
  //       setLoadedPageCounts((prev) => [...prev, pages]);

  //       setAutoLoadedFromType(true); // กันโหลดซ้ำ
  //     } catch (e) {
  //       console.error("auto load type default file failed", e);
  //     }
  //   })();
  // }, [
  //   mode,
  //   typeDefaultMainFileId,
  //   typeFiles,
  //   files.length,
  //   orderTokens.length,
  //   autoLoadedFromType,
  // ]);

  // Load all users and groups when CC dropdown is opened
  const loadAllCcOptions = useCallback(async () => {
    try {
      setCcLoading(true);
      const excludeIds = [
        ...approvers.map((a) => a.id),
        ...ccSelected.map((u) => u.id),
      ]
        .filter(Boolean)
        .join(",");

      const [uRes, gRes] = await Promise.all([
        axios.get("/api/users/search", {
          params: { limit: 20, exclude: excludeIds }, // No query = fetch all users
          withCredentials: true,
        }),
        axios.get("/api/cc-groups/search", {
          params: { limit: 20 }, // No query = fetch all groups
          withCredentials: true,
        }),
      ]);

      setCcResults(
        (Array.isArray(uRes.data) ? uRes.data : []).map(toUserLite)
      );
      setCcGroupResults(
        (Array.isArray(gRes.data) ? gRes.data : []).map((g: any) => {
          const membersRaw = g.members ?? g.previewMembers ?? [];
          const membersLite = (membersRaw ?? []).map(toUserLite);

          return {
            id: g.id,
            name: g.name,
            memberCount: g.memberCount ?? membersLite.length ?? 0,
            previewMembers: membersLite,
            memberIds: Array.isArray(g.memberIds)
              ? g.memberIds
              : membersLite.map((m: { id: any }) => m.id),
          } as CcGroupLite;
        })
      );
    } catch (error) {
      console.error("Failed to load CC options:", error);
    } finally {
      setCcLoading(false);
    }
  }, [approvers, ccSelected, toUserLite]);

  useEffect(() => {
    const q = ccQuery.trim();
    
    // If no query, don't search (will show all options when focused)
    if (q.length === 0) {
      return;
    }
    
    // Only search when query is 2+ characters
    if (q.length < 2) {
      setCcResults([]);
      setCcGroupResults([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        setCcLoading(true);
        const excludeIds = [
          ...approvers.map((a) => a.id),
          ...ccSelected.map((u) => u.id),
        ]
          .filter(Boolean)
          .join(",");

        const [uRes, gRes] = await Promise.all([
          axios.get("/api/users/search", {
            params: { q, limit: 10, exclude: excludeIds },
            withCredentials: true,
            signal: controller.signal,
          }),
          axios.get("/api/cc-groups/search", {
            params: { q, limit: 10 },
            withCredentials: true,
            signal: controller.signal,
          }),
        ]);

        setCcResults(
          (Array.isArray(uRes.data) ? uRes.data : []).map(toUserLite)
        );
        setCcGroupResults(
          (Array.isArray(gRes.data) ? gRes.data : []).map((g: any) => {
            const membersRaw = g.members ?? g.previewMembers ?? [];
            const membersLite = (membersRaw ?? []).map(toUserLite);

            return {
              id: g.id,
              name: g.name,
              memberCount: g.memberCount ?? membersLite.length ?? 0,
              previewMembers: membersLite,
              memberIds: Array.isArray(g.memberIds)
                ? g.memberIds
                : membersLite.map((m: { id: any }) => m.id),
            } as CcGroupLite;
          })
        );
      } finally {
        setCcLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [ccQuery, approvers, ccSelected, toUserLite]);

  useEffect(() => {
    if (mode === "edit" && memoId && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      loadData();
    }
  }, [mode, memoId, loadData]);

  const getFileAndPageFromGlobal = (globalPage: number) => {
    let count = 0;
    for (let i = 0; i < orderedPageCounts.length; i++) {
      const pages = orderedPageCounts[i];
      if (globalPage <= count + pages)
        return { fileIdx: i, pageInFile: globalPage - count };
      count += pages;
    }
    return { fileIdx: 0, pageInFile: 1 };
  };

  // Initial load: me, teams, BUs, depts, approval-lines
  useEffect(() => {
    axios
      .get("/api/me", { withCredentials: true })
      .then((res) => {
        const me = res.data;
        setUserId(me.id);
        // ✅ Don't set BU/Department from user - they should come from memotype selection
        // setBusinessUnitId(me.businessUnit?.id ?? "");
        // setDepartmentId(me.department?.id ?? "");

        // safe: ถ้าไม่มีทีม ให้คืน [] แทนการยิง endpoint ทีม
        const teamLinesReq = me.team?.id
          ? axios.get(`/api/teams/${me.team.id}/approval-lines`, {
            withCredentials: true,
          })
          : Promise.resolve({ data: [] });

        return Promise.all([
          axios.get("/api/business-units", { withCredentials: true }),
          axios.get("/api/departments", { withCredentials: true }),
          teamLinesReq,
          axios.get("/api/memotypes", { withCredentials: true }),
        ]);
      })
      .then(([buRes, deptRes, approvalRes, typeRes]) => {
        setBusinessUnits(buRes.data);
        setDepartments(deptRes.data);
        setApprovalLines(approvalRes.data ?? []); // อาจว่างได้ถ้าไม่มีทีม
        setMemoTypes(typeRes.data);
      })
      .catch((err) => {
        console.error(err);
        // redirect เฉพาะตอน auth หมดอายุจริง ๆ
        if (err?.response?.status === 401) {
          toast.error("Session expired, please log in");
          window.location.href = "/login"; // หรือใช้ navigate("/login")
        } else {
          toast.error("โหลดข้อมูลเบื้องต้นไม่สำเร็จ");
        }
      });
  }, []);

  useLayoutEffect(() => {
    if (!measureRef.current) return;
    const doMeasure = () => {
      if (measureRef.current) {
        const w = measureRef.current.clientWidth;
        setContainerWidth((prev) => (prev !== w ? w : prev));
      }
    };
    const raf = requestAnimationFrame(doMeasure);
    const ro = new ResizeObserver(doMeasure);
    ro.observe(measureRef.current);
    window.addEventListener("resize", doMeasure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", doMeasure);
    };
  }, [step, orderedUrls.length]);

  // Smooth-animate scroll to target position
  const animateScroll = useCallback(
    (sc: HTMLDivElement, targetLeft: number, targetTop: number, duration = 150) => {
      const startLeft = sc.scrollLeft;
      const startTop = sc.scrollTop;
      const dLeft = targetLeft - startLeft;
      const dTop = targetTop - startTop;
      const start = performance.now();
      const ease = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
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

  // Ctrl+scroll wheel zoom — capture at document level to prevent browser zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const container = scrollContainerRef.current;
      if (!container) return;
      if (!container.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      const direction = e.deltaY > 0 ? "down" : "up";
      setZoomLevel((prev) => {
        const next = direction === "up" ? nextZoomUp(prev) : nextZoomDown(prev);
        const vpX = e.clientX - container.getBoundingClientRect().left;
        const vpY = e.clientY - container.getBoundingClientRect().top;
        const contentX = (container.scrollLeft + vpX) / prev;
        const contentY = (container.scrollTop + vpY) / prev;
        requestAnimationFrame(() => {
          animateScroll(container, contentX * next - vpX, contentY * next - vpY, 150);
        });
        return next;
      });
    };
    document.addEventListener("wheel", handler, { passive: false });
    return () => document.removeEventListener("wheel", handler);
  }, [animateScroll]);

  // Keyboard shortcuts for zoom
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoomLevel((prev) => nextZoomUp(prev));
      } else if (e.key === "-") {
        e.preventDefault();
        setZoomLevel((prev) => nextZoomDown(prev));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoomLevel(1);
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollLeft = 0;
          scrollContainerRef.current.scrollTop = 0;
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const processNewMainFiles = useCallback(async (added: File[]) => {
    const pdfs = added.filter(
      (f) =>
        f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
    );
    if (!pdfs.length) return;

    // Check file size limit (50MB = 50 * 1024 * 1024 bytes)
    const maxSize = 50 * 1024 * 1024;
    const oversizedFiles = pdfs.filter(f => f.size > maxSize);
    
    if (oversizedFiles.length > 0) {
      const fileDetails = oversizedFiles.map(f => `${f.name} (${formatFileSize(f.size)})`).join(', ');
      toast.error(`File size exceeds 50MB limit: ${fileDetails}. Please select smaller files.`);
      return;
    }

    const addedPairs = pdfs.map((f) => ({
      file: f,
      url: URL.createObjectURL(f),
    }));
    // Collect page sizes per file for A3/A4 mixed-size support
    const addedPageSizes: Record<string, number>[] = [];
    const addedPageCounts = await Promise.all(
      addedPairs.map(async ({ url }, i) => {
        const doc = await pdfjs.getDocument(url).promise;
        const sizes: Record<string, number> = {};
        for (let p = 1; p <= doc.numPages; p++) {
          const pg = await doc.getPage(p);
          const vp = pg.getViewport({ scale: 1 });
          // Use relative index i; we'll remap with correct fileIdx below
          sizes[`${p}`] = vp.width;
        }
        addedPageSizes[i] = sizes;
        return doc.numPages;
      })
    );

    setFiles((prev) => {
      const startIdx = prev.length;
      // Now we know the real fileIdx — remap page widths
      const remapped: Record<string, number> = {};
      addedPageSizes.forEach((sizes, i) => {
        Object.entries(sizes).forEach(([pageNum, w]) => {
          remapped[`${startIdx + i}-${pageNum}`] = w;
        });
      });
      setPageWidthPtMap(prevMap => ({ ...prevMap, ...remapped }));
      setOrderTokens((prevTok) => [
        ...prevTok,
        ...pdfs.map((_, i) => makeNewToken(startIdx + i)),
      ]);
      return [...prev, ...pdfs];
    });
    setFileUrls((prev) => [...prev, ...addedPairs]);
    setLoadedPageCounts((prev) => [...prev, ...addedPageCounts]);
  }, []);

  const processNewAttachedFiles = useCallback(async (added: File[]) => {
    // Allowed file extensions
    const ALLOWED_EXTENSIONS = new Set([
      '.png', '.jpg', '.jpeg', '.gif', '.webp',
      '.pdf',
      '.doc', '.docx', '.rtf',
      '.ppt', '.pptx', '.pps', '.ppsx',
      '.xls', '.xlsx', '.csv', '.ods',
    ]);

    // Check file type first
    const invalidFiles = added.filter(f => {
      const ext = f.name.toLowerCase().substring(f.name.lastIndexOf('.'));
      return !ALLOWED_EXTENSIONS.has(ext);
    });

    if (invalidFiles.length > 0) {
      const fileNames = invalidFiles.map(f => f.name).join(', ');
      toast.error(t("errors.unsupportedFileType", { files: fileNames }));
      return;
    }

    // Check file size limit (50MB = 50 * 1024 * 1024 bytes)
    const maxSize = 50 * 1024 * 1024;
    const oversizedFiles = added.filter(f => f.size > maxSize);
    
    if (oversizedFiles.length > 0) {
      const fileDetails = oversizedFiles.map(f => `${f.name} (${formatFileSize(f.size)})`).join(', ');
      toast.error(`File size exceeds 50MB limit: ${fileDetails}. Please select smaller files.`);
      return;
    }

    const pairs = added.map((f) => ({ file: f, url: URL.createObjectURL(f) }));
    setAttachedFiles((prev) => [...prev, ...added]);
    setAttachedFileUrls((prev) => [...prev, ...pairs]);
  }, [t]);

  // File change handler
  const handleMultiFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    if (!e.target.files) return;
    await processNewMainFiles(Array.from(e.target.files));
    if (pdfInputRef.current) pdfInputRef.current.value = "";
  };

  const handleAttachedFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    if (!e.target.files) return;
    await processNewAttachedFiles(Array.from(e.target.files));
    if (attachedInputRef.current) attachedInputRef.current.value = "";
  };

  // URL link handlers
  const handleAddUrlLink = () => {
    if (!urlInput.trim()) {
      toast.error(t("urlPlaceholder"));
      return;
    }

    const newLink = {
      url: urlInput.trim(),
      title: urlTitleInput.trim() || urlInput.trim(),
    };

    setUrlLinks((prev) => [...prev, newLink]);
    setUrlInput("");
    setUrlTitleInput("");
    setShowUrlModal(false);
  };

  const handleCancelUrlModal = () => {
    setShowUrlModal(false);
    setUrlInput("");
    setUrlTitleInput("");
  };

  const handleRemoveUrlLink = (index: number) => {
    setUrlLinks((prev) => prev.filter((_, i) => i !== index));
  };

  const addCc = (u: UserLite) => {
    if (ccSelected.some((s) => s.id === u.id)) return;
    setCcSelected((prev) => [...prev, u]);
    setCcQuery("");
    setCcResults([]);
    setIsCcOpen(false);
  };

  const addCcUser = (u: UserLite) => {
    addCc(u);
  };
  const getNextLevel = (arr: Approver[]) => {
    if (!arr || arr.length === 0) return 0;
    const used = new Set(
      arr.map((a) => (typeof a.level === "number" ? a.level : 0))
    );
    let i = 0;
    while (used.has(i)) i++;
    return i;
  };

  // 2) เพิ่มหลายคนรวดเดียว
  const handleAddApproversBulk = () => {
    // Check if we're selecting for a flexible slot
    const flexibleSlotInfo = (window as any).selectingForFlexibleSlot;

    if (flexibleSlotInfo && addSelected.length === 1) {
      // Replace the flexible slot with the selected user
      const selectedUser = addSelected[0];
      setApprovers((prev) => {
        // Check if the selected user ID already exists at the SAME LEVEL in the approvers list
        // Allow same user at different levels
        const flexibleSlot = prev[flexibleSlotInfo.approverIndex];
        const existingUserAtSameLevel = prev.find(
          (ap) =>
            ap.id === selectedUser.id && 
            ap.id !== flexibleSlotInfo.approverId &&
            ap.level === flexibleSlot?.level
        );
        if (existingUserAtSameLevel) {
          console.warn(
            "User already exists at the same level:",
            selectedUser.id
          );
          // Don't replace if user already exists at the same level
          return prev;
        }

        // เก็บค่าเดิมของ slotType/roleDescription ไว้
        return prev.map((ap) =>
          ap.id === flexibleSlotInfo.approverId
            ? {
              ...ap,
              id: selectedUser.id,
              name: selectedUser.name,
              lastname: selectedUser.lastname ?? null,
              nickname: selectedUser.nickname ?? null,
              displayName: formatCC(selectedUser),
              loaUserPivotId: ap.loaUserPivotId,
              isFlexibleSlot: false,
              slotType: ap.slotType ?? null,
              roleDescription: ap.roleDescription ?? null,
              wasFlexibleSlot: true,
            }
            : ap
        );
      });
      setHideSigBtn((prev) => {
        // key เดิม-ใหม่ ตาม sigKey (ซึ่งจะผูกกับ loaUserPivotId)
        const oldAp = approvers[flexibleSlotInfo.approverIndex];
        if (!oldAp) return prev;

        const oldKey = sigKey(oldAp, flexibleSlotInfo.approverIndex);
        const newKey = sigKey(
          { ...oldAp, id: selectedUser.id },
          flexibleSlotInfo.approverIndex
        );

        if (oldKey === newKey) return prev; // ส่วนใหญ่จะเท่ากันอยู่แล้ว

        const next = { ...prev };
        next[newKey] = prev[oldKey] ?? false;
        delete next[oldKey];
        return next;
      });

      setCanSaveLine(true);

      // Clean up the flexible slot info
      delete (window as any).selectingForFlexibleSlot;
    } else {
      // Regular add approvers functionality
      const selected = addSelected.filter(
        (u) => !approvers.some((a) => a.id === u.id)
      );
      if (!selected.length) return;

      // Check if we're adding to a specific level
      const targetLevel = (window as any).__targetLevel;
      const isNewLevel = (window as any).__isNewLevel;
      
      let baseLevel: number;
      if (typeof targetLevel === 'number') {
        baseLevel = targetLevel;
      } else {
        baseLevel = getNextLevel(approvers);
      }
      
      // Get approval requirement from existing level or default to ALL
      const existingLevelApprover = approvers.find(a => a.level === baseLevel);
      const approvalReq = existingLevelApprover?.approvalRequirement || "ALL";

      const newApprovers: Approver[] = selected.map((u, i) => ({
        id: u.id,
        name: u.name,
        lastname: u.lastname ?? null,
        nickname: u.nickname ?? null,
        displayName:
          [u.name, u.lastname].filter(Boolean).join(" ") +
          (u.nickname ? ` (${u.nickname})` : ""),
        role: isNewLevel 
          ? (t("newLevel") ?? `Level ${baseLevel + 1}`)
          : (t("additionalRole") ?? "Additional"),
        level: baseLevel,
        loaUserPivotId: -(Date.now() + i),
        status: "pending",
        isSigReq: true,
        templatePivotId: null,
        approvalRequirement: approvalReq,
        slotType: null,
        roleDescription: null,
      }));

      setApprovers((prev) => [...prev, ...newApprovers]);
      setHideSigBtn((prev) => ({
        ...prev,
        ...Object.fromEntries(selected.map((u) => [u.id, false])),
      }));
      setCanSaveLine(true);
      
      // Clean up target level info
      delete (window as any).__targetLevel;
      delete (window as any).__isNewLevel;
    }

    // reset UI
    setAddOpen(false);
    setAddQuery("");
    setAddResults([]);
    setAddSelected([]);
  };

  const removeCc = (id: number) => {
    setCcSelected((prev) => prev.filter((u) => u.id !== id));
  };

  const addCcGroup = (g: CcGroupLite) => {
    if (ccSelectedGroups.some((x) => x.id === g.id)) return;
    setCcSelectedGroups((prev) => [...prev, g]);
    
    // Auto-expand the group when added to show members list
    setExpandedGroup((prev) => ({ ...prev, [g.id]: true }));
    
    // Load group members if not already loaded
    if (!groupMembers[g.id]?.length) {
      toggleGroupInline(g);
    }
    
    setIsCcOpen(false);
    setCcQuery("");
    setCcGroupResults([]);
  };

  const removeCcGroup = (id: number) => {
    setCcSelectedGroups((prev) => prev.filter((g) => g.id !== id));
  };

  const onPlaceMarker = (
    e: React.MouseEvent<HTMLDivElement>,
    globalPage: number
  ) => {
    if (!placingFor || !pageRef.current) return;

    // ✅ สำหรับ memonumber ไม่ต้องเช็ค approver
    if (placingFor.type === "memonumber") {
      const canvas = pageRef.current.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const { fileIdx, pageInFile } = getFileAndPageFromGlobal(globalPage);
      let __uidCounter = 0;
      const genId = () =>
        globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `mk_${Date.now()}_${__uidCounter++}`;

      const newPos: MemoNumberPosition = {
        id: genId(),
        fileIdx,
        pageInFile,
        x: ((e.clientX - r.left) / r.width) * 100,
        y: ((e.clientY - r.top) / r.height) * 100,
        sizePct: 100,
      };

      setMemoNumberPositions((prev) => [...prev, newPos]);
      setPlacingFor(null);
      return;
    }

    // ✅ สำหรับ note ไม่ต้องเช็ค approver
    if (placingFor.type === "note") {
      const canvas = pageRef.current.querySelector("canvas")!;
      const r = canvas.getBoundingClientRect();
      const { fileIdx, pageInFile } = getFileAndPageFromGlobal(globalPage);

      // Store position and open modal
      setPendingNotePosition({
        fileIdx,
        pageInFile,
        x: ((e.clientX - r.left) / r.width) * 100,
        y: ((e.clientY - r.top) / r.height) * 100,
      });
      setNoteModalText("");
      setNoteModalOpen(true);
      setPlacingFor(null);
      return;
    }

    const targetAp = approvers[placingFor.approverIndex];
    if (!targetAp || targetAp.isFlexibleSlot) {
      toast.error(t("selectUserFirst") ?? "Please select a user for the flexible slot approver first");
      setPlacingFor(null);
      return;
    }
    const canvas = pageRef.current.querySelector("canvas")!;
    const r = canvas.getBoundingClientRect();
    const { fileIdx, pageInFile } = getFileAndPageFromGlobal(globalPage);
    const userIdForThis = approvers[placingFor.approverIndex].id;
    let __uidCounter = 0;
    const genId = () =>
      globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `mk_${Date.now()}_${__uidCounter++}`;
    // พิกัดในรูปแบบ percent
    const base = {
      id: genId(),
      userId: userIdForThis,
      fileIdx,
      pageInFile,
      x: ((e.clientX - r.left) / r.width) * 100,
      y: ((e.clientY - r.top) / r.height) * 100,
      sizePct: 70,
    };

    // Check if "Apply to all pages" is enabled for this approver
    const isApplyToAll = applyToAllPagesPerApprover[placingFor.approverIndex];

    // Get the level for this approver
    const approverLevel = approvers[placingFor.approverIndex]?.level ?? placingFor.approverIndex;

    // เคส both: สร้าง sig ตามปกติ
    if (placingFor.type === "signature" || placingFor.type === "both") {
      if (isApplyToAll) {
        // Place signature on all pages of all files
        const newSignatures: SignaturePosition[] = [];
        for (let fIdx = 0; fIdx < orderedPageCounts.length; fIdx++) {
          const pageCount = orderedPageCounts[fIdx];
          for (let page = 1; page <= pageCount; page++) {
            newSignatures.push({
              id: genId(),
              userId: userIdForThis,
              fileIdx: fIdx,
              pageInFile: page,
              x: base.x,
              y: base.y,
              sizePct: 70,
              level: approverLevel, // เพิ่ม level
            });
          }
        }
        setSigPositions((prev) => ({
          ...prev,
          [placingFor.approverIndex]: [
            ...(prev[placingFor.approverIndex] || []),
            ...newSignatures,
          ],
        }));
      } else {
        // Place signature only on current page
        setSigPositions((prev) => ({
          ...prev,
          [placingFor.approverIndex]: [
            ...(prev[placingFor.approverIndex] || []),
            { ...base, level: approverLevel }, // เพิ่ม level
          ],
        }));
      }
    }

    // ถ้าเป็น both หรือ date ปกติ ให้วาง date
    if (placingFor.type === "date" || placingFor.type === "both") {
      // offset Y เล็กน้อย (ปรับค่า +5 ได้ตามต้องการ)
      const offsetPct = 3;
      
      if (isApplyToAll) {
        // Place date on all pages of all files
        const newDates: DatePosition[] = [];
        for (let fIdx = 0; fIdx < orderedPageCounts.length; fIdx++) {
          const pageCount = orderedPageCounts[fIdx];
          for (let page = 1; page <= pageCount; page++) {
            newDates.push({
              id: genId(),
              userId: userIdForThis,
              fileIdx: fIdx,
              pageInFile: page,
              x: base.x,
              y: base.y + offsetPct,
              date: new Date().toISOString().slice(0, 10),
              sizePct: 70,
              level: approverLevel, // เพิ่ม level
            });
          }
        }
        setDatePositions((prev) => ({
          ...prev,
          [placingFor.approverIndex]: [
            ...(prev[placingFor.approverIndex] || []),
            ...newDates,
          ],
        }));
      } else {
        // Place date only on current page
        setDatePositions((prev) => ({
          ...prev,
          [placingFor.approverIndex]: [
            ...(prev[placingFor.approverIndex] || []),
            {
              ...base,
              // เลื่อน date ลงมาอีก 5%
              y: base.y + offsetPct,
              date: new Date().toISOString().slice(0, 10),
              level: approverLevel, // เพิ่ม level
            },
          ],
        }));
      }
    }

    // รีเซ็ตโหมด
    setPlacingFor(null);
  };

  // Function to toggle "Apply to all pages" flag
  const handleApplyToAllPagesToggle = (approverIndex: number, checked: boolean) => {
    setApplyToAllPagesPerApprover((prev) => ({
      ...prev,
      [approverIndex]: checked,
    }));
  };

  // Function to clear all signatures for an approver
  const handleClearAllSignatures = (approverIndex: number) => {
    setSigPositions((prev) => ({
      ...prev,
      [approverIndex]: [],
    }));

    setDatePositions((prev) => ({
      ...prev,
      [approverIndex]: [],
    }));

    toast.success(
      t("signaturesCleared", {
        defaultValue: "All signatures cleared",
      })
    );
  };

  // Round utility
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  /** append เฉพาะค่า number ที่มี (เว้น "" / undefined) */
  const appendNumber = (
    key: string,
    value: number | "" | undefined,
    form: FormData
  ) => {
    if (value === "" || value === undefined) return;
    form.append(key, String(value));
  };

  /** append เฉพาะกรณี “ต้องการเปลี่ยนค่า” */
  const appendIfChanged = (
    key: string,
    value: number | null | undefined,
    form: FormData
  ) => {
    if (value === undefined) return; // ไม่ส่ง = คงของเดิม
    if (value === null) form.append(key, "null"); // reset เป็น NULL
    else form.append(key, String(value));
  };

  // Save handler (create or edit)
  const handleDownloadTypeFile = (f: TypeMainFile) => {
    const href = toSecureUploadUrl(f.filePath);
    if (!href) return;
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noopener";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const getMissingSignatureApprovers = () => {
    return approvers
      .map((ap, idx) => ({ ap, idx }))
      .filter(({ ap, idx }) => {
        // ต้องการลายเซ็น?
        const required = isSigRequired(ap, idx) && !ap.isFlexibleSlot;
        if (!required) return false;

        // มี signature marker แล้วหรือยัง (นับเฉพาะลายเซ็น)
        const hasSig = (sigPositions[idx]?.length ?? 0) > 0;
        return !hasSig;
      });
  };
  
  // Handle note modal submission
  const handleNoteModalSubmit = () => {
    if (!noteModalText.trim() || !pendingNotePosition) {
      setNoteModalOpen(false);
      setPendingNotePosition(null);
      setNoteModalText("");
      return;
    }

    let __uidCounter = 0;
    const genId = () =>
      globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `mk_${Date.now()}_${__uidCounter++}`;

    const newPos: NotePosition = {
      id: genId(),
      fileIdx: pendingNotePosition.fileIdx,
      pageInFile: pendingNotePosition.pageInFile,
      x: pendingNotePosition.x,
      y: pendingNotePosition.y,
      text: noteModalText.trim(),
      sizePct: 100,
    };

    setNotePositions((prev) => [...prev, newPos]);
    setNoteModalOpen(false);
    setPendingNotePosition(null);
    setNoteModalText("");
  };

  const handleNoteModalCancel = () => {
    setNoteModalOpen(false);
    setPendingNotePosition(null);
    setNoteModalText("");
  };
  
  const handleSave = async () => {
    if (saving) return;

    // 🔍 DEBUG: Log mode and memoId to understand the issue
    console.log("[handleSave] mode:", mode, "memoId:", memoId, "isCreate:", mode === "create");

    // ❗ มีช่อง flexible ยังไม่ได้เลือกคน
    if (hasUnassignedFlexible) {
      toast.error(
        t("selectUserFirst") ?? "Please select a user for the flexible slot approver first"
      );
      setStep(2);
      return;
    }

    /* ---------- validation ---------- */
    const isCreate = mode === "create";
    const noAnyMainFiles = files.length === 0 && existingMainFiles.length === 0;

    // Check file size limit (50MB = 50 * 1024 * 1024 bytes)
    const maxSize = 50 * 1024 * 1024;
    const oversizedMainFiles = files.filter(f => f.size > maxSize);
    const oversizedAttachedFiles = attachedFiles.filter(f => f.size > maxSize);
    
    if (oversizedMainFiles.length > 0 || oversizedAttachedFiles.length > 0) {
      const allOversized = [...oversizedMainFiles, ...oversizedAttachedFiles];
      const fileDetails = allOversized.map(f => `${f.name} (${formatFileSize(f.size)})`).join(', ');
      toast.error(`Cannot save memo. File size exceeds 50MB limit: ${fileDetails}. Please remove or replace with smaller files.`);
      setStep(1);
      return;
    }

    // Validate step 1 fields
    if (!subject.trim()) {
      toast.error(t("errors.subjectRequired") || "กรุณากรอกหัวข้อเรื่อง");
      setStep(1);
      return;
    }
    
    if (memoTypeId === "") {
      toast.error(t("errors.memoTypeRequired") || "กรุณาเลือกประเภทเอกสาร");
      setStep(1);
      return;
    }

    if (isCreate && noAnyMainFiles) {
      toast.error("Please upload at least one main file");
      setStep(1);
      return;
    }

    if (approvers.length === 0) {
      toast.error("Please add at least one approver");
      setStep(2);
      return;
    }

    // ตรวจวันหมดอายุถ้ามีกรอก
    if (expiryAtLocal) {
      const expMs = new Date(expiryAtLocal).getTime();
      if (!Number.isFinite(expMs)) {
        toast.error(t("errors.expiryInvalid") ?? "Invalid expiry date");
        setStep(2);
        return;
      }
      if (expMs <= Date.now()) {
        toast.error(
          t("errors.expiryMustBeFuture") ?? "Expiry must be in the future"
        );
        setStep(2);
        return;
      }
    }
    const missing = getMissingSignatureApprovers(); // [{ ap, idx }, ...]
    if (missing.length > 0) {
      const idxs = missing.map((m) => m.idx);

      // ไฮไลต์การ์ดที่ขาด
      setFlashMissingIdxs(idxs);
      setStep(2);

      toast.error(
        t("errors.missingSignatures", { count: missing.length }) ||
        `กรุณาวางลายเซ็นให้ครบ (${missing.length} คน)`
      );

      // เลื่อนจอไปการ์ดคนแรกที่ยังไม่วาง
      requestAnimationFrame(() => {
        const first = document.querySelector<HTMLElement>(
          `[data-approver-idx="${idxs[0]}"]`
        );
        first?.scrollIntoView({ behavior: "smooth", block: "center" });
      });

      // ล้างเอฟเฟกต์ไฮไลต์ภายหลัง (ตามชอบ)
      setTimeout(() => setFlashMissingIdxs([]), 2500);

      return; // ⬅️ อย่าลืม return เพื่อหยุดการบั
    }
    /* ---------- build FormData ---------- */
    const form = new FormData();

    form.append("subject", subject);
    appendNumber("businessUnitId", businessUnitId, form);
    appendNumber("departmentId", departmentId, form);
    appendNumber("memotypeId", memoTypeId, form);
    form.append("userId", String(userId));
    form.append("statusId", String(statusId));

    // ใส่ expiresAt เฉพาะเมื่อมีค่าและ valid
    if (expiryAtLocal) {
      const iso = fromDatetimeLocalToISO(expiryAtLocal);
      if (iso) form.append("expiresAt", iso);
    }

    // approvalLineId: create ⇒ ใส่ตรง ๆ, edit ⇒ ใส่เฉพาะกรณีเปลี่ยน
    const newApprovalLineId = selectedApprovalLine?.id ?? null;
    if (newApprovalLineId != null) {
      form.append("approvalLineId", String(newApprovalLineId));
    }

    // ปลอดภัยไว้ก่อน: list ที่อาจ undefined
    const removedAttached = removedAttachedFileIds ?? [];
    const removedExisting = removedExistingFileIds ?? [];
    const orderTok = (orderTokens ?? []).map((t) => t.token);

    form.append("removedAttachedFileIds", JSON.stringify(removedAttached));
    form.append("fileOrderTokens", JSON.stringify(orderTok));
    form.append(
      "existingFileIds",
      JSON.stringify(
        (existingMainFiles ?? [])
          .filter((f) => !removedExisting.includes(f.id))
          .map((f) => f.id)
      )
    );
    form.append("removedFileIds", JSON.stringify(removedExisting));

    // อัปโหลดไฟล์
    (files ?? []).forEach((f) => form.append("files", f));
    (attachedFiles ?? []).forEach((f) => form.append("attachedFiles", f));

    // Add URL links
    if (urlLinks.length > 0) {
      form.append("urlLinks", JSON.stringify(urlLinks));
    }

    // รวมตำแหน่งลายเซ็น/วันที่ ให้ field ชื่อที่ backend ต้องการ
    const collect = (
      list: Record<number, (SignaturePosition | DatePosition)[]>
    ) => {
      const out: any[] = [];
      for (const [idxStr, arr] of Object.entries(list ?? {})) {
        const idx = Number(idxStr);
        const ap = approvers[idx];
        const required = ap && !ap.isFlexibleSlot && isSigRequired(ap, idx);

        if (!required) continue; // ⬅️ ข้ามคนที่ไม่ต้องเซ็น

        // Get the level for this approver
        const approverLevel = ap?.level;

        for (const p of arr) {
          out.push({
            ...(typeof (p as any).id === "number" ? { id: (p as any).id } : {}),
            userId: (p as any).userId,
            fileIdx: (p as any).fileIdx,
            page: (p as any).pageInFile,
            x: round6((p as any).x),
            y: round6((p as any).y),
            sizePct: (p as any).sizePct ?? 100,
            level: approverLevel, // Include the approval level
            ...("date" in p && (p as any).date
              ? { date: (p as any).date }
              : {}),
          });
        }
      }
      return out;
    };
    form.append("sigPositions", JSON.stringify(collect(sigPositions)));
    form.append("datePositions", JSON.stringify(collect(datePositions)));

    // ✅ ส่ง notePositions (like memoNumberPositions)
    const collectNotes = (list: NotePosition[]) => {
      return list.map((p) => ({
        ...(typeof p.id === "number" ? { id: p.id } : {}),
        fileIdx: p.fileIdx,
        page: p.pageInFile,
        x: round6(p.x),
        y: round6(p.y),
        text: p.text,
        sizePct: p.sizePct ?? 100,
      }));
    };
    form.append("notePositions", JSON.stringify(collectNotes(notePositions)));

    // ✅ ส่ง memoNumberPositions
    const collectMemoNumbers = (list: MemoNumberPosition[]) => {
      return list.map((p) => ({
        ...(typeof p.id === "number" ? { id: p.id } : {}),
        fileIdx: p.fileIdx,
        page: p.pageInFile,
        x: round6(p.x),
        y: round6(p.y),
        sizePct: p.sizePct ?? 100,
      }));
    };
    form.append(
      "memoNumberPositions",
      JSON.stringify(collectMemoNumbers(memoNumberPositions))
    );

    /* ---------- ตรวจการเปลี่ยน flow (ระดับ/ลำดับ/ต้องเซ็น) ---------- */
    const didSigChange = approvers.some(
      (ap, i) => (ap.isSigReq ?? true) !== wantSigOf(ap, i)
    );

    // ถ้ามีฟิลด์ level ใน state: ตรวจว่าเรียง 0..n-1 ตาม index ไหม
    const didOrderOrLevelChange = approvers.some(
      (ap, i) => (ap.level ?? i) !== i
    );

    const didLengthChange =
      (originalApproversRef.current?.length ?? approvers.length) !==
      approvers.length;

    const anyFlexOrMeta = approvers.some(
      (a) =>
        a.isFlexibleSlot || // ยังเป็นช่องยืดหยุ่นอยู่
        (a.slotType && a.slotType !== "FIXED_USER") || // เป็น DEPARTMENT_HEAD, MEMO_REQUESTER ฯลฯ
        !!a.roleDescription // มี roleDescription กำหนดพิเศษ
    );

    const useOverride = Boolean(
      canSaveLine ||
      didSigChange ||
      didOrderOrLevelChange ||
      didLengthChange ||
      anyFlexOrMeta
    );

    if (useOverride) {
      const lineIdForOverride =
        selectedApprovalLine?.id ?? originalApprovalLineId ?? null;

      const override = approvers.map((ap, i) => ({
        userId: ap.id,
        // ใช้ level จาก state ถ้ามี ถ้าไม่มีค่อย fallback เป็น index
        level: typeof ap.level === "number" ? ap.level : i,
        isSigReq: wantSigOf(ap, i),

        // ⬇⬇ สำคัญสุด: ส่ง id ของแถว ForUse เดิมให้หลังบ้าน
        loaUserPivotId:
          typeof ap.loaUserPivotId === "number" && Number.isFinite(ap.loaUserPivotId)
            ? ap.loaUserPivotId
            : null,

        lineOfApprovalId: lineIdForOverride,
        slotType: ap.slotType ?? null,
        roleDescription: ap.roleDescription ?? null,
        approvalRequirement: (ap as any).approvalRequirement ?? "ALL", // ✅ Add approval requirement
      }));



      // // ✅ Debug logging
      // console.log(
      //   "[FRONTEND DEBUG] approvers with templatePivotId:",
      //   approvers.map((ap) => ({
      //     id: ap.id,
      //     name: ap.name,
      //     loaUserPivotId: ap.loaUserPivotId,
      //     templatePivotId: ap.templatePivotId,
      //   }))
      // );
      // console.log(
      //   "[FRONTEND DEBUG] override data to send:",
      //   JSON.stringify(override, null, 2)
      // );

      form.append("approversOverride", JSON.stringify(override));
    }

    /* ---------- submit + loading ---------- */
    setSaving(true);
    const toastId = toast.loading(t("saving") ?? "Saving...");

    const config: AxiosRequestConfig<FormData> = {
      withCredentials: true,
      onUploadProgress: (pe) => {
        const pct =
          pe.progress != null
            ? Math.round(pe.progress * 100)
            : pe.total
              ? Math.round((pe.loaded * 100) / pe.total)
              : null;
        if (pct != null) {
          toast.loading(`${t("saving") ?? "Saving..."} ${pct}%`, {
            id: toastId,
          });
        }
      },
    };

    try {
      // 🔍 DEBUG: Log the request details
      console.log("[handleSave] Making request:", {
        isCreate,
        method: isCreate ? "POST" : "PUT",
        url: isCreate ? "/api/memos" : `/api/memos/${memoId}`,
        memoId,
        filesCount: files?.length ?? 0,
        attachedFilesCount: attachedFiles?.length ?? 0,
      });

      // 1) สร้าง/แก้ไขเมโม
      const res = isCreate
        ? await axios.post("/api/memos", form, config)
        : await axios.put(`/api/memos/${memoId}`, form, config);

      // 2) บันทึก CC (แทนทั้งหมด)
      const targetMemoId = isCreate ? res.data.id : memoId!;
      try {
        await axios.put(
          `/api/memos/${targetMemoId}/cc`,
          {
            userIds: (ccSelected ?? []).map((u) => u.id),
            groupIds: (ccSelectedGroups ?? []).map((g) => g.id), // ⬅️ เพิ่ม
          },
          { withCredentials: true }
        );
      } catch (ccErr) {
        console.error("❌ save CC failed:", ccErr);
        toast.error("บันทึก CC ไม่สำเร็จ");
      }

      // 3) บันทึก Reference Memos
      if (selectedReferences.length > 0) {
        try {
          await axios.put(
            `/api/memos/${targetMemoId}/references`,
            {
              referenceIds: selectedReferences.map((ref) => ref.id),
            },
            { withCredentials: true }
          );
        } catch (refErr) {
          console.error("❌ save references failed:", refErr);
          toast.error("บันทึก Reference Memos ไม่สำเร็จ");
        }
      }

      // 4) สำเร็จ → ไป viewer
      toast.success(t("saved") ?? "Saved successfully", { id: toastId });
      const navId = isCreate ? res.data.id : memoId!;
      navigate(`/memo/${navId}`);
    } catch (err) {
      console.error("❌ save error", err);
      toast.error(t("saveFailed") ?? "Save failed", { id: toastId });
    } finally {
      setSaving(false);
    }
  };



  // Calculate displayed files
  const resolveTokenLabel = (tok: OrderToken): string => {
    if (tok.kind === "old") {
      return (
        existingMainFiles.find((x) => x.id === tok.oldId)?.fileName ??
        `old:${tok.oldId}`
      );
    }
    return files[tok.newIdx]?.name ?? t("pendingNewFile") ?? "New file"; // ✅
  };

  // helper: นับไฟล์เก่าตอนโหลดครั้งแรก (คงที่)
  const getInitialOldCount = () => Object.keys(oldIdToIndex).length;

  const removeFileByToken = (index: number, tok: OrderToken) => {
    // อัปเดต orderTokens: ลบตัวที่กด และ (ถ้าเป็น new) รีดัชนีตัวที่เหลือ
    setOrderTokens((prev) => {
      const removed = prev[index];
      const without = prev.filter((_, i) => i !== index);

      if (removed?.kind !== "new") return without;

      const removedNewIdx = removed.newIdx;
      return without.map((t) => {
        if (t.kind !== "new") return t;
        if (t.newIdx > removedNewIdx) {
          const newIdx = t.newIdx - 1;
          return { ...t, newIdx, token: `new:${newIdx}` };
        }
        return t;
      });
    });

    if (tok.kind === "old") {
      // mark removed old + อัปเดตรายการ meta ของไฟล์เก่า
      if (!removedExistingFileIds.includes(tok.oldId)) {
        setRemovedExistingFileIds((prev) => [...prev, tok.oldId]);
      }
      setExistingMainFiles((prev) => prev.filter((f) => f.id !== tok.oldId));
      // ไม่ต้องไปยุ่ง fileUrls/loadedPageCounts เพราะ viewer จะ rebuild จาก orderTokens อยู่แล้ว
    } else {
      // ลบไฟล์ใหม่: ต้องลบจาก files, fileUrls, loadedPageCounts ให้ถูก index
      const removedNewIdx = tok.newIdx;
      const oldCountFixed = getInitialOldCount(); // จำนวนไฟล์เก่าตอนโหลดครั้งแรก

      setFiles((prev) => prev.filter((_, i) => i !== removedNewIdx));

      setFileUrls((prev) => {
        const absoluteIdx = oldCountFixed + removedNewIdx;

        // cleanup blob URL ที่ลบทิ้ง
        const removedItem = prev[absoluteIdx];
        if (removedItem?.url?.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(removedItem.url);
          } catch {
            // Ignore URL revoke errors
          }
        }
        return prev.filter((_, i) => i !== absoluteIdx);
      });

      setLoadedPageCounts((prev) =>
        prev.filter((_, i) => i !== oldCountFixed + removedNewIdx)
      );
    }

    // Remap markers แทนการลบทิ้ง
    const removedFileIdx = index;
    
    // Remap signature positions
    setSigPositions((prev) => {
      const newPos: typeof prev = {};
      Object.entries(prev).forEach(([approverIdx, positions]) => {
        // กรองเฉพาะ markers ที่ไม่ได้อยู่ในไฟล์ที่ลบ และ remap fileIdx
        const filtered = positions
          .filter(p => p.fileIdx !== removedFileIdx)
          .map(p => ({
            ...p,
            fileIdx: p.fileIdx > removedFileIdx ? p.fileIdx - 1 : p.fileIdx
          }));
        
        if (filtered.length > 0) {
          newPos[Number(approverIdx)] = filtered;
        }
      });
      return newPos;
    });
    
    // Remap date positions
    setDatePositions((prev) => {
      const newPos: typeof prev = {};
      Object.entries(prev).forEach(([approverIdx, positions]) => {
        const filtered = positions
          .filter(p => p.fileIdx !== removedFileIdx)
          .map(p => ({
            ...p,
            fileIdx: p.fileIdx > removedFileIdx ? p.fileIdx - 1 : p.fileIdx
          }));
        
        if (filtered.length > 0) {
          newPos[Number(approverIdx)] = filtered;
        }
      });
      return newPos;
    });
    
    // Remap note positions
    setNotePositions((prev) => 
      prev
        .filter(p => p.fileIdx !== removedFileIdx)
        .map(p => ({
          ...p,
          fileIdx: p.fileIdx > removedFileIdx ? p.fileIdx - 1 : p.fileIdx
        }))
    );
    
    // Remap memo number positions
    setMemoNumberPositions((prev) => 
      prev
        .filter(p => p.fileIdx !== removedFileIdx)
        .map(p => ({
          ...p,
          fileIdx: p.fileIdx > removedFileIdx ? p.fileIdx - 1 : p.fileIdx
        }))
    );
    
    setCurrentPage(1);
  };

  // helper สลับตำแหน่งในอาเรย์
  const reorder = <T,>(arr: T[], from: number, to: number): T[] => {
    const copy = [...arr];
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved);
    return copy;
  };

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const from = result.source.index;
    const to = result.destination.index;
    
    if (from === to) return; // ไม่ได้เปลี่ยนตำแหน่ง
    
    // สร้าง mapping จาก fileIdx เก่า -> fileIdx ใหม่
    const oldToNewFileIdx = new Map<number, number>();
    orderTokens.forEach((_, oldIdx) => {
      let newIdx = oldIdx;
      if (oldIdx === from) {
        newIdx = to;
      } else if (from < to && oldIdx > from && oldIdx <= to) {
        newIdx = oldIdx - 1;
      } else if (from > to && oldIdx >= to && oldIdx < from) {
        newIdx = oldIdx + 1;
      }
      oldToNewFileIdx.set(oldIdx, newIdx);
    });
    
    // อัปเดตลำดับไฟล์
    setOrderTokens((prev) => reorder(prev, from, to));
    
    // Remap signature positions
    setSigPositions((prev) => {
      const newPos: typeof prev = {};
      Object.entries(prev).forEach(([approverIdx, positions]) => {
        newPos[Number(approverIdx)] = positions.map(p => ({
          ...p,
          fileIdx: oldToNewFileIdx.get(p.fileIdx) ?? p.fileIdx
        }));
      });
      return newPos;
    });
    
    // Remap date positions
    setDatePositions((prev) => {
      const newPos: typeof prev = {};
      Object.entries(prev).forEach(([approverIdx, positions]) => {
        newPos[Number(approverIdx)] = positions.map(p => ({
          ...p,
          fileIdx: oldToNewFileIdx.get(p.fileIdx) ?? p.fileIdx
        }));
      });
      return newPos;
    });
    
    // Remap note positions
    setNotePositions((prev) => 
      prev.map(p => ({
        ...p,
        fileIdx: oldToNewFileIdx.get(p.fileIdx) ?? p.fileIdx
      }))
    );
    
    // Remap memo number positions
    setMemoNumberPositions((prev) => 
      prev.map(p => ({
        ...p,
        fileIdx: oldToNewFileIdx.get(p.fileIdx) ?? p.fileIdx
      }))
    );
    
    // คำนวณหน้าใหม่ที่ควรแสดง (พยายามรักษาหน้าปัจจุบันไว้)
    const currentFileIdx = active.fileIdx;
    const newFileIdx = oldToNewFileIdx.get(currentFileIdx) ?? currentFileIdx;
    
    if (newFileIdx !== currentFileIdx) {
      // คำนวณ global page ใหม่
      let newGlobalPage = 0;
      for (let i = 0; i < newFileIdx; i++) {
        newGlobalPage += orderedPageCounts[i] || 0;
      }
      newGlobalPage += active.pageInFile;
      setCurrentPage(newGlobalPage);
    }
  };

  // กลุ่มผู้อนุมัติตาม level โดยเก็บ index เดิมของแต่ละคนไว้ (ใช้กับ markers)
  const groupedApprovers = React.useMemo(() => {
    const m = new Map<
      number,
      { level: number; items: Array<{ ap: Approver; idx: number }> }
    >();
    approvers.forEach((ap, idx) => {
      const lv = typeof ap.level === "number" ? ap.level : idx;
      if (!m.has(lv)) m.set(lv, { level: lv, items: [] });
      m.get(lv)!.items.push({ ap, idx });
    });
    // Sort by level number to maintain proper order
    return Array.from(m.values()).sort((a, b) => a.level - b.level);
  }, [approvers]);
  const hasUnassignedFlexible = React.useMemo(
    () => approvers.some((ap) => ap.isFlexibleSlot === true),
    [approvers]
  );

  // คำนวณหน้าไฟล์ปัจจุบันจาก currentPage
  const active = useMemo(
    () => getFileAndPageFromGlobal(currentPage),
    [currentPage, orderedPageCounts] // ✅ เพิ่ม orderedPageCounts เพื่อให้ recalculate เมื่อไฟล์เปลี่ยน
  );
  const isActivePos = (p: { fileIdx: number; pageInFile: number }) =>
    p.fileIdx === active.fileIdx && p.pageInFile === active.pageInFile;

  // Debug: Log signature positions when they change
  useEffect(() => {
    console.log('📝 Signature positions updated:', sigPositions);
    console.log('📄 Current page:', currentPage, 'Active file:', active);
  }, [sigPositions, currentPage, active]);

  return (
    <div
      className="min-h-screen w-full max-w-[100vw] overflow-x-hidden bg-white py-3 px-2 sm:px-3"
      data-fullpage
    >
      <div className="mb-10 flex flex-col sm:flex-row gap-4">
        {["stepUpload", "stepSign"].map((key, i) => {
          const isActive = step === i + 1;
          // Use proper completion check functions instead of just step > i + 1
          const isCompleted = i === 0 ? isStep1Completed() : isStep2Completed();

          return (
            <button
              key={key}
              onClick={() => goToStep(i + 1)}
              className={`relative flex-1 rounded-xl border-2 px-4 py-3 text-center text-sm font-medium transition-all duration-300 shadow-lg overflow-hidden
    ${isActive
                  ? "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white border-emerald-600 shadow-emerald-200 scale-[1.02]"
                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50 hover:shadow-md hover:border-emerald-100"
                }
          ${isCompleted ? "border-emerald-100 shadow-emerald-50" : ""}`}
            >
              {/* Animated background for active state */}
              {isActive && (
                <div className="absolute inset-0 bg-[url('https://assets.codepen.io/1468070/wave.svg')] bg-[length:200%_100%] bg-no-repeat animate-wave opacity-30"></div>
              )}

              <span className="flex items-center justify-center gap-3">
                <span
                  className={`relative z-10 w-8 h-8 flex items-center justify-center rounded-full border-2 text-sm font-bold transition-all duration-300
              ${isCompleted
                      ? "bg-emerald-500 text-white border-emerald-500 shadow-inner"
                      : isActive
                        ? "bg-white text-emerald-600 border-emerald-600 shadow"
                        : "bg-white text-gray-500 border-gray-300"
                    }`}
                >
                  {isCompleted ? (
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    i + 1
                  )}

                  {/* Animated pulse for active step */}
                  {isActive && (
                    <span className="absolute -inset-1.5 rounded-full bg-emerald-400/40 animate-ping z-[-1]"></span>
                  )}
                </span>

                <span
                  className={`font-medium transition-all duration-300 
            ${isActive ? "text-white font-semibold" : "text-gray-600"}`}
                >
                  {t(key)}
                </span>
              </span>

              {/* Step status indicator */}
              <div
                className={`absolute top-2 right-2 text-xs font-medium px-2 py-0.5 rounded-full transition-all
          ${isActive
                    ? "bg-white/20 text-white/90"
                    : isCompleted
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-gray-100 text-gray-500"
                  }`}
              >
                {isCompleted
                  ? t("stepState.completed")
                  : isActive
                    ? t("stepState.active")
                    : t("stepState.upcoming")}
              </div>
            </button>
          );
        })}
      </div>

      {/* ---------- MAIN GRID ---------- */}
      <div className="flex flex-col lg:flex-row w-full" style={{ minHeight: 'calc(100vh - 120px)' }}>
        {/* Left panel — collapsible sidebar */}
        <div
          ref={leftPanelRef}
          className="relative flex-shrink-0 border-r border-gray-200 bg-[#fafbfc] transition-[width] duration-300 ease-in-out overflow-hidden lg:overflow-y-auto lg:overflow-x-hidden"
          style={{ width: sidebarCollapsed ? 0 : 340, maxHeight: 'calc(100vh - 120px)' }}
        >
          <div className="w-[340px] p-4 space-y-4">
            {/* ============== STEP 1 ============== */}
            {step === 1 && (
              <>
                <label className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                  {t("titleLabel")}
                </label>
                <input
                  type="text"
                  value={subject}
                  ref={subjectRef}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Enter the title of your request here..."
                  className={`w-full rounded-lg border p-3 shadow-sm focus:ring-2 ${hasTypeIdParam
                    ? "title-input-emphasis text-gray-800 focus:ring-emerald-400/40"
                    : "border-red-300 text-red-800 focus:ring-red-400/40"
                    }`}
                />
                <label className="inline-block text-base font-semibold text-gray-700 mt-4 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                  {t("typeLabel")}
                </label>
                <input
                  ref={memoTypeInputRef}
                  type="text"
                  value={
                    memoTypeName ||
                    (memoTypes.find((t) => t.id === memoTypeId)?.name ?? "")
                  }
                  placeholder={t("typePlaceholder") ?? "Document Type"}
                  className="w-full rounded-lg border border-neutral-300 bg-neutral-100 p-3 text-neutral-600 shadow-sm"
                  disabled
                />

                {/* Type template files */}
                <div className="space-y-3">
                  {typeLoading ? (
                    // ── กำลังโหลด ──
                    <div className="px-6 py-8 text-center rounded-lg border border-neutral-200 bg-white">
                      <div className="inline-block animate-spin rounded-full h-8 w-8 border-2 border-emerald-500 border-t-transparent" />
                      <p className="mt-3 text-sm text-gray-500">
                        {t("files.loadingTypeFiles")}
                      </p>
                    </div>
                  ) : visibleTypeFiles.length === 0 ? (
                    // ── ไม่มีไฟล์ ──
                    <div className="px-6 py-8 text-center rounded-lg border border-neutral-200 bg-white">
                      <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <svg
                          className="w-8 h-8 text-gray-400"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                      </div>
                      <h4 className="text-sm font-semibold text-gray-900 mb-1">
                        {t("files.noTypeFilesTitle")}
                      </h4>
                      <p className="text-xs text-gray-500">
                        {t("files.noTypeFilesDesc")}
                      </p>
                    </div>
                  ) : (
                    // ── มีไฟล์ ──
                    visibleTypeFiles.map((f) => {
                      const extension =
                        f.fileName.split(".").pop()?.toLowerCase() || "";
                      const iconClass =
                        "w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0";
                      const getFileIcon = () => {
                        switch (extension) {
                          case "doc":
                          case "docx":
                            return (
                              <div className={`${iconClass} bg-blue-500`}>
                                DOC
                              </div>
                            );
                          case "xls":
                          case "xlsx":
                            return (
                              <div className={`${iconClass} bg-green-500`}>
                                XLS
                              </div>
                            );
                          case "ppt":
                          case "pptx":
                            return (
                              <div className={`${iconClass} bg-orange-500`}>
                                PPT
                              </div>
                            );
                          case "pdf":
                            return (
                              <div className={`${iconClass} bg-red-500`}>
                                PDF
                              </div>
                            );
                          default:
                            return (
                              <div className={`${iconClass} bg-gray-500`}>
                                FILE
                              </div>
                            );
                        }
                      };

                      return (
                        <div
                          key={f.id}
                          className="px-6 py-4 hover:bg-gray-50/50 transition-colors group rounded-lg border border-neutral-300"
                        >
                          <div className="flex flex-col gap-3">
                            <div className="flex items-start gap-4">
                              <div className="shrink-0 mt-1">
                                {getFileIcon()}
                              </div>

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <h4
                                    className="text-sm font-semibold text-gray-900 leading-5 line-clamp-2 break-all"
                                    title={f.fileName}
                                  >
                                    {f.fileName}
                                  </h4>
                                </div>

                                <div className="flex items-center gap-1 text-xs text-gray-500">
                                  <div className="w-2 h-2 bg-gray-300 rounded-full" />
                                  <span>{humanSize(f.size)}</span>
                                </div>
                              </div>
                            </div>

                            <div className="pt-1">
                              <div className="flex justify-center">
                                <button
                                  type="button"
                                  onClick={() => handleDownloadTypeFile(f)}
                                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl
                             bg-white border border-gray-200 text-gray-700
                             hover:bg-blue-100 hover:border-blue-300 hover:text-blue-800
                             transition-all duration-200 group-hover:shadow-sm"
                                  title={t("files.downloadTemplate")}
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
                                      strokeWidth="2"
                                      d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
                                    />
                                  </svg>
                                  <span>{t("files.download")}</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {[
                  {
                    v: businessUnits.find((b) => b.id === businessUnitId)?.name,
                    p: "Business Unit",
                    label: "บริษัท (Business Unit)",
                  },
                  {
                    v: departments.find((d) => d.id === departmentId)?.name,
                    p: "Department",
                    label: "แผนก (Department)",
                  },
                ].map(({ v, p, label }) => (
                  <div key={p} className="mb-4">
                    <label className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                      {label}
                    </label>
                    <input
                      value={v ?? ""}
                      placeholder={p}
                      disabled
                      className="w-full rounded-lg border border-neutral-300 bg-neutral-100 p-3 text-neutral-500 shadow-sm"
                    />
                  </div>
                ))}

                {/* ===== MAIN FILE UPLOAD SECTION (moved from step 2) ===== */}
                <div className="mt-6">
                  <h4 className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                    {t("mainFilesLabel")}
                  </h4>
                  <label
                    htmlFor="pdfFile"
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                      setIsDraggingMain(true);
                    }}
                    onDragEnter={() => setIsDraggingMain(true)}
                    onDragLeave={() => setIsDraggingMain(false)}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setIsDraggingMain(false);
                      const files = Array.from(e.dataTransfer.files || []);
                      await processNewMainFiles(files);
                    }}
                    className={`block w-full p-6 border-2 border-dashed rounded-lg text-center cursor-pointer transition-colors
    ${isDraggingMain
                        ? "border-emerald-500 bg-emerald-50"
                        : showMainFileEmphasis
                        ? "main-file-upload-emphasis"
                        : "border-gray-300 hover:bg-gray-50"
                      }`}
                  >
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-gray-700 font-medium">
                        {t("uploadFiles")}
                      </span>
                      <span className="text-xs text-gray-500">
                        {isDraggingMain
                          ? t("dropHere") ?? "Drop files here"
                          : t("uploadHint")}
                      </span>
                    </div>
                  </label>

                  <input
                    ref={pdfInputRef}
                    id="pdfFile"
                    name="files"
                    type="file"
                    accept="application/pdf"
                    multiple
                    onChange={handleMultiFileChange}
                    className="hidden"
                  />
                </div>

                {/* Main files list */}
                {orderTokens.length > 0 && (
                  <div className="mt-6">
                    <DragDropContext onDragEnd={handleDragEnd}>
                      <Droppable droppableId="file-order">
                        {(dp) => (
                          <ul
                            ref={dp.innerRef}
                            {...dp.droppableProps}
                            className="space-y-2"
                          >
                            {orderTokens.map((tok, i) => (
                              <Draggable
                                key={tok.token}
                                draggableId={tok.token}
                                index={i}
                              >
                                {(dg) => (
                                  <li
                                    ref={dg.innerRef}
                                    {...dg.draggableProps}
                                    {...dg.dragHandleProps}
                                    className="flex items-center justify-between gap-3 rounded-lg border border-neutral-300 bg-white px-3 py-2"
                                  >
                                    <div className="truncate">
                                      <span className="mr-2 text-gray-400">
                                        {i + 1}.
                                      </span>
                                      <span className="font-medium text-gray-800">
                                        {resolveTokenLabel(tok)}
                                      </span>
                                    </div>

                                    <div className="flex items-center gap-3">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          removeFileByToken(i, tok)
                                        }
                                        className="rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                                        title="ลบไฟล์นี้ออกจากเมโม"
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  </li>
                                )}
                              </Draggable>
                            ))}
                            {dp.placeholder}
                          </ul>
                        )}
                      </Droppable>
                    </DragDropContext>
                  </div>
                )}

                {/* ===== ATTACHMENTS SECTION (Files + URL Links) ===== */}
                <div className="mt-6">
                  <h4 className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                    {t("attachmentsLabel")}
                  </h4>
                  
                  {/* File Upload */}
                  <label
                    htmlFor="attachedFiles"
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                      setIsDraggingAttach(true);
                    }}
                    onDragEnter={() => setIsDraggingAttach(true)}
                    onDragLeave={() => setIsDraggingAttach(false)}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setIsDraggingAttach(false);
                      const files = Array.from(e.dataTransfer.files || []);
                      await processNewAttachedFiles(files);
                    }}
                    className={`block w-full p-6 border-2 border-dashed rounded-lg text-center cursor-pointer transition-colors
    ${isDraggingAttach
                        ? "border-emerald-500 bg-emerald-50"
                        : "border-gray-300 hover:bg-gray-50"
                      }`}
                  >
                    <span className="text-gray-400">
                      {isDraggingAttach
                        ? t("dropHere") ?? "Drop files here"
                        : t("filePlaceholder")}
                    </span>
                  </label>

                  <input
                    id="attachedFiles"
                    ref={attachedInputRef}
                    name="attachedFiles"
                    type="file"
                    accept="
    application/pdf,
    image/*,
    application/vnd.ms-powerpoint,
    application/vnd.openxmlformats-officedocument.presentationml.presentation,
    application/msword,
    application/vnd.openxmlformats-officedocument.wordprocessingml.document,
    application/vnd.ms-word.document.macroEnabled.12,
    application/vnd.openxmlformats-officedocument.wordprocessingml.template,
    application/vnd.ms-word.template.macroEnabled.12,
    application/vnd.ms-excel,
    application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,
    application/vnd.ms-excel.sheet.macroEnabled.12,
    application/vnd.ms-excel.sheet.binary.macroEnabled.12,
    application/vnd.openxmlformats-officedocument.spreadsheetml.template,
    application/vnd.ms-excel.template.macroEnabled.12,
    .ppt,.pptx,
    .doc,.docx,.docm,.dotx,.dotm,
    .xls,.xlsx,.xlsm,.xlsb,.xltx,.xltm
  "
                    multiple
                    onChange={handleAttachedFileChange}
                    className="hidden"
                  />

                  {/* URL Link Input */}
                  <div className="mt-4 space-y-3 p-4 border border-gray-200 rounded-lg bg-gray-50">
                    <div className="text-xs font-medium text-gray-700 mb-2">
                      {t("orAddUrlLink")}
                    </div>
                    
                    <button
                      type="button"
                      onClick={() => setShowUrlModal(true)}
                      className="w-full px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors"
                    >
                      {t("addUrlLink")}
                    </button>
                  </div>

                  {/* Combined Attachments List (Files + URLs) */}
                  {(existingAttachedFiles.filter(
                    (f) => !removedAttachedFileIds.includes(f.id)
                  ).length > 0 ||
                    attachedFileUrls.length > 0 ||
                    urlLinks.length > 0) && (
                    <div className="mt-4 p-4 border border-gray-200 rounded-lg bg-white max-w-md">
                      <ul className="space-y-2 text-sm text-gray-700">
                        {/* Existing file attachments */}
                        {existingAttachedFiles
                          .filter((f) => !removedAttachedFileIds.includes(f.id))
                          .map((f) => (
                            <li
                              key={`old-${f.id}`}
                              className="flex justify-between items-center border-b py-2"
                            >
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                <svg className="w-4 h-4 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                                </svg>
                                <a
                                  href={f.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="truncate hover:text-blue-600"
                                >
                                  {f.fileName}
                                </a>
                              </div>
                              <button
                                onClick={() =>
                                  setRemovedAttachedFileIds((prev) =>
                                    prev.includes(f.id) ? prev : [...prev, f.id]
                                  )
                                }
                                className="text-red-500 hover:text-red-700 flex-shrink-0 ml-2"
                                title={t("removeFile")}
                                type="button"
                              >
                                ✕
                              </button>
                            </li>
                          ))}

                        {/* New file attachments */}
                        {attachedFileUrls.map((f, i) => (
                          <li
                            key={`new-file-${i}`}
                            className="flex justify-between items-center border-b py-2"
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <svg className="w-4 h-4 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                              <span className="truncate">
                                {f.file!.name}
                              </span>
                            </div>
                            <button
                              onClick={() => {
                                setAttachedFiles((a) =>
                                  a.filter((_, idx) => idx !== i)
                                );
                                setAttachedFileUrls((a) =>
                                  a.filter((_, idx) => idx !== i)
                                );
                              }}
                              className="text-red-500 hover:text-red-700 flex-shrink-0 ml-2"
                              title={t("removeFile")}
                              type="button"
                            >
                              ✕
                            </button>
                          </li>
                        ))}

                        {/* URL Links */}
                        {urlLinks.map((link, i) => (
                          <li
                            key={`url-${i}`}
                            className="flex justify-between items-start border-b py-2"
                          >
                            <div className="flex items-start gap-2 flex-1 min-w-0">
                              <svg className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                              </svg>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium truncate">{link.title}</div>
                                <a
                                  href={link.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-blue-600 hover:underline truncate block"
                                >
                                  {link.url}
                                </a>
                              </div>
                            </div>
                            <button
                              onClick={() => handleRemoveUrlLink(i)}
                              className="text-red-500 hover:text-red-700 flex-shrink-0 ml-2"
                              title={t("removeLink")}
                              type="button"
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <button
                  onClick={() => {
                    setStep(2);
                  }}
                  className="w-full rounded-lg bg-[#183e33] py-3 font-semibold text-white hover:bg-[#142f28] mt-4"
                >
                  {t("next")}
                </button>
              </>
            )}

            {step === 2 && (
              <>
                {/* --- CC selector (moved from step 1) --- */}
                <div className="mt-2">
                  <label className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                    {t("ccLabel")}
                  </label>

                  {/* chips (selected) */}
                  {ccSelected.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {ccSelected.map((u) => {
                        const avatarSrc = getAvatarSrc(u.profileImageUrl, u.id);
                        const label = formatCC(u);

                        return (
                          <span
                            key={u.id}
                            className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1"
                            title={label}
                          >
                            <Avatar
                              url={u.profileImageUrl}
                              name={u.name}
                              lastname={u.lastname}
                              email={u.email}
                              size="xs"
                              className="ring-1 ring-emerald-200"
                            />
                            <span className="max-w-[180px] truncate text-sm text-emerald-900">
                              {label}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeCc(u.id)}
                              className="ml-1 -mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-emerald-100"
                              aria-label="Remove CC"
                              title="Remove"
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {ccSelectedGroups.length > 0 && (
                    // เดิมเป็น flex-wrap; เปลี่ยนเป็นคอลัมน์เพื่อให้แผงสมาชิกกินความกว้างได้
                    <div className="flex flex-col gap-2 mb-2">
                      {ccSelectedGroups.map((g) => (
                        <div key={`g-${g.id}`} className="w-full">
                          {/* ชิปกลุ่ม */}
                          <div
                            className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1"
                            title={g.name}
                          >
                            <span className="text-xs font-semibold text-sky-700">
                              Group
                            </span>
                            <span className="max-w-[220px] truncate text-sm text-sky-900">
                              {g.name} ({g.memberCount})
                            </span>

                            {/* 👁 ปุ่มดูสมาชิกแบบ inline (ไม่ใช้ modal) */}
                            <button
                              type="button"
                              onClick={() => toggleGroupInline(g)}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-sky-100"
                              aria-label="View members"
                              title="View members"
                            >
                              <Eye
                                className={`w-3.5 h-3.5 text-sky-700 transition-transform ${expandedGroup[g.id] ? "rotate-180" : ""
                                  }`}
                              />
                            </button>

                            {/* ปุ่มลบกลุ่มออกจาก CC */}
                            <button
                              type="button"
                              onClick={() => removeCcGroup(g.id)}
                              className="ml-1 -mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-sky-100"
                              aria-label="Remove CC group"
                              title="Remove"
                            >
                              ×
                            </button>
                          </div>

                          {/* แผงสมาชิกแบบ inline (1 ชื่อต่อ 1 แถว) */}
                          {expandedGroup[g.id] && (
                            <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50/60">
                              {groupLoading[g.id] ? (
                                <div className="p-3 text-sm text-sky-700">
                                  กำลังโหลดสมาชิก…
                                </div>
                              ) : (groupMembers[g.id]?.length ?? 0) > 0 ? (
                                (() => {
                                  const members = groupMembers[g.id] ?? [];
                                  const needScroll = members.length > 5; // 👈 เกิน 5 คนให้มีสกอร์บาร์

                                  return (
                                    <ul
                                      className={
                                        "divide-y divide-sky-100 " +
                                        (needScroll
                                          ? "max-h-48 overflow-y-auto pr-1"
                                          : "")
                                        // max-h-48 = ~12rem / ปรับตามความสูงที่อยากได้
                                      }
                                    >
                                      {members.map((m) => (
                                        <li
                                          key={m.id}
                                          className="flex items-center gap-2 py-2 px-3"
                                        >
                                          <Avatar
                                            url={m.profileImageUrl}
                                            name={m.name}
                                            lastname={m.lastname}
                                            email={m.email}
                                            size="xs"
                                            className="ring-1 ring-sky-200"
                                          />
                                          <div className="min-w-0">
                                            <div className="truncate text-sm text-sky-900">
                                              {formatCC(m)}
                                            </div>
                                            {m.email && (
                                              <div className="truncate text-[11px] text-sky-600">
                                                {m.email}
                                              </div>
                                            )}
                                          </div>
                                        </li>
                                      ))}
                                    </ul>
                                  );
                                })()
                              ) : (
                                <div className="p-3 text-sm text-sky-700">
                                  ไม่มีสมาชิกในกลุ่ม
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2 mb-2">
                    {(["all", "users", "groups"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setCcTab(tab)}
                        className={`px-2.5 py-1 rounded-full text-xs border ${ccTab === tab
                            ? "bg-emerald-600 text-white border-emerald-600"
                            : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                          }`}
                      >
                        {tab === "all"
                          ? "All"
                          : tab === "users"
                            ? "Users"
                            : "Groups"}
                      </button>
                    ))}
                  </div>

                  {/* search box */}
                  <div className="relative">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                      <input
                        type="text"
                        value={ccQuery}
                        onChange={(e) => {
                          setCcQuery(e.target.value);
                          setIsCcOpen(true);
                        }}
                        onFocus={() => {
                          setIsCcOpen(true);
                          // Load all users and groups when focused without query
                          if (ccQuery.trim().length === 0) {
                            loadAllCcOptions();
                          }
                        }}
                        placeholder={t("placeholder")}
                        className="w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 transition-colors"
                      />
                      {ccLoading && (
                        <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                          <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
                        </div>
                      )}
                    </div>

                    {/* Search Results Dropdown */}
                    {isCcOpen && (ccQuery.trim().length >= 2 || ccQuery.trim().length === 0) && (
                      <>
                        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-hidden">
                          <div className="max-h-80 overflow-y-auto">
                            {ccLoading ? (
                              <div className="p-6 text-center">
                                <Loader2 className="w-6 h-6 animate-spin text-emerald-500 mx-auto mb-2" />
                                <p className="text-sm text-gray-500">Searching...</p>
                              </div>
                            ) : ccQuery.trim().length === 0 ? (
                              // Show all users and groups when no query
                              <div className="py-1">
                                {(ccResults.length > 0 || ccGroupResults.length > 0) ? (
                                  <>
                                    {/* All Groups Section */}
                                    {(ccTab === "all" || ccTab === "groups") && ccGroupResults.length > 0 && (
                                      <>
                                        <div className="px-4 py-2 text-xs text-gray-500 bg-gray-50 border-b border-gray-100">
                                          Available Groups
                                        </div>
                                        {ccGroupResults
                                          .filter(g => !ccSelectedGroups.some(x => x.id === g.id))
                                          .map((g) => (
                                          <button
                                            key={`all-g-${g.id}`}
                                            type="button"
                                            onClick={() => addCcGroup(g)}
                                            className="w-full px-4 py-3 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-none transition-colors border-b border-gray-100 last:border-b-0"
                                          >
                                            <div className="space-y-2">
                                              {/* Group Name and Member Count */}
                                              <div className="flex items-start justify-between gap-2">
                                                <div className="flex items-center gap-3 flex-1">
                                                  <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center text-emerald-700 text-xs font-bold flex-shrink-0">
                                                    G
                                                  </div>
                                                  <div className="min-w-0 flex-1">
                                                    <h4 className="text-sm font-medium text-gray-900 truncate">
                                                      {g.name}
                                                    </h4>
                                                  </div>
                                                </div>
                                                <div className="flex items-center gap-2 flex-shrink-0">
                                                  <span className="text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded">
                                                    {g.memberCount} members
                                                  </span>
                                                  <Plus className="w-4 h-4 text-emerald-600" />
                                                </div>
                                              </div>

                                              {/* Preview Members */}
                                              {g.previewMembers && g.previewMembers.length > 0 && (
                                                <div className="flex items-center gap-4 text-xs text-gray-500 ml-11">
                                                  <div className="flex items-center gap-1">
                                                    <Users className="w-3 h-3" />
                                                    <span className="truncate">
                                                      {g.previewMembers.map((m) => m.name).join(", ")}
                                                      {g.memberCount > g.previewMembers.length ? " ..." : ""}
                                                    </span>
                                                  </div>
                                                </div>
                                              )}
                                            </div>
                                          </button>
                                        ))}
                                      </>
                                    )}

                                    {/* All Users Section */}
                                    {(ccTab === "all" || ccTab === "users") && ccResults.length > 0 && (
                                      <>
                                        <div className="px-4 py-2 text-xs text-gray-500 bg-gray-50 border-b border-gray-100">
                                          Available Users
                                        </div>
                                        {ccResults
                                          .filter(u => !ccSelected.some(x => x.id === u.id))
                                          .map((u) => (
                                          <button
                                            key={`all-u-${u.id}`}
                                            type="button"
                                            onClick={() => addCcUser(u)}
                                            className="w-full px-4 py-3 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-none transition-colors border-b border-gray-100 last:border-b-0"
                                          >
                                            <div className="flex items-center gap-3">
                                              <Avatar
                                                url={u.profileImageUrl}
                                                name={u.name}
                                                lastname={u.lastname}
                                                email={u.email}
                                                size="sm"
                                                className="ring-1 ring-gray-200"
                                              />
                                              <div className="min-w-0 flex-1">
                                                <div className="flex items-center justify-between gap-2">
                                                  <h4 className="text-sm font-medium text-gray-900 truncate">
                                                    {formatCC(u)}
                                                  </h4>
                                                  <Plus className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                                                </div>
                                                {u.email && (
                                                  <p className="text-xs text-gray-500 truncate">
                                                    {u.email}
                                                  </p>
                                                )}
                                                {u.department && (
                                                  <p className="text-xs text-gray-400 truncate">
                                                    {u.department}
                                                  </p>
                                                )}
                                              </div>
                                            </div>
                                          </button>
                                        ))}
                                      </>
                                    )}
                                  </>
                                ) : (
                                  <div className="p-6 text-center">
                                    <Users className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                                    <p className="text-sm text-gray-500">No users or groups available</p>
                                  </div>
                                )}
                              </div>
                            ) : (ccResults.length === 0 && ccGroupResults.length === 0) ? (
                              <div className="p-6 text-center">
                                <Users className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                                <p className="text-sm text-gray-500">No users or groups found</p>
                              </div>
                            ) : (
                              <div className="py-1">
                                {/* Groups Section */}
                                {(ccTab === "all" || ccTab === "groups") && ccGroupResults.length > 0 && (
                                  <>
                                    <div className="px-4 py-2 text-xs text-gray-500 bg-gray-50 border-b border-gray-100">
                                      Groups
                                    </div>
                                    {ccGroupResults.map((g) => (
                                      <button
                                        key={`g-${g.id}`}
                                        type="button"
                                        onClick={() => addCcGroup(g)}
                                        className="w-full px-4 py-3 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-none transition-colors border-b border-gray-100 last:border-b-0"
                                      >
                                        <div className="space-y-2">
                                          {/* Group Name and Member Count */}
                                          <div className="flex items-start justify-between gap-2">
                                            <div className="flex items-center gap-3 flex-1">
                                              <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center text-emerald-700 text-xs font-bold flex-shrink-0">
                                                G
                                              </div>
                                              <div className="min-w-0 flex-1">
                                                <h4 className="text-sm font-medium text-gray-900 truncate">
                                                  {g.name}
                                                </h4>
                                              </div>
                                            </div>
                                            <div className="flex items-center gap-2 flex-shrink-0">
                                              <span className="text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded">
                                                {g.memberCount} members
                                              </span>
                                              <Plus className="w-4 h-4 text-emerald-600" />
                                            </div>
                                          </div>

                                          {/* Preview Members */}
                                          {g.previewMembers && g.previewMembers.length > 0 && (
                                            <div className="flex items-center gap-4 text-xs text-gray-500 ml-11">
                                              <div className="flex items-center gap-1">
                                                <Users className="w-3 h-3" />
                                                <span className="truncate">
                                                  {g.previewMembers.map((m) => m.name).join(", ")}
                                                  {g.memberCount > g.previewMembers.length ? " ..." : ""}
                                                </span>
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </button>
                                    ))}
                                  </>
                                )}

                                {/* Users Section */}
                                {(ccTab === "all" || ccTab === "users") && ccResults.length > 0 && (
                                  <>
                                    <div className="px-4 py-2 text-xs text-gray-500 bg-gray-50 border-b border-gray-100">
                                      Users
                                    </div>
                                    {ccResults.map((u) => (
                                      <button
                                        key={`u-${u.id}`}
                                        type="button"
                                        onClick={() => addCc(u)}
                                        className="w-full px-4 py-3 text-left hover:bg-gray-50 focus:bg-gray-50 focus:outline-none transition-colors border-b border-gray-100 last:border-b-0"
                                      >
                                        <div className="space-y-2">
                                          {/* User Name and Avatar */}
                                          <div className="flex items-start justify-between gap-2">
                                            <div className="flex items-center gap-3 flex-1">
                                              <Avatar
                                                url={u.profileImageUrl}
                                                name={u.name}
                                                lastname={u.lastname}
                                                email={u.email}
                                                size="sm"
                                                className="ring-1 ring-gray-200 flex-shrink-0"
                                              />
                                              <div className="min-w-0 flex-1">
                                                <h4 className="text-sm font-medium text-gray-900 truncate">
                                                  {formatCC(u)}
                                                </h4>
                                              </div>
                                            </div>
                                            <Plus className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                                          </div>

                                          {/* User Metadata */}
                                          <div className="flex items-center gap-4 text-xs text-gray-500 ml-11">
                                            <div className="flex items-center gap-1">
                                              <Mail className="w-3 h-3" />
                                              <span className="truncate">{u.email}</span>
                                            </div>
                                            {(u.team || u.department) && (
                                              <div className="flex items-center gap-1">
                                                <Building2 className="w-3 h-3" />
                                                <span className="truncate">
                                                  {[u.team, u.department].filter(Boolean).join(" - ")}
                                                </span>
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      </button>
                                    ))}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Backdrop */}
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setIsCcOpen(false)}
                        />
                      </>
                    )}
                  </div>
                </div>

                {/* Reference Memo Selector (moved from step 1) */}
                <div className="mt-4">
                  <ReferenceMemoSelector
                    selectedReferences={selectedReferences}
                    onReferencesChange={setSelectedReferences}
                    disabled={saving}
                  />
                </div>

                {/* Expiration Date-Time (moved from step 1) */}
                <label className="inline-block text-base font-semibold text-gray-700 mt-6 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                  {t("expiryLabel")}
                </label>
                <DateTimeInline
                  value={expiryAtLocal}
                  onChange={setExpiryAtLocal}
                  minNow
                />


                {/* ---------- Add Document Number Section ---------- */}
                <div className="mb-4 mt-6">
                  <label className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                    {t("titlememonumber")}
                  </label>
                  <div className="relative">
                    {/* ✅ ปุ่มวางหมายเลขเอกสาร */}
                    <button
                      type="button"
                      onClick={() =>
                        setPlacingFor({ type: "memonumber", approverIndex: -1 })
                      }
                      className={`mb-3 px-4 py-2 rounded-lg font-medium transition-all ${placingFor?.type === "memonumber"
                          ? "bg-[#183e33] text-white shadow-lg"
                          : "bg-white text-[#183e33] border-2 border-gray-300 hover:bg-gray-100 hover:text-[#183e33]"
                        }`}
                    >
                      {placingFor?.type === "memonumber"
                        ? t("clickaddmemonumber")
                        : t("addmemonumber")}
                    </button>
                  </div>
                </div>

                {/* ---------- Add Note/Comment Section ---------- */}
                <div className="mb-4 mt-6">
                  <label className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                    {t("noteText")}
                  </label>
                  <div className="relative">
                    {/* ✅ ปุ่มวางหมายเหตุ/คอมเมนต์ */}
                    <button
                      type="button"
                      onClick={() =>
                        setPlacingFor({ type: "note", approverIndex: -1 })
                      }
                      className={`mb-3 px-4 py-2 rounded-lg font-medium transition-all ${placingFor?.type === "note"
                          ? "bg-yellow-600 text-white shadow-lg"
                          : "bg-white text-yellow-600 border-2 border-gray-300 hover:bg-yellow-50 hover:text-yellow-700"
                        }`}
                    >
                      {placingFor?.type === "note"
                        ? t("clickToPlaceNote")
                        : t("btnAddNote")}
                    </button>
                  </div>
                </div>

                {/* ---------- เลือก Approval Line ---------- */}
                {/* Hidden: Approval line selection is now managed through memo type */}
                <div className="mb-4 mt-6 hidden">
                  <label className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                    {t("selectApproval")}
                  </label>
                  <div className="relative">
                    {/* <select
                      value={selectedApprovalLine?.id ?? ""}
                      onChange={handleApprovalLineChange}
                      className="w-full rounded-lg border border-gray-300 p-3 text-gray-700 focus:ring "
                    >
                      <option value="">{t("selectApprovalLine")}</option>
                      {approvalLines.map((line) => (
                        <option key={line.id} value={line.id}>
                          {line.name}
                        </option>
                      ))}
                    </select>  */}
                    {/* {selectedApprovalLine &&
                      memoTypeId &&
                      (() => {
                        const selectedType = memoTypes.find(
                          (type) => type.id === memoTypeId
                        );
                        return selectedType &&
                          (selectedType as any).approvalLineId ===
                            selectedApprovalLine.id ? (
                          <div className="mt-2 flex items-center gap-2 text-sm text-green-600">
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth="2"
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                            <span>
                              {t("autoSelectedFromDocType") ||
                                "Automatically selected from document type"}
                            </span>
                          </div>
                        ) : null;
                      })()} */}
                  </div>
                </div>

                <div className="mb-3 items-center justify-between hidden">
                  <div className="text-sm font-medium text-gray-700">
                    {t("special approval case") ?? "Approvers"}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setAddOpen((v) => !v);
                      // Clear any flexible slot selection when opening normally
                      if (!(window as any).selectingForFlexibleSlot) {
                        delete (window as any).selectingForFlexibleSlot;
                      }
                    }}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                  >
                    <UserPlus className="h-4 w-4" />
                    {t("addUsers") ?? "เพิ่มผู้อนุมัติ"}
                  </button>
                </div>
                {addOpen &&
                  createPortal(
                    <div
                      className="fixed inset-0 z-[9998] pointer-events-none"
                      role="dialog"
                      aria-modal="true"
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setAddOpen(false);
                      }}
                    >
                      {/* Backdrop */}
                      <div
                        className="absolute inset-0 bg-black/30 pointer-events-auto"
                        onClick={() => setAddOpen(false)}
                      />

                      {/* Panel */}
                      <div
                        className="absolute z-[9999] bg-white/95 backdrop-blur border border-gray-200 rounded-xl shadow-xl pointer-events-auto overflow-y-auto"
                        style={
                          {
                            // จัดวางใต้หัวการ์ด level ตาม anchorBox แต่กันหลุดจอ
                            top: Math.min(
                              anchorBox?.top ?? 100,
                              window.innerHeight - 360
                            ),
                            left: Math.min(
                              anchorBox?.left ?? 12,
                              Math.max(
                                12,
                                window.innerWidth -
                                (anchorBox?.width ??
                                  Math.min(window.innerWidth - 24, 520)) -
                                12
                              )
                            ),
                            width:
                              anchorBox?.width ??
                              Math.min(window.innerWidth - 24, 520),

                            // ให้ทั้ง panel เลื่อนแนวแกน Y ได้ (เลื่อนล้อเมาส์ที่หัวก็เลื่อน)
                            maxHeight: Math.min(window.innerHeight - 24, 520),

                            // ช่วยกรณีทัช/มือถือและกัน overscroll ทะลุไป body
                            WebkitOverflowScrolling: "touch",
                            overscrollBehavior: "contain",
                          } as React.CSSProperties
                        }
                      >
                        {/* แจ้งเตือน flexible slot */}
                        {(window as any).selectingForFlexibleSlot && (
                          <div className="px-3 py-2 bg-orange-50 border-b border-orange-200">
                            <div className="text-sm font-medium text-orange-800">
                              {t("selectingFlexibleTitle")}
                            </div>
                            <div className="text-xs text-orange-600 mt-0.5">
                              {t("selectingFlexibleHint")}
                            </div>
                          </div>
                        )}

                        {/* Search box */}
                        <div className="px-3 py-2 border-b bg-white sticky top-0">
                          <input
                            value={addQuery}
                            onChange={(e) => setAddQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && addSelected.length > 0) {
                                e.preventDefault();
                                handleAddApproversBulk();
                              }
                            }}
                            autoFocus
                            placeholder={
                              t("searchPlaceholder") ??
                              "พิมพ์ชื่อ/อีเมล อย่างน้อย 2 ตัวอักษร"
                            }
                            className="w-full rounded-xl border border-neutral-300 p-3 text-neutral-800 shadow-sm"
                          />
                        </div>

                        {/* Selected chips + actions */}
                        <div className="px-3 py-2 border-b bg-gray-50">
                          {addSelected.length > 0 && (
                            <>
                              <div className="text-xs text-gray-900 font-medium mb-1">
                                Selected ({addSelected.length})
                              </div>
                              <div className="flex flex-wrap gap-2 mb-2">
                                {addSelected.map((u) => (
                                  <span
                                    key={u.id}
                                    className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-white border border-gray-200 text-gray-900 text-xs"
                                  >
                                    {formatCC(u)}
                                    <button
                                      className="hover:text-red-600"
                                      onClick={() =>
                                        setAddSelected((prev) =>
                                          prev.filter((x) => x.id !== u.id)
                                        )
                                      }
                                    >
                                      ×
                                    </button>
                                  </span>
                                ))}
                              </div>
                            </>
                          )}

                          <div className="grid grid-cols-1 sm:grid-cols-2 items-center gap-2">
                            <div className="grid gap-2 min-w-0">
                              <button
                                type="button"
                                onClick={clearAddSelection}
                                className="h-8 w-full rounded-lg border border-neutral-300 text-xs font-medium text-neutral-800 bg-white hover:bg-gray-50 overflow-hidden text-ellipsis"
                              >
                                {t("Clear") ?? "Clear"}
                              </button>
                            </div>

                            <button
                              type="button"
                              onClick={handleAddApproversBulk}
                              disabled={addSelected.length === 0}
                              className={`h-8 w-full rounded-lg text-xs font-semibold text-white ${addSelected.length
                                  ? "bg-orange-600 hover:bg-orange-700 shadow-sm"
                                  : "bg-gray-300 cursor-not-allowed"
                                }`}
                            >
                              {(window as any).selectingForFlexibleSlot
                                ? t("selectUser") ?? "Select User"
                                : t("addSelected") ?? "Add Selected"}{" "}
                              ({addSelected.length})
                            </button>
                          </div>
                        </div>

                        {/* Results (ให้พื้นที่สูงขึ้นและเลื่อนเองได้ด้วย) */}
                        <div className="max-h-[60vh] overflow-y-auto">
                          {addLoading && (
                            <div className="px-3 py-6 text-sm text-gray-500 text-center">
                              {t("searching") ?? "กำลังค้นหา..."}
                            </div>
                          )}

                          {!addLoading && addQuery.trim().length < 2 && (
                            <div className="px-3 py-6 text-sm text-gray-500 text-center">
                              {t("minChars") ?? "พิมพ์อย่างน้อย 2 ตัวอักษร"}
                            </div>
                          )}

                          {!addLoading &&
                            addQuery.trim().length >= 2 &&
                            addResults.length === 0 && (
                              <div className="px-3 py-6 text-sm text-gray-500 text-center">
                                {t("notFound") ?? "ไม่พบผู้ใช้"}
                              </div>
                            )}

                          {!addLoading &&
                            addResults.map((u) => {
                              const avatarSrc = getAvatarSrc(
                                u.profileImageUrl,
                                u.id
                              );
                              const label = formatCC(u);
                              const checked = isAddSelected(u.id);
                              const flexibleSlotInfo = (window as any)
                                .selectingForFlexibleSlot;
                              // Allow same user at different levels - only block if user exists at the same level
                              // Also exclude flexible slots from the check (they have isFlexibleSlot=true or non-positive IDs)
                              const flexibleSlotLevel = flexibleSlotInfo 
                                ? approvers[flexibleSlotInfo.approverIndex]?.level 
                                : undefined;
                              const alreadyIn = approvers.some(
                                (a) =>
                                  !a.isFlexibleSlot &&
                                  typeof a.id === 'number' &&
                                  a.id > 0 &&
                                  a.id === u.id &&
                                  (!flexibleSlotInfo ||
                                    (a.id !== flexibleSlotInfo.approverId &&
                                     a.level === flexibleSlotLevel))
                              );

                              return (
                                <label
                                  key={u.id}
                                  className={`flex items-center gap-3 px-3 py-2 cursor-pointer border-b last:border-b-0 transition ${checked ? "bg-gray-50" : "hover:bg-gray-100"
                                    } ${alreadyIn
                                      ? "opacity-50 pointer-events-none"
                                      : ""
                                    }`}
                                  title={
                                    alreadyIn
                                      ? t("alreadyAdded") ?? "ถูกเพิ่มแล้ว"
                                      : ""
                                  }
                                  onClick={() => {
                                    if (alreadyIn) return;
                                    if (
                                      (window as any).selectingForFlexibleSlot
                                    ) {
                                      setAddSelected([u]);
                                    } else {
                                      toggleAddSelect(u);
                                    }
                                  }}
                                >
                                  <input
                                    type={
                                      (window as any).selectingForFlexibleSlot
                                        ? "radio"
                                        : "checkbox"
                                    }
                                    className="mt-0.5"
                                    checked={checked}
                                    readOnly
                                  />
                                  <Avatar
                                    url={u.profileImageUrl}
                                    name={u.name}
                                    lastname={u.lastname}
                                    email={u.email}
                                    size="sm"
                                    className="ring-1 ring-gray-200"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium text-gray-900">
                                      {label}
                                    </div>
                                    <div className="truncate text-xs text-gray-600">
                                      {u.email}
                                    </div>
                                    {(u.team || u.department) && (
                                      <div className="truncate text-[11px] text-gray-500">
                                        {u.team ?? ""}
                                        {u.team && u.department ? " • " : ""}
                                        {u.department ?? ""}
                                      </div>
                                    )}
                                  </div>
                                </label>
                              );
                            })}
                        </div>
                      </div>
                    </div>,
                    document.body
                  )}

                {/* ---------- รายการผู้อนุมัติ (การ์ดต่อ Level) ---------- */}
                
                {/* Approval Line Header */}
                <div className="mb-4">
                  <div className="inline-block text-base font-semibold text-gray-700 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                    {t("selectApproval", { defaultValue: "Approval Line" })}
                  </div>
                </div>
                
                {/* Helper functions for level management */}
                {(() => {
                  // Function to move entire level up or down
                  const moveLevelUpDown = (sourceLevelIdx: number, direction: 'up' | 'down') => {
                    const destLevelIdx = direction === 'up' ? sourceLevelIdx - 1 : sourceLevelIdx + 1;
                    
                    // Step 1: Build old index -> sigKey mapping BEFORE reordering
                    const oldIdxToSigKey = new Map<number, number>();
                    approvers.forEach((ap, idx) => {
                      oldIdxToSigKey.set(idx, sigKey(ap, idx));
                    });
                    
                    setApprovers(prev => {
                      // Group approvers by level from CURRENT state (prev)
                      const levelMap = new Map<number, Approver[]>();
                      prev.forEach(ap => {
                        const lv = typeof ap.level === "number" ? ap.level : 0;
                        if (!levelMap.has(lv)) levelMap.set(lv, []);
                        levelMap.get(lv)!.push(ap);
                      });
                      
                      // Get sorted levels
                      const sortedLevels = Array.from(levelMap.keys()).sort((a, b) => a - b);
                      
                      // Create array of level groups in current visual order
                      const currentGrouped = sortedLevels.map(level => ({
                        level,
                        approvers: levelMap.get(level)!
                      }));
                      
                      // Reorder the level groups
                      const reorderedLevels = [...currentGrouped];
                      const [movedLevel] = reorderedLevels.splice(sourceLevelIdx, 1);
                      reorderedLevels.splice(destLevelIdx, 0, movedLevel);
                      
                      // Rebuild approvers array with new level assignments
                      const newApprovers: Approver[] = [];
                      reorderedLevels.forEach((levelGroup, newLevelIdx) => {
                        levelGroup.approvers.forEach(ap => {
                          newApprovers.push({
                            ...ap,
                            level: newLevelIdx
                          });
                        });
                      });
                      
                      // Step 2: Build sigKey -> new index mapping AFTER reordering
                      const sigKeyToNewIdx = new Map<number, number>();
                      newApprovers.forEach((ap, newIdx) => {
                        sigKeyToNewIdx.set(sigKey(ap, newIdx), newIdx);
                      });
                      
                      // Step 3: Remap signature positions to new indices
                      setSigPositions(prevSig => {
                        const newSigPositions: Record<number, SignaturePosition[]> = {};
                        Object.entries(prevSig).forEach(([oldIdxStr, positions]) => {
                          const oldIdx = Number(oldIdxStr);
                          const oldKey = oldIdxToSigKey.get(oldIdx);
                          if (oldKey !== undefined) {
                            const newIdx = sigKeyToNewIdx.get(oldKey);
                            if (newIdx !== undefined) {
                              newSigPositions[newIdx] = positions.map(pos => ({
                                ...pos,
                                level: newApprovers[newIdx].level
                              }));
                            }
                          }
                        });
                        return newSigPositions;
                      });
                      
                      // Step 4: Remap date positions to new indices
                      setDatePositions(prevDate => {
                        const newDatePositions: Record<number, DatePosition[]> = {};
                        Object.entries(prevDate).forEach(([oldIdxStr, positions]) => {
                          const oldIdx = Number(oldIdxStr);
                          const oldKey = oldIdxToSigKey.get(oldIdx);
                          if (oldKey !== undefined) {
                            const newIdx = sigKeyToNewIdx.get(oldKey);
                            if (newIdx !== undefined) {
                              newDatePositions[newIdx] = positions.map(pos => ({
                                ...pos,
                                level: newApprovers[newIdx].level
                              }));
                            }
                          }
                        });
                        return newDatePositions;
                      });
                      
                      // Step 5: Remap applyToAllPagesPerApprover to new indices
                      setApplyToAllPagesPerApprover(prevApply => {
                        const newApply: Record<number, boolean> = {};
                        Object.entries(prevApply).forEach(([oldIdxStr, value]) => {
                          const oldIdx = Number(oldIdxStr);
                          const oldKey = oldIdxToSigKey.get(oldIdx);
                          if (oldKey !== undefined) {
                            const newIdx = sigKeyToNewIdx.get(oldKey);
                            if (newIdx !== undefined) {
                              newApply[newIdx] = value;
                            }
                          }
                        });
                        return newApply;
                      });
                      
                      // Step 6: Remap hideSigBtn to new sigKeys
                      setHideSigBtn(prevHide => {
                        const newHide: Record<number, boolean> = {};
                        Object.entries(prevHide).forEach(([oldKeyStr, value]) => {
                          const oldKey = Number(oldKeyStr);
                          const newIdx = sigKeyToNewIdx.get(oldKey);
                          if (newIdx !== undefined) {
                            const newKey = sigKey(newApprovers[newIdx], newIdx);
                            newHide[newKey] = value;
                          }
                        });
                        return newHide;
                      });
                      
                      return newApprovers;
                    });
                    
                    setCanSaveLine(true);
                  };
                  
                  // Function to insert a new level at a specific position
                  const insertLevelAt = (insertAtLevel: number) => {
                    // Generate a unique temporary ID for flexible slot
                    const existingIds = approvers.map(a => a.id);
                    const minExistingId = existingIds.length > 0 ? Math.min(...existingIds) : 0;
                    const tempId = Math.min(minExistingId - 1, -(Date.now() % 100000) - Math.floor(Math.random() * 1000));
                    
                    // Create a flexible slot approver for the new level
                    const flexibleApprover: Approver = {
                      id: tempId,
                      name: "Flexible",
                      lastname: "Slot",
                      nickname: null,
                      level: insertAtLevel,
                      isFlexibleSlot: true,
                      approvalRequirement: "ALL" as const,
                      role: "",
                      loaUserPivotId: tempId,
                      status: "pending",
                      isSigReq: true,
                      slotType: "FLEXIBLE_SLOT",
                      roleDescription: "",
                      displayName: "Flexible Slot",
                      templatePivotId: null,
                    };
                    
                    // Shift all levels at or after insertAtLevel up by 1
                    setApprovers(prev => {
                      const updated = prev.map(ap => {
                        if (ap.level >= insertAtLevel) {
                          return { ...ap, level: ap.level + 1 };
                        }
                        return ap;
                      });
                      return [...updated, flexibleApprover];
                    });
                    
                    setCanSaveLine(true);
                  };
                  
                  // Store functions in window for access in JSX
                  (window as any).__moveLevelUpDown = moveLevelUpDown;
                  (window as any).__insertLevelAt = insertLevelAt;
                  return null;
                })()}
                
                <div className="space-y-4">
                  {groupedApprovers.map((group, groupIdx) => {
                    const flexItem = group.items.find(
                      ({ ap }) => ap.isFlexibleSlot
                    );
                    const changedItem = !flexItem
                      ? group.items.find(({ ap }) => ap.wasFlexibleSlot)
                      : undefined;

                    // Define background colors for different levels
                    const levelColors = [
                      { bg: "bg-blue-50", border: "border-blue-200", dragBg: "bg-blue-100", dragBorder: "border-blue-500" },
                      { bg: "bg-green-50", border: "border-green-200", dragBg: "bg-green-100", dragBorder: "border-green-500" },
                      { bg: "bg-purple-50", border: "border-purple-200", dragBg: "bg-purple-100", dragBorder: "border-purple-500" },
                      { bg: "bg-orange-50", border: "border-orange-200", dragBg: "bg-orange-100", dragBorder: "border-orange-500" },
                      { bg: "bg-pink-50", border: "border-pink-200", dragBg: "bg-pink-100", dragBorder: "border-pink-500" },
                      { bg: "bg-indigo-50", border: "border-indigo-200", dragBg: "bg-indigo-100", dragBorder: "border-indigo-500" },
                    ];
                    const colorIndex = groupIdx % levelColors.length;
                    const levelColor = levelColors[colorIndex];

                    // Create a stable ID based on the level number and approvers in this level
                    // Include level to ensure uniqueness when same user appears at multiple levels
                    const stableId = `level-${group.level}-${group.items.map(({ ap }) => ap.id).sort().join('-')}` || `empty-${groupIdx}`;

                    return (
                      <React.Fragment key={stableId}>
                        {/* Insert Level Button - Show before each level except the first */}
                        {groupIdx > 0 && (
                          <div className="flex items-center justify-center py-2">
                            <button
                              type="button"
                              onClick={() => (window as any).__insertLevelAt(group.level)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-300 rounded-full hover:bg-emerald-100 transition-colors"
                              title={t("insertLevelHere", { defaultValue: "Insert new level here" })}
                            >
                              <Plus className="h-3 w-3" />
                              {t("insertLevel", { defaultValue: "Insert Level" })}
                            </button>
                          </div>
                        )}
                        
                      <div
                        className={`rounded-xl border shadow-sm ${levelColor.border} ${levelColor.bg}`}
                        data-role="level-card"
                      >
                        {/* ----- Header ของการ์ด Level ----- */}
                        <div
                          className="px-6 py-3 border-b border-gray-200"
                          data-role="level-header"
                        >
                          {/* First Row: Level Title and Move Up/Down Buttons */}
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-3">
                              {/* Move Level Up/Down Buttons */}
                              <div className="flex flex-col gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => (window as any).__moveLevelUpDown(groupIdx, 'up')}
                                  disabled={groupIdx === 0}
                                  className={`p-0.5 rounded transition-colors ${
                                    groupIdx === 0
                                      ? 'text-gray-300 cursor-not-allowed'
                                      : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900'
                                  }`}
                                  title={t("moveLevelUp", { defaultValue: "Move level up" })}
                                >
                                  <ChevronUp className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => (window as any).__moveLevelUpDown(groupIdx, 'down')}
                                  disabled={groupIdx === groupedApprovers.length - 1}
                                  className={`p-0.5 rounded transition-colors ${
                                    groupIdx === groupedApprovers.length - 1
                                      ? 'text-gray-300 cursor-not-allowed'
                                      : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900'
                                  }`}
                                  title={t("moveLevelDown", { defaultValue: "Move level down" })}
                                >
                                  <ChevronDown className="w-4 h-4" />
                                </button>
                              </div>
                              <div className="text-base font-semibold text-gray-900">
                                {t("level", { defaultValue: "Level" })}{" "}
                                {group.level + 1}
                              </div>
                            </div>
                            
                            {/* Level Management Controls - Empty */}
                            <div className="flex items-center gap-2">
                            </div>
                          </div>
                          
                          {/* Second Row: Approval Requirement Toggle (only show if multiple approvers) */}
                          {group.items.length > 1 && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-600 font-medium">
                                {t("approvalRequirement", { defaultValue: "Approval Requirement:" })}
                              </span>
                              <div className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setApprovers(prev => {
                                      const updated = prev.map(ap => {
                                        if (ap.level === group.level) {
                                          return { ...ap, approvalRequirement: "ALL" as const };
                                        }
                                        return ap;
                                      });
                                      
                                      return updated;
                                    });
                                    setCanSaveLine(true);
                                  }}
                                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                                    // Check if ALL approvers in this level have approvalRequirement !== "ANY" (i.e., they are "ALL" or undefined)
                                    group.items.every(item => (item.ap.approvalRequirement ?? "ALL") !== "ANY")
                                      ? "bg-green-600 text-white shadow-sm"
                                      : "text-gray-600 hover:bg-gray-100"
                                  }`}
                                >
                                  All Must Approve
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setApprovers(prev => {
                                      const updated = prev.map(ap => {
                                        if (ap.level === group.level) {
                                          return { ...ap, approvalRequirement: "ANY" as const };
                                        }
                                        return ap;
                                      });
                                      return updated;
                                    });
                                    setCanSaveLine(true);
                                  }}
                                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                                    // Check if ALL approvers in this level have approvalRequirement === "ANY"
                                    group.items.every(item => (item.ap.approvalRequirement ?? "ALL") === "ANY")
                                      ? "bg-orange-600 text-white shadow-sm"
                                      : "text-gray-600 hover:bg-gray-100"
                                  }`}
                                >
                                  Any One Can Approve
                                </button>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* ภายในการ์ด: รายการ Approver */}
                        <div className="p-4 space-y-4">
                          {group.items.map(({ ap, idx }, i) => {
                            const sigCount = sigPositions[idx]?.length ?? 0;
                            const dateCount = datePositions[idx]?.length ?? 0;
                            const total = sigCount + dateCount;
                            
                            // Debug: แสดงข้อมูล markers ทั้งหมดของ approver นี้
                            const allSigMarkers = sigPositions[idx] || [];
                            const sigByFile = allSigMarkers.reduce((acc, sig) => {
                              const key = `File ${sig.fileIdx + 1}, Page ${sig.pageInFile}`;
                              acc[key] = (acc[key] || 0) + 1;
                              return acc;
                            }, {} as Record<string, number>);
                            
                            const isUnassignedFlexible =
                              ap.isFlexibleSlot === true;
                            const isPlacingThis =
                              placingFor?.type === "both" &&
                              placingFor.approverIndex === idx;

                            return (
                                  <div
                                    key={`ap-${ap.id}-${ap.level}-${idx}`}
                                    className={`rounded border px-6 py-5 space-y-4 ${
                                      flashMissingIdxs.includes(idx)
                                        ? "border-red-500 ring-2 ring-red-300 animate-pulse bg-red-50"
                                        : "border-gray-300 bg-gray-50"
                                    }`}
                                    data-role="approver-card"
                                    data-approver-idx={idx}
                                  >
                                    {/* Top Controls Bar */}
                                    <div className="flex items-center justify-between gap-2 pb-3 border-b border-gray-200">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm text-gray-500">
                                          {t("level", { defaultValue: "Level" })} {group.level + 1}
                                        </span>
                                      </div>
                                      
                                      {/* Approver Management Controls - Remove Approver */}
                                      <div className="flex items-center gap-1">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            const approverName = ap.displayName || displayName(ap);
                                            if (confirm(`${t("removeApprover", { defaultValue: "Remove approver" })} ${approverName}?`)) {
                                              // Build mapping from old index to new index
                                              const oldToNewIndexMap = new Map<number, number>();
                                              let newIdx = 0;
                                              
                                              approvers.forEach((a, oldIdx) => {
                                                if (oldIdx !== idx) {
                                                  oldToNewIndexMap.set(oldIdx, newIdx);
                                                  newIdx++;
                                                }
                                              });
                                              
                                              // Remove this specific approver
                                              setApprovers(prev => {
                                                const filtered = prev.filter((_, i) => i !== idx);
                                                
                                                // Check if this was the last approver in the level
                                                const remainingInLevel = filtered.filter(a => a.level === ap.level);
                                                
                                                if (remainingInLevel.length === 0) {
                                                  // If no approvers left in this level, renumber all higher levels down
                                                  return filtered.map(a => {
                                                    if (a.level > ap.level) {
                                                      return { ...a, level: a.level - 1 };
                                                    }
                                                    return a;
                                                  });
                                                }
                                                
                                                return filtered;
                                              });
                                              
                                              // Reindex signature positions
                                              setSigPositions(prev => {
                                                const newPos: typeof prev = {};
                                                Object.entries(prev).forEach(([oldIdxStr, positions]) => {
                                                  const oldIdx = parseInt(oldIdxStr);
                                                  const newIdx = oldToNewIndexMap.get(oldIdx);
                                                  if (newIdx !== undefined) {
                                                    newPos[newIdx] = positions;
                                                  }
                                                });
                                                return newPos;
                                              });
                                              
                                              // Reindex date positions
                                              setDatePositions(prev => {
                                                const newPos: typeof prev = {};
                                                Object.entries(prev).forEach(([oldIdxStr, positions]) => {
                                                  const oldIdx = parseInt(oldIdxStr);
                                                  const newIdx = oldToNewIndexMap.get(oldIdx);
                                                  if (newIdx !== undefined) {
                                                    newPos[newIdx] = positions;
                                                  }
                                                });
                                                return newPos;
                                              });
                                              
                                              setCanSaveLine(true);
                                            }
                                          }}
                                          className="p-1.5 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                          title={t("removeApprover", { defaultValue: "Remove approver" })}
                                        >
                                          <X className="w-4 h-4" />
                                        </button>
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-[1fr] gap-x-4 gap-y-1 items-start">
                                  <div className="min-w-0">
                                    <p
                                      className={`text-base font-semibold leading-tight break-words ${ap.isFlexibleSlot
                                          ? "text-orange-600"
                                          : "text-gray-900"
                                        }`}
                                    >
                                      {ap.displayName ?? displayName(ap)}
                                    </p>
                                    <p className="mt-0.5 text-sm text-gray-600">
                                      {t("level", { defaultValue: "Level" })} {group.level + 1}
                                    </p>



                                    {/* Show delegation info only when approver is delegated */}
                                    {!ap.isFlexibleSlot && ap.isDelegated && ap.originalApproverId && (
                                      <div className="mt-2 p-3 bg-gradient-to-r from-amber-50 to-orange-50 border-l-4 border-amber-500 rounded-r-lg shadow-sm">
                                        <div className="flex items-start gap-2">
                                          <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                                            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                                          </svg>
                                          <div className="flex-1">
                                            <p className="text-sm font-semibold text-amber-900">
                                              🔄 {t("delegation.active", { defaultValue: "Delegation Active" })}
                                            </p>
                                            <p className="text-xs text-amber-800 mt-1">
                                              {t("delegation.actingOnBehalf", { defaultValue: "Acting on behalf of" })} <strong className="font-bold">{ap.originalApproverName}</strong>
                                            </p>
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>

                                  {/* Require signature */}
                                  <label className="col-start-1 mt-2 inline-flex items-center gap-3 select-none cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={isSigRequired(ap, idx)}
                                      onChange={() =>
                                        toggleSigRequired(ap, idx)
                                      }
                                      disabled={isUnassignedFlexible}
                                      title={
                                        isUnassignedFlexible
                                          ? t("selectUserFirst", {
                                            defaultValue:
                                              "Please select a user for the flexible slot approver first",
                                          })
                                          : undefined
                                      }
                                      className={`h-4 w-4 text-emerald-600 bg-gray-100 border-gray-300 rounded focus:ring-emerald-500 focus:ring-2 ${isUnassignedFlexible
                                          ? "opacity-50 cursor-not-allowed"
                                          : ""
                                        }`}
                                    />
                                    <span className="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
                                      <Signature
                                        className="h-4 w-4 text-emerald-600"
                                        aria-hidden="true"
                                      />
                                      <span>
                                        {t("withSignature", {
                                          defaultValue: "Require Signature",
                                        })}
                                      </span>
                                    </span>
                                  </label>
                                </div>

                                {/* ปุ่ม Add marker / สถานะ */}
                                <div className="flex flex-col items-center gap-3">
                                  {isUnassignedFlexible ? (
                                    <div className="flex flex-col items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          setAddOpen(true);

                                          // anchor = approver card
                                          const approverCard = (
                                            e.currentTarget as HTMLElement
                                          ).closest(
                                            '[data-role="approver-card"]'
                                          ) as HTMLElement | null;
                                          (window as any).__flexAnchorEl =
                                            approverCard ?? (e.currentTarget as HTMLElement);
                                          updateAnchorFromEl(
                                            approverCard ?? (e.currentTarget as HTMLElement)
                                          );

                                          // target index for this specific flexible slot
                                          (window as any).selectingForFlexibleSlot = {
                                            approverIndex: idx,
                                            approverId: ap.id,
                                          };
                                        }}
                                        className="px-4 py-2 text-sm font-medium rounded-md transition-colors text-orange-600 bg-orange-50 border border-orange-200 hover:bg-orange-100"
                                      >
                                        {t("selectUser", {
                                          defaultValue: "Select User",
                                        })}
                                      </button>

                                    </div>
                                  ) : isSigRequired(ap, idx) ? (
                                    <>
                                      {/* Checkbox for apply to all pages and Clear All button */}
                                      {totalPages > 1 && (
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <label className="inline-flex items-center gap-2 select-none cursor-pointer text-sm bg-blue-50 px-3 py-2 rounded-lg border border-blue-200 hover:bg-blue-100 transition-colors">
                                            <input
                                              type="checkbox"
                                              checked={applyToAllPagesPerApprover[idx] || false}
                                              onChange={(e) => handleApplyToAllPagesToggle(idx, e.target.checked)}
                                              className="h-4 w-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
                                            />
                                            <span className="text-gray-700 font-medium">
                                              {t("applyToAllPages", {
                                                defaultValue: "Apply to all pages",
                                              })}
                                            </span>
                                            <span className="text-xs text-gray-500">
                                              ({totalPages} {t("pages", { defaultValue: "pages" })})
                                            </span>
                                          </label>
                                          
                                          {/* Clear All button - only show if there are signatures */}
                                          {(sigCount > 0 || dateCount > 0) && (
                                            <button
                                              onClick={() => handleClearAllSignatures(idx)}
                                              className="inline-flex items-center gap-1 text-sm px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 transition-colors font-medium"
                                              title={t("clearAllSignatures", { defaultValue: "Clear all signatures" })}
                                            >
                                              <span>×</span>
                                              {t("clearAll", { defaultValue: "Clear All" })}
                                            </button>
                                          )}
                                        </div>
                                      )}
                                      
                                      <button
                                        onClick={() =>
                                          setPlacingFor((prev) =>
                                            // ถ้ากดซ้ำปุ่มเดิม ให้ปิดโหมดวาง (toggle off)
                                            prev?.type === "both" &&
                                              prev.approverIndex === idx
                                              ? null
                                              : {
                                                type: "both",
                                                approverIndex: idx,
                                              }
                                          )
                                        }
                                        className={`
    inline-flex items-center gap-1 rounded-lg px-5 py-2 text-sm font-medium text-white shadow
    transition-all duration-100
    ${isPlacingThis
                                            ? "bg-emerald-600 ring-2 ring-emerald-300 shadow-lg scale-[0.99]" // ✅ โหมดกำลังกด / ใช้งานอยู่
                                            : "bg-gray-700 hover:bg-gray-600 hover:shadow-lg active:bg-gray-800 active:scale-[0.98]" // ปกติ
                                          }
  `}
                                      >
                                        +{" "}
                                        {t("btnAddBoth", {
                                          defaultValue: "Add Signature & Date",
                                        })}
                                        {total > 0 && (
                                          <span className="ml-1 rounded-full bg-white/20 px-2 text-xs">
                                            {total}
                                        </span>
                                      )}
                                    </button>
                                    </>
                                  ) : (
                                    <span className="text-sm font-medium text-red-500">
                                      {t("waiting", {
                                        defaultValue: "Waiting",
                                      })}
                                    </span>
                                  )}
                                </div>

                                {/* สรุปจำนวน marker (ถ้าอยากโชว์เพิ่ม) */}
                                <div className="flex flex-col gap-1 text-xs text-gray-600">
                                  <div className="flex items-center gap-2 justify-center">
                                    <span>
                                      {t("signatures", {
                                        defaultValue: "Signatures",
                                      })}
                                    : {sigCount}
                                  </span>
                                  <span>•</span>
                                  <span>
                                    {t("dates", { defaultValue: "Dates" })}:{" "}
                                    {dateCount}
                                  </span>
                                  </div>
                                  
                                  {/* Debug: แสดงรายละเอียดตำแหน่งลายเซ็น */}
                                  {sigCount > 0 && (
                                    <div className="mt-1 text-[10px] text-gray-500 bg-gray-100 rounded px-2 py-1">
                                      <button
                                        type="button"
                                        onClick={() => setShowSignatureLocations(prev => ({
                                          ...prev,
                                          [idx]: !prev[idx]
                                        }))}
                                        className="w-full flex items-center justify-between font-semibold mb-0.5 hover:text-gray-700 transition-colors"
                                      >
                                        <span>📍 Signature Locations:</span>
                                        <svg 
                                          className={`w-3 h-3 transition-transform ${showSignatureLocations[idx] ? 'rotate-180' : ''}`}
                                          fill="none" 
                                          stroke="currentColor" 
                                          viewBox="0 0 24 24"
                                        >
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                        </svg>
                                      </button>
                                      {showSignatureLocations[idx] && (
                                        <div className="mt-1">
                                          {Object.entries(sigByFile).map(([location, count]) => {
                                            // Parse location to get file and page numbers
                                            const match = location.match(/File (\d+), Page (\d+)/);
                                            if (!match) return null;
                                            
                                            const fileIdx = parseInt(match[1]) - 1;
                                            const pageInFile = parseInt(match[2]);
                                            
                                            // Calculate global page number
                                            let globalPage = 0;
                                            for (let i = 0; i < fileIdx; i++) {
                                              globalPage += orderedPageCounts[i] || 0;
                                            }
                                            globalPage += pageInFile;
                                            
                                            const isCurrentPage = fileIdx === active.fileIdx && pageInFile === active.pageInFile;
                                            
                                            return (
                                              <button
                                                key={location}
                                                type="button"
                                                onClick={() => setCurrentPage(globalPage)}
                                                className={`ml-2 w-full text-left hover:bg-gray-200 px-1 rounded transition-colors ${
                                                  isCurrentPage ? 'bg-emerald-100 font-semibold text-emerald-700' : ''
                                                }`}
                                                title="Click to jump to this page"
                                              >
                                                • {location}: {count} marker{count > 1 ? 's' : ''} {isCurrentPage ? '← You are here' : ''}
                                              </button>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                                  </div>
                            );
                          })}
                        </div>
                      </div>
                      </React.Fragment>
                    );
                  })}
                  
                  {/* Insert Level Button at the end */}
                  <div className="flex items-center justify-center py-2">
                    <button
                      type="button"
                      onClick={() => {
                        const maxLevel = Math.max(...approvers.map(a => a.level || 0), -1);
                        (window as any).__insertLevelAt(maxLevel + 1);
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-300 rounded-full hover:bg-emerald-100 transition-colors"
                      title={t("insertLevelHere", { defaultValue: "Insert new level here" })}
                    >
                      <Plus className="h-3 w-3" />
                      {t("insertLevel", { defaultValue: "Insert Level" })}
                    </button>
                  </div>
                </div>

                {/* ---------- ปุ่มย้อนกลับ / บันทึก ---------- */}
                <div className="mt-6 flex space-x-4">
                  <button
                    onClick={() => setStep(1)}
                    className="flex-1 rounded-lg bg-gray-300 py-3 text-gray-700"
                  >
                    {t("back")}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving || hasUnassignedFlexible}
                    aria-busy={saving}
                    title={
                      hasUnassignedFlexible
                        ? t("selectUserFirst") ??
                        "Please select a user for the flexible slot approver first"
                        : undefined
                    }
                    className={`flex-1 rounded-lg py-3 text-white transition
    ${saving
                        ? "bg-gray-300 cursor-not-allowed"
                        : hasUnassignedFlexible
                          ? "bg-gray-300 cursor-not-allowed"
                          : "bg-[#183e33] hover:bg-[#142f28]"
                      }`}
                  >
                    {saving ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-4 w-4 inline-block rounded-full border-2 border-white border-t-transparent animate-spin" />
                        {t("saving") ?? "Saving..."}
                      </span>
                    ) : (
                      t("save")
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right panel: PDF preview — fills remaining space */}
        <div className="flex-1 min-w-0 flex flex-col pdf-viewer-sticky-container" ref={rightPanelRef}>
          <div ref={pdfContainerRef} className="relative flex-1 flex flex-col bg-white overflow-hidden">
            {orderedUrls.length > 0 ? (
              <>
                {/* Toolbar: page navigation + zoom controls */}
                <div className="flex flex-wrap items-center justify-between gap-3 px-2 sm:px-3 py-2 bg-[#f0f2f1] border-b border-gray-200 flex-shrink-0">
                  {/* Sidebar toggle */}
                  <button
                    onClick={() => setSidebarCollapsed((v) => !v)}
                    className="p-1.5 rounded hover:bg-gray-200 transition-colors"
                    title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                    aria-label="Toggle sidebar"
                  >
                    {sidebarCollapsed ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7M19 19l-7-7 7-7" /></svg>
                    )}
                  </button>

                  <div className="w-px h-5 bg-gray-300" />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage <= 1}
                      aria-label="Previous page"
                      className="disabled:opacity-40"
                    >
                      <AiFillCaretLeft />
                    </button>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="1"
                        max={totalPages}
                        value={currentPage}
                        onChange={(e) => {
                          const value = parseInt(e.target.value);
                          if (!isNaN(value) && value >= 1 && value <= totalPages) {
                            setCurrentPage(value);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const value = parseInt(e.currentTarget.value);
                            if (!isNaN(value)) {
                              const clampedValue = Math.max(1, Math.min(totalPages, value));
                              setCurrentPage(clampedValue);
                              e.currentTarget.value = clampedValue.toString();
                            }
                          }
                        }}
                        onBlur={(e) => {
                          const value = parseInt(e.target.value);
                          if (isNaN(value) || value < 1 || value > totalPages) {
                            e.target.value = currentPage.toString();
                          }
                        }}
                        className="w-12 px-1 py-0.5 text-center text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-[#183e33] focus:border-[#183e33]"
                      />
                      <span className="text-sm text-gray-600">of {totalPages}</span>
                    </div>
                    <button
                      onClick={() =>
                        setCurrentPage((p) => Math.min(totalPages, p + 1))
                      }
                      disabled={currentPage >= totalPages}
                      aria-label="Next page"
                      className="disabled:opacity-40"
                    >
                      <AiFillCaretRight />
                    </button>
                  </div>

                  {/* Zoom controls */}
                  <div className="flex items-center gap-1">
                    {zoomLevel !== 1 && (
                      <button
                        onClick={() => {
                          setZoomLevel(1);
                          if (scrollContainerRef.current) {
                            scrollContainerRef.current.scrollLeft = 0;
                            scrollContainerRef.current.scrollTop = 0;
                          }
                        }}
                        aria-label="Fit to width"
                        className="p-1 rounded hover:bg-gray-200 transition-colors ml-1"
                        title="Fit to width"
                      >
                        <Maximize size={16} />
                      </button>
                    )}
                    <button
                      onClick={() => setZoomLevel((prev) => nextZoomDown(prev))}
                      disabled={zoomLevel <= ZOOM_MIN}
                      aria-label="Zoom out"
                      className="p-1 rounded hover:bg-gray-200 disabled:opacity-40 transition-colors"
                      title="Zoom out (Ctrl+-)"
                    >
                      <Minus size={16} />
                    </button>
                    <button
                      onClick={() => {
                        setZoomLevel(1);
                        if (scrollContainerRef.current) {
                          scrollContainerRef.current.scrollLeft = 0;
                          scrollContainerRef.current.scrollTop = 0;
                        }
                      }}
                      className="px-2 py-0.5 text-xs font-medium rounded hover:bg-gray-200 transition-colors min-w-[3rem] text-center"
                      title="Reset zoom (Ctrl+0)"
                    >
                      {Math.round(zoomLevel * 100)}%
                    </button>
                    <button
                      onClick={() => setZoomLevel((prev) => nextZoomUp(prev))}
                      disabled={zoomLevel >= ZOOM_MAX}
                      aria-label="Zoom in"
                      className="p-1 rounded hover:bg-gray-200 disabled:opacity-40 transition-colors"
                      title="Zoom in (Ctrl++)"
                    >
                      <Plus size={16} />
                    </button>
                    
                  </div>
                </div>

                <div ref={measureRef} className="flex-1 min-h-0 p-2 sm:p-3 bg-[#e8eaed]">
                  <div
                    ref={scrollContainerRef}
                    className="overflow-auto relative h-full"
                    style={{ maxHeight: 'calc(100vh - 200px)' }}
                  >
                  <div
                    ref={pageRef}
                    className={`relative bg-white shadow-lg ${placingFor ? "cursor-crosshair" : ""
                      }`}
                    style={{
                      width: containerWidth > 0 ? containerWidth * zoomLevel : "100%",
                      margin: zoomLevel <= 1 ? "0 auto" : undefined,
                    }}
                    onClick={(e) => {
                      if (placingFor) onPlaceMarker(e, currentPage);
                    }}
                  >
                    {/* PDF */}
                    {(() => {
                      const file = orderedUrls[active.fileIdx];
                      if (!file) return <div>⛔ URL is undefined</div>;

                      return (
                        <Document
                          key={`doc-${active.fileIdx}-${file.url}`} // ไม่ผูกกับ containerWidth เพื่อลด re-mount
                          file={file.url}
                          loading={<div>{t("loadingPdf")}</div>}
                          onLoadError={(err) =>
                            console.error("PDF load error:", err)
                          }
                        >
                          {containerWidth > 0 && (
                            <Page
                              key={`page-${active.fileIdx}-${active.pageInFile}`} // คง key ให้เสถียร
                              pageNumber={active.pageInFile}
                              width={containerWidth}
                              scale={zoomLevel}
                              renderTextLayer={false}
                              renderAnnotationLayer={false}
                              onRenderSuccess={(page: any) => {
                                const key = `${active.fileIdx}-${active.pageInFile}`;
                                const widthPt = pageWidthPtMap[key] ?? page.originalWidth ?? 595.28;
                                if (pageRef.current) {
                                  pageRef.current.dataset.pageWidthPt = String(widthPt);
                                  const canvas = pageRef.current.querySelector("canvas");
                                  if (canvas) (canvas as HTMLElement).dataset.pageWidthPt = String(widthPt);
                                }
                              }}
                            />
                          )}
                        </Document>
                      );
                    })()}

                    {/* Signature markers */}
                    {Object.entries(sigPositions).flatMap(([idx, list]) =>
                      list.filter(isActivePos).map((p) => (
                        <Marker
                          kind="signature"
                          key={p.id}
                          canvasKey={`${p.fileIdx}-${p.pageInFile}-${zoomLevel}`}
                          pageRef={pageRef}
                          pos={p}
                          text={
                            approvers[+idx]?.displayName ??
                            displayName?.(approvers[+idx]) ??
                            t("unknownApprover")
                          }
                          pdfPt={16}
                          sizePct={p.sizePct ?? 100}
                          onChange={(np) => {
                            // Check if "Apply to all pages" is enabled for this approver
                            const isApplyToAll = applyToAllPagesPerApprover[+idx];
                            
                            setSigPositions((prev) => ({
                              ...prev,
                              [+idx]: prev[+idx].map((m) => {
                                // If "Apply to all pages" is enabled, update all markers with the same position
                                // Otherwise, only update the specific marker being moved
                                if (isApplyToAll) {
                                  return { ...m, ...np };
                                }
                                return m.id === p.id ? { ...m, ...np } : m;
                              }),
                            }));
                          }}
                          onDelete={() => {
                            setSigPositions((prev) => ({
                              ...prev,
                              [+idx]: prev[+idx].filter((m) => m.id !== p.id),
                            }));
                          }}
                          onResizeEnd={(newPct) => {
                            // Check if "Apply to all pages" is enabled for this approver
                            const isApplyToAll = applyToAllPagesPerApprover[+idx];
                            
                            setSigPositions((prev) => ({
                              ...prev,
                              [+idx]: prev[+idx].map((m) => {
                                // If "Apply to all pages" is enabled, update size for all markers
                                // Otherwise, only update the specific marker being resized
                                if (isApplyToAll) {
                                  return { ...m, sizePct: newPct };
                                }
                                return m.id === p.id ? { ...m, sizePct: newPct } : m;
                              }),
                            }));
                          }}
                        />
                      ))
                    )}

                    {/* Date markers */}
                    {Object.entries(datePositions).flatMap(([idx, list]) =>
                      list.filter(isActivePos).map((p) => (
                        <Marker
                          kind="date"
                          key={p.id}
                          canvasKey={`${p.fileIdx}-${p.pageInFile}-${zoomLevel}`}
                          pageRef={pageRef}
                          pos={p}
                          text="yyyy-mm-dd"
                          pdfPt={14}
                          sizePct={p.sizePct ?? 100}
                          onChange={(np) => {
                            // Check if "Apply to all pages" is enabled for this approver
                            const isApplyToAll = applyToAllPagesPerApprover[+idx];
                            
                            setDatePositions((prev) => ({
                              ...prev,
                              [+idx]: prev[+idx].map((m) => {
                                // If "Apply to all pages" is enabled, update all markers with the same position
                                // Otherwise, only update the specific marker being moved
                                if (isApplyToAll) {
                                  return { ...m, ...np };
                                }
                                return m.id === p.id ? { ...m, ...np } : m;
                              }),
                            }));
                          }}
                          onDelete={() => {
                            setDatePositions((prev) => ({
                              ...prev,
                              [+idx]: prev[+idx].filter((m) => m.id !== p.id),
                            }));
                          }}
                          onResizeEnd={(newPct) => {
                            // Check if "Apply to all pages" is enabled for this approver
                            const isApplyToAll = applyToAllPagesPerApprover[+idx];
                            
                            setDatePositions((prev) => ({
                              ...prev,
                              [+idx]: prev[+idx].map((m) => {
                                // If "Apply to all pages" is enabled, update size for all markers
                                // Otherwise, only update the specific marker being resized
                                if (isApplyToAll) {
                                  return { ...m, sizePct: newPct };
                                }
                                return m.id === p.id ? { ...m, sizePct: newPct } : m;
                              }),
                            }));
                          }}
                        />
                      ))
                    )}

                    {/* MemoNumber markers */}
                    {memoNumberPositions.filter(isActivePos).map((p) => (
                      <Marker
                        kind="memonumber"
                        key={p.id}
                        canvasKey={`${p.fileIdx}-${p.pageInFile}-${zoomLevel}`}
                        pageRef={pageRef}
                        pos={p}
                        text={memoNumber || "BU-DEP-TYPE-YY-MM-XXXX"}
                        pdfPt={14}
                        sizePct={p.sizePct ?? 100}
                        onChange={(np) => {
                          setMemoNumberPositions((prev) =>
                            prev.map((m) =>
                              m.id === p.id ? { ...m, ...np } : m
                            )
                          );
                        }}
                        onDelete={() => {
                          setMemoNumberPositions((prev) =>
                            prev.filter((m) => m.id !== p.id)
                          );
                        }}
                        onResizeEnd={(newPct) => {
                          setMemoNumberPositions((prev) =>
                            prev.map((m) =>
                              m.id === p.id ? { ...m, sizePct: newPct } : m
                            )
                          );
                        }}
                      />
                    ))}

                    {/* Note markers */}
                    {notePositions.filter(isActivePos).map((p) => (
                      <Marker
                        kind="note"
                        key={p.id}
                        canvasKey={`${p.fileIdx}-${p.pageInFile}-${zoomLevel}`}
                        pageRef={pageRef}
                        pos={p}
                        text={p.text}
                        pdfPt={12}
                        sizePct={p.sizePct ?? 100}
                        onChange={(np) => {
                          setNotePositions((prev) =>
                            prev.map((m) =>
                              m.id === p.id ? { ...m, ...np } : m
                            )
                          );
                        }}
                        onDelete={() => {
                          setNotePositions((prev) =>
                            prev.filter((m) => m.id !== p.id)
                          );
                        }}
                        onResizeEnd={(newPct) => {
                          setNotePositions((prev) =>
                            prev.map((m) =>
                              m.id === p.id ? { ...m, sizePct: newPct } : m
                            )
                          );
                        }}
                      />
                    ))}
                  </div>
                  </div>
                </div>

                {/* Bottom pagination control */}
                <div className="flex flex-wrap items-center justify-end gap-3 px-2 sm:px-3 py-2 bg-[#f0f2f1] border-t border-gray-200 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage <= 1}
                      aria-label="Previous page"
                      className="disabled:opacity-40"
                    >
                      <AiFillCaretLeft />
                    </button>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="1"
                        max={totalPages}
                        value={currentPage}
                        onChange={(e) => {
                          const value = parseInt(e.target.value);
                          if (!isNaN(value) && value >= 1 && value <= totalPages) {
                            setCurrentPage(value);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const value = parseInt(e.currentTarget.value);
                            if (!isNaN(value)) {
                              const clampedValue = Math.max(1, Math.min(totalPages, value));
                              setCurrentPage(clampedValue);
                              e.currentTarget.value = clampedValue.toString();
                            }
                          }
                        }}
                        onBlur={(e) => {
                          const value = parseInt(e.target.value);
                          if (isNaN(value) || value < 1 || value > totalPages) {
                            e.target.value = currentPage.toString();
                          }
                        }}
                        className="w-12 px-1 py-0.5 text-center text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-[#183e33] focus:border-[#183e33]"
                      />
                      <span className="text-sm text-gray-600">of {totalPages}</span>
                    </div>
                    <button
                      onClick={() =>
                        setCurrentPage((p) => Math.min(totalPages, p + 1))
                      }
                      disabled={currentPage >= totalPages}
                      aria-label="Next page"
                      className="disabled:opacity-40"
                    >
                      <AiFillCaretRight />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center min-h-[60vh]">
                <div className="text-center">
                  <svg className="mx-auto w-16 h-16 text-gray-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <p className="text-gray-400 text-sm">{t("pdfPlaceholder")}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {saving && (
        <div className="fixed inset-0 z-[9999] bg-white/60 backdrop-blur-sm flex items-center justify-center">
          <div className="flex flex-col items-center">
            <div className="h-10 w-10 rounded-full border-2 border-[#183e33] border-t-transparent animate-spin" />
            <p className="mt-3 text-sm text-[#183e33] font-medium">
              {t("saving") ?? "Saving..."}
            </p>
          </div>
        </div>
      )}
      {isPlacingSignatures && (
        <div className="fixed inset-0 z-[9999] bg-white/60 backdrop-blur-sm flex items-center justify-center">
          <div className="flex flex-col items-center">
            <div className="h-10 w-10 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
            <p className="mt-3 text-sm text-blue-600 font-medium">
              {t("placingSignatures") ?? "Placing signatures on all pages..."}
            </p>
          </div>
        </div>
      )}

      {/* URL Link Modal */}
      {showUrlModal &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            role="dialog"
            aria-modal="true"
            onKeyDown={(e) => {
              if (e.key === "Escape") handleCancelUrlModal();
            }}
          >
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              onClick={handleCancelUrlModal}
            />

            {/* Modal Content */}
            <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4 p-6 z-[10000]">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                {t("addUrlLink")}
              </h3>

              <div className="space-y-4">
                <div>
                  <label className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                    {t("urlLabel")}
                  </label>
                  <input
                    type="text"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder={t("urlPlaceholder")}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    autoFocus
                    onKeyPress={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddUrlLink();
                      }
                    }}
                  />
                </div>

                <div>
                  <label className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                    {t("urlTitleLabel")}
                  </label>
                  <input
                    type="text"
                    value={urlTitleInput}
                    onChange={(e) => setUrlTitleInput(e.target.value)}
                    placeholder={t("urlTitlePlaceholder")}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    onKeyPress={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddUrlLink();
                      }
                    }}
                  />
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleAddUrlLink}
                    className="flex-1 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors"
                  >
                    {t("saveUrlLink")}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelUrlModal}
                    className="px-4 py-2 bg-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-400 transition-colors"
                  >
                    {t("cancel")}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Note Input Modal */}
      {noteModalOpen && (
        <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">
                {t("addNoteTitle") ?? "Add Note/Comment"}
              </h3>
            </div>

            {/* Body */}
            <div className="px-6 py-4">
              <label className="inline-block text-base font-semibold text-gray-700 mb-2 px-3 py-1 bg-emerald-50 border-l-4 border-emerald-500 rounded-r">
                {t("noteText") ?? "Note Text"}
              </label>
              <textarea
                autoFocus
                value={noteModalText}
                onChange={(e) => setNoteModalText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    handleNoteModalSubmit();
                  } else if (e.key === "Escape") {
                    handleNoteModalCancel();
                  }
                }}
                placeholder={t("enterNoteText") ?? "Enter note text..."}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                rows={4}
              />
              <p className="mt-2 text-xs text-gray-500">
                {t("noteHint") ?? "Press Ctrl+Enter to save, Esc to cancel"}
              </p>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleNoteModalCancel}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                {t("cancel") ?? "Cancel"}
              </button>
              <button
                type="button"
                onClick={handleNoteModalSubmit}
                disabled={!noteModalText.trim()}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("add") ?? "Add"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MemoForm;
