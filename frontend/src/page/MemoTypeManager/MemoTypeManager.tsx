import React, { useState, useEffect, useCallback, useRef } from "react";
import axios from "axios";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPenToSquare,
  faTrash,
  faCopy,
  faEyeSlash,
  faClockRotateLeft,
} from "@fortawesome/free-solid-svg-icons";
import { useTranslation } from "react-i18next";
import { Listbox } from "@headlessui/react";
import {
  BiChevronDown,
  BiSolidChevronUp,
  BiSolidChevronDown,
} from "react-icons/bi";
import toast from "react-hot-toast";
import { FaTrashAlt } from "react-icons/fa";
import { FiEye } from "react-icons/fi";
import AsyncSelect from "react-select/async";
import PDFViewer from "../../components/PDFViewer";
import UnauthorizedAccess from "../../components/UnauthorizedAccess";
import AdminLogModal from "../../components/AdminLogModal";

// Type for manageable business units
interface ManageableBU {
  id: number;
  name: string;
  abbreviation?: string | null;
  isPrimary?: boolean;
}

// + NEW
type ApprovalSlotType =
  | "FIXED_USER"
  | "DEPARTMENT_HEAD"
  | "MEMO_REQUESTER"
  | "FLEXIBLE_SLOT";

type UserOption = {
  value: number;
  label: string;
  isSigReq?: boolean;
};

type FlexibleSlot = {
  slotType: ApprovalSlotType;
  roleDescription: string;
  isSigReq?: boolean;
};

// NEW: Unified approver item that can be either fixed user or flexible slot
type ApproverItem = {
  id: string; // unique identifier for React key
  type: "fixed" | "flexible";
  userId?: number; // for fixed users
  userLabel?: string; // display name for fixed users
  roleDescription: string;
  isSigReq: boolean;
};

type LevelForm = {
  name?: string;
  users: UserOption[];
  flexibleSlots: FlexibleSlot[];
  isFlexibleLevel?: boolean;
  approvalRequirement?: "ALL" | "ANY";
  // NEW: Unified approvers array (replaces separate users and flexibleSlots)
  approvers?: ApproverItem[];
};

type ApprovalLevelFromAPI = {
  level: number;
  users: {
    id: number;
    name: string;
    lastname?: string | null;
    nickname?: string | null;
    isSigReq?: boolean;
    slotType?: ApprovalSlotType;
    roleDescription?: string;
    approvalRequirement?: "ALL" | "ANY";
  }[];
};
interface MemoType {
  id: number;
  name: string;
  description: string;
  abbreviation: string;
  isActive: boolean;
  createdAt: string;
  approvalLevels?: ApprovalLevelFromAPI[];
  teamId?: number | null;
  team: {
    id: number;
    name: string;
    businessUnit?: { id: number; name: string };
  } | null;

  businessUnitId?: number | null; // ✅
  businessUnit?: { id: number; name: string } | null; // ✅

  defaultTypeFileId?: number | null; // ✅
  typeFiles?: {
    id: number;
    fileName: string;
    filePath: string;
    size: number;
    orderNo: number;
  }[];

  forEveryone?: boolean;
  forAllDepartmentUnderSelectedBu?: boolean;
  forEveryDepartmentAcrossBU?: boolean;
  departmentId?: number | null;
  department?: { id: number; name: string } | null;

  isDelete?: boolean; // ✅

  // Line of Approval information
  approvalLineId?: number | null;
  approvalLine?: {
    id: number;
    name: string;
  } | null;
}
interface UserSearchResult {
  id: number;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  email: string | null;
}

interface Department {
  id: number;
  name: string;
}
interface BusinessUnit {
  id: number;
  name: string;
}

interface MeRes {
  id: number;
  role?: string; // e.g. "admin" | "dcc" | "user"
  roles?: string[]; // e.g. ["user","dcc"]
  teamId?: number;
  team?: { id: number; name: string };
}

const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100, 0];

function makePageWindow(current: number, total: number, sibling = 1) {
  const totalNumbers = sibling * 2 + 5; // first, last, current, 2*siblings, 2 ellipses
  if (total <= totalNumbers)
    return Array.from({ length: total }, (_, i) => i + 1);

  const left = Math.max(2, current - sibling);
  const right = Math.min(total - 1, current + sibling);
  const showLeftDots = left > 2;
  const showRightDots = right < total - 1;

  const pages: (number | "...")[] = [1];
  if (showLeftDots) pages.push("...");
  for (let i = left; i <= right; i++) pages.push(i);
  if (showRightDots) pages.push("...");
  pages.push(total);
  return pages;
}

// ---- date utils ----
// ถ้าเวลาที่เก็บใน DB เป็น UTC ให้ true (ถ้าเป็นเวลาโลคอลของไทยให้ false)
const DB_IS_UTC = true;

function parseDbDate(input: string | number | Date): Date {
  if (input instanceof Date) return input;
  if (typeof input === "number") return new Date(input);
  const s = String(input ?? "").trim();

  // รองรับ "YYYY-MM-DD HH:mm:ss.SSS"
  if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s)) {
    const isoish = s.replace(" ", "T");
    return new Date(DB_IS_UTC ? `${isoish}Z` : isoish);
  }
  // เผื่อกรณีได้ ISO ตรง ๆ
  return new Date(s);
}

// ฟอร์แมต ค.ศ. (calendar gregory, ตัวเลขอารบิก) โซนเวลาไทย
export const fmtAD = new Intl.DateTimeFormat("th-TH-u-ca-gregory-nu-latn", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Asia/Bangkok",
});

// Helper function to get user-friendly display text for slot types
const getSlotTypeDisplay = (slotType: string | null | undefined): { text: string; badgeClass: string } => {
  switch (slotType) {
    case "FIXED_USER":
      return { text: "Fixed User", badgeClass: "bg-blue-100 text-blue-800 border-blue-200" };
    case "FLEXIBLE_SLOT":
      return { text: "Flexible Slot", badgeClass: "bg-orange-100 text-orange-800 border-orange-200" };
    default:
      return { text: "Unassigned", badgeClass: "bg-gray-100 text-gray-600 border-gray-200" };
  }
};

const SortIcon = ({ active, asc }: { active: boolean; asc: boolean }) =>
  active ? (
    asc ? (
      <BiSolidChevronUp />
    ) : (
      <BiSolidChevronDown />
    )
  ) : (
    <BiChevronDown className="opacity-40" />
  );

// Helper function to format file size
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

const hasRole = (me: MeRes | null, target: string) =>
  (me?.role ?? "").toUpperCase() === target ||
  (me?.roles ?? []).some((r) => (r ?? "").toUpperCase() === target);

const isAdminOrDcc = (me: MeRes | null) =>
  hasRole(me, "ADMIN") || hasRole(me, "DCC");
const MemoTypeManager: React.FC = () => {
  const { t } = useTranslation("memoTypeManager");

  /* ───────── state ───────── */
  const [types, setTypes] = useState<MemoType[]>([]);
  const [editedMemoTypeIds, setEditedMemoTypeIds] = useState<Set<number>>(new Set());
  const [activeTab, setActiveTab] = useState<"active" | "hidden">("active"); // + NEW: Tab State
  const [me, setMe] = useState<MeRes | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [activeCount, setActiveCount] = useState<number>(0);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [files, setFiles] = useState<File[]>([]); // ไฟล์ใหม่ที่จะอัปโหลด
  const [existingFiles, setExistingFiles] = useState<MemoType["typeFiles"]>([]); // ไฟล์เดิมของ type
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // filter / sort / paginate
  const [searchTerm, setSearchTerm] = useState("");
  const [businessUnits, setBusinessUnits] = useState<BusinessUnit[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [currentPage, setCurrentPage] = useState(1);
  const [defaultChoice, setDefaultChoice] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<
    "id" | "name" | "abbreviation" | "businessUnit" | "department" | "createdAt" | "isActive" | "isDelete"
  >("name");

  const [sortAsc, setSortAsc] = useState(true);
  const canManage = isAdminOrDcc(me);
  const [blocked, setBlocked] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = React.useRef(false);
  const [showLogModal, setShowLogModal] = useState(false);

  // PDF Viewer state
  const [pdfViewerState, setPdfViewerState] = React.useState({
    isOpen: false,
    fileUrl: '',
    fileName: ''
  });

  // Excel-style Column Filter & Sort states
  type ColumnKey = "name" | "abbreviation" | "businessUnit" | "department" | "status" | "approvers";
  const [columnFilters, setColumnFilters] = useState<Record<ColumnKey, string>>({
    name: "",
    abbreviation: "",
    businessUnit: "",
    department: "",
    status: "all", // Default to show all statuses
    approvers: "",
  });
  const [sortColumn, setSortColumn] = useState<ColumnKey | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [openFilterDropdown, setOpenFilterDropdown] = useState<ColumnKey | null>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

  // Approver Filter states
  const [approverSearchTerm, setApproverSearchTerm] = useState("");
  const [approverSearchResults, setApproverSearchResults] = useState<UserSearchResult[]>([]);
  const [isSearchingApprover, setIsSearchingApprover] = useState(false);
  const [showApproverDropdown, setShowApproverDropdown] = useState(false);
  const [selectedApprover, setSelectedApprover] = useState<{ id: number; name: string } | null>(null);
  const approverSearchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const approverSearchInputRef = useRef<HTMLDivElement>(null);

  // Approval lines data for filtering
  const [approvalLines, setApprovalLines] = useState<any[]>([]);
  const [loadingApprovalLines, setLoadingApprovalLines] = useState(false);

  // DCC Multi-Business Unit Management
  const [manageableBusinessUnits, setManageableBusinessUnits] = useState<ManageableBU[]>([]);
  const [selectedBusinessUnitId, setSelectedBusinessUnitId] = useState<number | "all">("all");

  // Dynamic Business Unit Filter (shows only BUs present in current data) - Multi-select
  const [dynamicBUFilterIds, setDynamicBUFilterIds] = useState<number[]>([]);
  const [isBUDropdownOpen, setIsBUDropdownOpen] = useState(false);
  const buDropdownRef = useRef<HTMLDivElement>(null);
  
  // Department Filter state - Multi-select
  const [dynamicDeptFilterIds, setDynamicDeptFilterIds] = useState<number[]>([]);
  const [isDeptDropdownOpen, setIsDeptDropdownOpen] = useState(false);
  const deptDropdownRef = useRef<HTMLDivElement>(null);

  // Reset department filter when BU filter changes
  useEffect(() => {
    if (dynamicBUFilterIds.length > 0) {
      setDynamicDeptFilterIds([]);
    }
  }, [dynamicBUFilterIds]);

  // Close BU and Dept dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (buDropdownRef.current && !buDropdownRef.current.contains(event.target as Node)) {
        setIsBUDropdownOpen(false);
      }
      if (deptDropdownRef.current && !deptDropdownRef.current.contains(event.target as Node)) {
        setIsDeptDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close filter dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(event.target as Node)) {
        setOpenFilterDropdown(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close approver search dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (approverSearchInputRef.current && !approverSearchInputRef.current.contains(event.target as Node)) {
        setShowApproverDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Load approval lines data on component mount
  useEffect(() => {
    const fetchApprovalLines = async () => {
      try {
        setLoadingApprovalLines(true);
        const { data } = await axios.get("/api/approval-lines", {
          withCredentials: true,
        });
        setApprovalLines(data);
      } catch (error) {
        console.error("Error fetching approval lines:", error);
        setApprovalLines([]);
      } finally {
        setLoadingApprovalLines(false);
      }
    };

    fetchApprovalLines();
  }, []);

  // Refetch types when selected business unit changes (for DCC users)
  useEffect(() => {
    if (ready && manageableBusinessUnits.length > 1) {
      fetchTypes(selectedBusinessUnitId);
    }
  }, [selectedBusinessUnitId, ready, manageableBusinessUnits.length]);

  const handleSort = (column: ColumnKey, direction: "asc" | "desc") => {
    setSortColumn(column);
    setSortDirection(direction);
    setOpenFilterDropdown(null);
    // Also trigger the existing sort handler
    // Map 'status' to 'isActive' for the comparator
    const mappedKey = column === "status" ? "isActive" : column;
    setSortKey(mappedKey as any);
    setSortAsc(direction === "asc");
    setCurrentPage(1);
  };

  const clearSort = () => {
    setSortColumn(null);
    setSortDirection("asc");
    setOpenFilterDropdown(null);
  };

  const handleColumnFilterChange = (column: ColumnKey, value: string) => {
    setColumnFilters((prev) => ({ ...prev, [column]: value }));
  };

  const clearColumnFilter = (column: ColumnKey) => {
    setColumnFilters((prev) => ({ 
      ...prev, 
      [column]: column === "status" ? "all" : "" 
    }));
    setOpenFilterDropdown(null);
  };

  const clearAllFilters = () => {
    setColumnFilters({
      name: "",
      abbreviation: "",
      businessUnit: "",
      department: "",
      status: "all",
      approvers: "",
    });
    setSortColumn(null);
    setSortDirection("asc");
    // Clear approver filter
    setSelectedApprover(null);
    setApproverSearchTerm("");
    setApproverSearchResults([]);
    // Clear BU and Dept filters
    setDynamicBUFilterIds([]);
    setDynamicDeptFilterIds([]);
  };

  const hasActiveFilters = Object.entries(columnFilters).some(([key, value]) => {
    if (key === "status") return value !== "all";
    return value !== "";
  }) || sortColumn !== null || selectedApprover !== null || dynamicBUFilterIds.length > 0 || dynamicDeptFilterIds.length > 0;

  // Search for approvers to filter memo types
  const searchApproverToFilter = useCallback(async (query: string) => {
    if (!query.trim()) {
      setApproverSearchResults([]);
      return;
    }

    try {
      setIsSearchingApprover(true);
      const { data } = await axios.get<UserSearchResult[]>("/api/users/search", {
        params: { q: query, limit: 10 },
        withCredentials: true,
      });
      setApproverSearchResults(data);
    } catch (error) {
      console.error("Error searching approvers:", error);
      setApproverSearchResults([]);
    } finally {
      setIsSearchingApprover(false);
    }
  }, []);

  const handleApproverSearchChange = (query: string) => {
    setApproverSearchTerm(query);
    setShowApproverDropdown(true);

    if (approverSearchTimeoutRef.current) {
      clearTimeout(approverSearchTimeoutRef.current);
    }

    approverSearchTimeoutRef.current = setTimeout(() => {
      searchApproverToFilter(query);
    }, 300);
  };

  const selectApproverToFilter = (user: UserSearchResult) => {
    const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "Unknown";
    setSelectedApprover({ id: user.id, name: displayName });
    setApproverSearchTerm(displayName);
    setShowApproverDropdown(false);
    setApproverSearchResults([]);
  };

  const clearApproverFilter = () => {
    setSelectedApprover(null);
    setApproverSearchTerm("");
    setApproverSearchResults([]);
  };

  const handleToggleHidden = async (item: MemoType) => {
    // If trying to delete (current status is NOT deleted), must check if it is inactive first
    if (!item.isDelete && item.isActive) {
      toast.error("Cannot delete active memo type. Please deactivate it first.");
      return;
    }

    try {
      const newHiddenStatus = !item.isDelete;
      // Send only required fields to prevent validation errors in backend
      // Specifically avoiding approvalLevels which triggers checking logic
      const payload: any = {
        name: item.name,
        description: item.description,
        abbreviation: item.abbreviation,
        isActive: item.isActive,
        isDelete: newHiddenStatus, // Changed from isHidden to isDelete based on recent context
        forEveryone: item.forEveryone,
        forEveryDepartmentAcrossBU: item.forEveryDepartmentAcrossBU,
        forAllDepartmentUnderSelectedBu: item.forAllDepartmentUnderSelectedBu
      };

      // Only include these fields if they have values, otherwise let backend handle them (or send undefined)
      // But for businessUnitId and departmentId, if they exist in item, send them to satisfy "required" checks for certain modes
      if (item.businessUnitId) payload.businessUnitId = item.businessUnitId;
      if (item.departmentId) payload.departmentId = item.departmentId;

      await axios.put(`/api/memotypes/${item.id}`, payload, { withCredentials: true });
      
      // Update local state
      setTypes(prev => prev.map(t => 
        t.id === item.id ? { ...t, isDelete: newHiddenStatus } : t
      ));
      
      toast.success(newHiddenStatus ? "Memo type deleted" : "Memo type restored");
    } catch (error: any) {
      console.error("Failed to toggle delete status:", error);
      toast.error(error?.response?.data?.error || "Failed to update status");
    }
  };

  // ตัวช่วย: collator ภาษาไทย + ตัวเลข
  const collator = React.useMemo(
    () => new Intl.Collator("th-TH", { numeric: true, sensitivity: "base" }),
    []
  );

  // ตัวช่วย: เปรียบเทียบค่าที่เป็น string โดยรองรับ null/undefined
  const cmpStr = (a?: string | null, b?: string | null) => {
    if (!a && !b) return 0;
    if (!a) return 1; // null/ว่าง ไปท้าย
    if (!b) return -1;
    return collator.compare(a, b);
  };
  // แปลง "/uploads/types/xxx.xlsx" -> "/api/secure-uploads/uploads/types/xxx.xlsx"
  const toSecure = (p: string) =>
    `/api/secure-uploads/${encodeURI(String(p).replace(/^\/+/, ""))}`;

  // Check if file is PDF
  const isPdfFile = (fileName: string) => {
    return fileName.toLowerCase().endsWith('.pdf');
  };

  // Handle PDF preview
  const handlePreviewPdf = (file: any) => {
    const fileUrl = toSecure(file.filePath);
    setPdfViewerState({
      isOpen: true,
      fileUrl,
      fileName: file.fileName
    });
  };

  // Close PDF viewer
  const closePdfViewer = () => {
    setPdfViewerState({
      isOpen: false,
      fileUrl: '',
      fileName: ''
    });
  };
  // ตัวช่วย: comparator หลัก
  const comparator = React.useCallback(
    (a: MemoType, b: MemoType) => {
      let res = 0;
      switch (sortKey) {
        case "id":
          res = a.id - b.id;
          break;
        case "name":
          res = cmpStr(a.name, b.name);
          break;
        case "abbreviation":
          res = cmpStr(a.abbreviation, b.abbreviation);
          break;
        case "businessUnit":
          res = cmpStr(a.businessUnit?.name ?? null, b.businessUnit?.name ?? null);
          break;
        case "department":
          res = cmpStr(a.department?.name ?? null, b.department?.name ?? null);
          break;
        case "isDelete":
          res = (a.isDelete === b.isDelete) ? 0 : a.isDelete ? -1 : 1;
          break;
        case "createdAt":
          res =
            parseDbDate(a.createdAt).getTime() -
            parseDbDate(b.createdAt).getTime();
          break;
        case "isActive":
          // ให้ Active = 0, Inactive = 1
          // Ascending (0 -> 1): Active -> Inactive (Sort Active First)
          // Descending (1 -> 0): Inactive -> Active (Sort Inactive First)
          const scoreA = a.isActive ? 0 : 1;
          const scoreB = b.isActive ? 0 : 1;
          res = scoreA - scoreB;
          break;
      }
      return sortAsc ? res : -res;
    },
    [sortKey, sortAsc, collator]
  );

  const [modalMode, setModalMode] = useState<
    "create" | "edit" | "duplicate" | null
  >(null);
  const isEditMode = modalMode === "edit";
  const [form, setForm] = useState<
    Omit<MemoType, "id" | "createdAt" | "team"> & {
      id?: number;
      originalId?: number; // For duplicate mode
      forEveryone?: boolean;
      forAllDepartmentUnderSelectedBu?: boolean;
      forEveryDepartmentAcrossBU?: boolean;
    }
  >({
    name: "",
    description: "",
    abbreviation: "",
    isActive: true,
    isDelete: false, // ✅
    businessUnitId: undefined, // ✅
    defaultTypeFileId: null, // ✅
    forEveryone: false,
    forAllDepartmentUnderSelectedBu: true, // Default to true as per requirement
    forEveryDepartmentAcrossBU: false,
    departmentId: undefined,
  });
  const [approvalLevels, setApprovalLevels] = useState<LevelForm[]>([]);
  
  // Helper to generate unique ID for approvers
  const generateApproverId = () => `approver-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // + NEW: เพิ่ม/ลบ level - Updated to use unified approvers array
  const addLevel = () =>
    setApprovalLevels((p) => [
      ...p,
      { name: "", users: [], flexibleSlots: [], approvers: [], approvalRequirement: "ALL" },
    ]);

  // Insert a new level at a specific index (for inserting between existing levels)
  const insertLevelAt = (insertIdx: number) =>
    setApprovalLevels((p) => {
      const newLevel: LevelForm = { name: "", users: [], flexibleSlots: [], approvers: [], approvalRequirement: "ALL" };
      const copy = [...p];
      copy.splice(insertIdx, 0, newLevel);
      return copy;
    });

  const removeLevel = (idx: number) =>
    setApprovalLevels((p) => p.filter((_, i) => i !== idx));

  // NEW: Add a fixed user approver to a level
  const addFixedApprover = (levelIdx: number) => {
    setApprovalLevels((prev) => {
      const copy = [...prev];
      const newApprover: ApproverItem = {
        id: generateApproverId(),
        type: "fixed",
        roleDescription: "",
        isSigReq: true,
      };
      copy[levelIdx] = {
        ...copy[levelIdx],
        approvers: [...(copy[levelIdx].approvers || []), newApprover],
      };
      return copy;
    });
  };

  // NEW: Add a flexible slot approver to a level
  const addFlexibleApprover = (levelIdx: number) => {
    setApprovalLevels((prev) => {
      const copy = [...prev];
      const newApprover: ApproverItem = {
        id: generateApproverId(),
        type: "flexible",
        roleDescription: "",
        isSigReq: true,
      };
      copy[levelIdx] = {
        ...copy[levelIdx],
        approvers: [...(copy[levelIdx].approvers || []), newApprover],
      };
      return copy;
    });
  };

  // NEW: Remove an approver from a level
  const removeApprover = (levelIdx: number, approverId: string) => {
    setApprovalLevels((prev) => {
      const copy = [...prev];
      copy[levelIdx] = {
        ...copy[levelIdx],
        approvers: (copy[levelIdx].approvers || []).filter((a) => a.id !== approverId),
      };
      return copy;
    });
  };

  // NEW: Update an approver in a level
  const updateApprover = (levelIdx: number, approverId: string, updates: Partial<ApproverItem>) => {
    setApprovalLevels((prev) => {
      const copy = [...prev];
      copy[levelIdx] = {
        ...copy[levelIdx],
        approvers: (copy[levelIdx].approvers || []).map((a) =>
          a.id === approverId ? { ...a, ...updates } : a
        ),
      };
      return copy;
    });
  };

  // NEW: Get excluded user IDs for a level (to prevent duplicates in same level)
  const getExcludedUserIdsForApprover = (levelIdx: number, currentApproverId: string) => {
    const approvers = approvalLevels[levelIdx]?.approvers || [];
    return approvers
      .filter((a) => a.type === "fixed" && a.userId && a.id !== currentApproverId)
      .map((a) => a.userId!);
  };

  // NEW: Load options for approver user selector
  const makeLoadOptionsForApprover = (levelIdx: number, approverId: string) => async (inputValue: string) => {
    try {
      const exclude = getExcludedUserIdsForApprover(levelIdx, approverId);
      const { data } = await axios.get("/api/users/search", {
        withCredentials: true,
        params: { q: inputValue || "", limit: 20, exclude: exclude.join(",") },
      });
      return (
        data as Array<{
          id: number;
          name: string;
          lastname?: string | null;
          nickname?: string | null;
        }>
      ).map((u) => {
        const fullName = [u.name, u.lastname].filter(Boolean).join(" ");
        return {
          value: u.id,
          label: u.nickname ? `${fullName} (${u.nickname})` : fullName,
        };
      });
    } catch {
      return [];
    }
  };

  // LEGACY: Keep old functions for backward compatibility
  const toggleFlexibleLevel = (levelIdx: number, isFlexible: boolean) => {
    setApprovalLevels((prev) => {
      const copy = [...prev];
      copy[levelIdx] = {
        ...copy[levelIdx],
        isFlexibleLevel: isFlexible,
        // Clear users if switching to flexible, clear flexible slots if switching to fixed
        users: isFlexible ? [] : copy[levelIdx].users,
        flexibleSlots: isFlexible
          ? copy[levelIdx].flexibleSlots.length > 0
            ? copy[levelIdx].flexibleSlots
            : [
              {
                slotType: "FLEXIBLE_SLOT" as ApprovalSlotType,
                roleDescription: "",
                isSigReq: true,
              },
            ]
          : [],
      };
      return copy;
    });
  };

  // LEGACY: Add a new flexible slot to a level
  const addFlexibleSlot = (levelIdx: number) => {
    setApprovalLevels((prev) => {
      const copy = [...prev];
      copy[levelIdx] = {
        ...copy[levelIdx],
        flexibleSlots: [
          ...copy[levelIdx].flexibleSlots,
          {
            slotType: "FLEXIBLE_SLOT" as ApprovalSlotType,
            roleDescription: "",
            isSigReq: true,
          },
        ],
      };
      return copy;
    });
  };

  // LEGACY: Remove a flexible slot from a level
  const removeFlexibleSlot = (levelIdx: number, slotIdx: number) => {
    setApprovalLevels((prev) => {
      const copy = [...prev];
      const newSlots = copy[levelIdx].flexibleSlots.filter((_, i) => i !== slotIdx);
      // Ensure at least one slot remains
      if (newSlots.length === 0) {
        newSlots.push({
          slotType: "FLEXIBLE_SLOT" as ApprovalSlotType,
          roleDescription: "",
          isSigReq: true,
        });
      }
      copy[levelIdx] = {
        ...copy[levelIdx],
        flexibleSlots: newSlots,
      };
      return copy;
    });
  };

  // LEGACY: Update a specific flexible slot
  const updateFlexibleSlot = (levelIdx: number, slotIdx: number, updates: Partial<FlexibleSlot>) => {
    setApprovalLevels((prev) => {
      const copy = [...prev];
      copy[levelIdx] = {
        ...copy[levelIdx],
        flexibleSlots: copy[levelIdx].flexibleSlots.map((slot, i) =>
          i === slotIdx ? { ...slot, ...updates } : slot
        ),
      };
      return copy;
    });
  };

  const isAllowedFile = (file: File) => {
    // อนุญาตรูปภาพทุกรูปแบบ
    if (file.type?.startsWith("image/")) return true;

    // อนุญาต Excel/CSV/ODS + Word + PDF
    const allowedExts = ["xlsx", "xls", "csv", "ods", "doc", "docx", "pdf"];
    const allowedMimes = [
      "application/msword", // .doc
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/pdf", // .pdf
    ];

    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (allowedExts.includes(ext)) return true;
    if (file.type && allowedMimes.includes(file.type)) return true;

    return false; // ชนิดอื่นๆ ที่ไม่อนุญาต
  };

  // + NEW: id ที่ถูกเลือกใน level เดียวกัน เพื่อตัดออกตอนค้นหา (อนุญาตให้ user ซ้ำข้าม level ได้)
  const getExcludedIds = (lvIdx: number) =>
    approvalLevels[lvIdx]?.users.map((u) => u.value) ?? [];

  // + NEW: โหลด user สำหรับ AsyncSelect
  const makeLoadOptions = (lvIdx: number) => async (inputValue: string) => {
    try {
      const exclude = getExcludedIds(lvIdx);
      const { data } = await axios.get("/api/users/search", {
        withCredentials: true,
        params: { q: inputValue || "", limit: 20, exclude: exclude.join(",") },
      });
      return (
        data as Array<{
          id: number;
          name: string;
          lastname?: string | null;
          nickname?: string | null;
        }>
      ).map((u) => {
        const fullName = [u.name, u.lastname].filter(Boolean).join(" ");
        return {
          value: u.id,
          label: u.nickname ? `${fullName} (${u.nickname})` : fullName,
          isSigReq: true,
        };
      });
    } catch {
      return [];
    }
  };

  // + NEW: กันคนซ้ำใน level เดียวกัน (อนุญาตให้ซ้ำข้าม level ได้)
  const validateLevelsNoDup = () => {
    for (let i = 0; i < approvalLevels.length; i++) {
      const lv = approvalLevels[i];
      const seen = new Set<number>();
      const dups: string[] = [];

      // Use approvers array if available (new unified format), otherwise fall back to legacy users array
      // Don't check both to avoid false duplicates when both arrays contain the same data
      const approvers = lv.approvers || [];
      if (approvers.length > 0) {
        // Check new approvers array (fixed users only)
        for (const a of approvers) {
          if (a.type === "fixed" && a.userId) {
            if (seen.has(a.userId)) dups.push(a.userLabel || `User ${a.userId}`);
            seen.add(a.userId);
          }
        }
      } else {
        // Fallback: Check legacy users array
        for (const u of lv.users) {
          if (seen.has(u.value)) dups.push(u.label);
          seen.add(u.value);
        }
      }

      if (dups.length) {
        const namesList = Array.from(new Set(dups)).join(", ");
        toast.error(`${t("approverDupSameLevel", { defaultValue: "Duplicate approver at the same level:" })} ${namesList}`);
        return false;
      }
    }
    return true;
  };

  /* ───────── fetch once ───────── */
  useEffect(() => {
    let alive = true; // กัน setState หลัง unmount

    // Define fetch functions inside useEffect to avoid hoisting issues
    const fetchTypesLocal = async () => {
      try {
        // Pass context=management to indicate this is for memo type management page
        // DCC users should see memo types from their primary BU + DCC Management Business Units
        const { data } = await axios.get<MemoType[]>("/api/memotypes", {
          params: { includeInactive: 'true', context: 'management' },
          withCredentials: true,
        });
        if (alive) setTypes(data);
      } catch (err) {
        console.error("❌ load types:", err);
      }
    };

    const fetchCountLocal = async () => {
      try {
        const { data } = await axios.get<{ activeCount: number; totalCount: number }>(
          "/api/memotypes/count",
          { withCredentials: true }
        );
        if (alive) {
          setActiveCount(data.activeCount);
          setTotalCount(data.totalCount);
        }
      } catch (err) {
        console.error("❌ load count:", err);
      }
    };

    (async () => {
      try {
        const { data: meRes } = await axios.get<MeRes>("/api/me", {
          withCredentials: true,
        });
        if (!alive) return;
        setMe(meRes);

        const allow = isAdminOrDcc(meRes);
        if (!allow) {
          setBlocked(true);
          setReady(false);
          setLoading(false);
          return; // ❗️อย่าทำ fetch อื่นต่อ
        }

        // Fetch manageable business units for DCC users
        if (hasRole(meRes, "DCC") && !hasRole(meRes, "ADMIN")) {
          try {
            const { data: manageableBUs } = await axios.get<ManageableBU[]>(
              `/api/users/${meRes.id}/manageable-business-units`,
              { withCredentials: true }
            );
            if (alive) setManageableBusinessUnits(manageableBUs);
          } catch (err) {
            console.error("❌ load manageable BUs:", err);
          }
        }

        await fetchTypesLocal();

        const { data: bus } = await axios.get<BusinessUnit[]>(
          "/api/business-units",
          {
            withCredentials: true,
          }
        );
        const { data: deps } = await axios.get<Department[]>(
          "/api/departments",
          { withCredentials: true }
        );
        if (!alive) return;
        setDepartments(deps);
        setBusinessUnits(bus);

        await fetchCountLocal();
        setReady(true);
      } catch (err) {
        console.error("🔴 init error:", err);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleDeleteExistingFile = async (typeId: number, fileId: number) => {
    if (!confirm(t("confirm.deleteFile"))) return;
    try {
      await axios.delete(`/api/memotypes/${typeId}/files/${fileId}`, {
        withCredentials: true,
      });
      setExistingFiles((prev) => (prev ?? []).filter((f) => f.id !== fileId));
      toast.success(t("toast.fileDeleteSuccess"));
    } catch (e) {
      console.error("delete file error:", e);
      toast.error(t("toast.fileDeleteFail"));
    }
  };

  const fetchTypes = async (businessUnitId?: number | "all") => {
    setLoading(true);
    try {
      // Pass context=management to indicate this is for memo type management page
      const params: Record<string, any> = { includeInactive: 'true', context: 'management' };
      // Add businessUnitId filter if a specific BU is selected (not "all")
      if (businessUnitId && businessUnitId !== "all") {
        params.businessUnitId = businessUnitId;
      }
      const { data } = await axios.get<MemoType[]>("/api/memotypes", {
        params,
        withCredentials: true,
      });
      setTypes(data);
    } catch (err) {
      console.error("❌ load types:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchCount = async () => {
    try {
      const { data } = await axios.get<{ activeCount: number; totalCount: number }>("/api/memotypes/count", {
        withCredentials: true,
      });
      setActiveCount(data.activeCount);
      setTotalCount(data.totalCount);
    } catch (err) {
      console.error("❌ load count:", err);
    }
  };

  /* ───────── form handlers ───────── */
  const handleChange = (e: React.ChangeEvent<any>) => {
    const { name, value, type, checked } = e.target;
    if (name === "businessUnitId" || name === "departmentId") {
      setForm((p) => ({
        ...p,
        [name]: value === "" ? undefined : Number(value),
      }));
      return;
    }
    setForm((p) => ({ ...p, [name]: type === "checkbox" ? checked : value }));
  };

  // ✅ ทำให้เลือกได้ทีละโหมดเดียว + จัดการ BU ให้ถูกต้อง
  const handleFlagChange =
    (
      flag:
        | "forEveryone"
        | "forEveryDepartmentAcrossBU"
        | "forAllDepartmentUnderSelectedBu"
    ) =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const checked = e.target.checked;
        setForm((prev) => {
          const next = { ...prev };

          if (flag === "forEveryone") {
            next.forEveryone = checked;
            if (checked) {
              next.forEveryDepartmentAcrossBU = false;
              next.forAllDepartmentUnderSelectedBu = false;
              next.businessUnitId = undefined;
              next.departmentId = undefined;
            }
          } else if (flag === "forEveryDepartmentAcrossBU") {
            next.forEveryDepartmentAcrossBU = checked;
            if (checked) {
              next.forEveryone = false;
              next.forAllDepartmentUnderSelectedBu = false;
              next.departmentId = undefined; // เคลียร์ Dept เดิม
              next.businessUnitId = undefined; // ✅ เคลียร์ BU เดิม
            }
          } else if (flag === "forAllDepartmentUnderSelectedBu") {
            next.forAllDepartmentUnderSelectedBu = checked;
            if (checked) {
              next.forEveryone = false;
              next.forEveryDepartmentAcrossBU = false;
              next.departmentId = undefined; // โหมดนี้ไม่ใช้ Department
            }
          }
          return next;
        });
      };

  const isScopeEveryone = !!form.forEveryone;
  const isScopeAcrossBU = !!form.forEveryDepartmentAcrossBU;
  const isScopeUnderBU = !!form.forAllDepartmentUnderSelectedBu;
  // ไม่มีโหมดทีมแล้ว
  const isScopeTeam = false;

  // บังคับให้เลือกได้ “ทีละ 1 โหมด” เสมอ
  const selectedModes = [
    isScopeEveryone,
    isScopeAcrossBU,
    isScopeUnderBU,
  ].filter(Boolean).length;
  const isNoMode = selectedModes === 0;
  const openModal = async (
    mode: "create" | "edit" | "duplicate",
    m?: MemoType
  ) => {
    setFiles([]);
    setExistingFiles([]);
    // ✅ Reset approval levels immediately to prevent stale data
    setApprovalLevels([]);

    if ((mode === "edit" || mode === "duplicate") && m) {
      try {
        // Pass context=management since this is from the management page
        const { data } = await axios.get<MemoType>(`/api/memotypes/${m.id}`, {
          withCredentials: true,
          params: { context: 'management' },
        });

        // ——— สร้างฟอร์มฐานจากข้อมูลจริง ———
        const baseForm: typeof form = {
          // duplicate: ห้ามมี id (จะสร้างใหม่) แต่เก็บ originalId สำหรับ duplicate
          id: mode === "edit" ? data.id : undefined,
          originalId: mode === "duplicate" ? data.id : undefined, // เก็บ ID ต้นฉบับสำหรับ duplicate
          // duplicate: ปรับชื่อ/ตัวย่อ กัน unique ชน (แก้ได้ก่อนกด Save)
          name: mode === "duplicate" ? `${data.name} (copy)` : data.name,
          description: data.description,
          abbreviation:
            mode === "duplicate" && data.abbreviation
              ? `${data.abbreviation}`
              : data.abbreviation,
          isActive: data.isActive,
          businessUnitId: (data as any).businessUnitId ?? undefined,
          // duplicate: ไม่อ้าง default ไฟล์เดิม
          defaultTypeFileId:
            mode === "edit" ? data.defaultTypeFileId ?? null : null,
          forEveryone: data.forEveryone ?? false,
          forAllDepartmentUnderSelectedBu:
            data.forAllDepartmentUnderSelectedBu ?? false,
          forEveryDepartmentAcrossBU: data.forEveryDepartmentAcrossBU ?? false,
          departmentId: data.department?.id ?? undefined,
        };
        setForm(baseForm);

        // ไฟล์เดิม/ตัวเลือก default
        if (mode === "edit") {
          setExistingFiles(data.typeFiles ?? []);
          setDefaultChoice(
            data.defaultTypeFileId ? `id:${data.defaultTypeFileId}` : null
          );
        } else if (mode === "duplicate") {
          // duplicate: แสดงไฟล์เดิมเพื่อให้ user เห็นว่าจะ duplicate อะไรบ้าง
          setExistingFiles(data.typeFiles ?? []);
          setDefaultChoice(null); // ไม่ตั้ง default file สำหรับ duplicate
        } else {
          setExistingFiles([]);
          setDefaultChoice(null);
        }

        // approvalLevels จาก API → ฟอร์ม
        const levels = (data.approvalLevels ?? []).map((lv) => {
          const flexibleSlots = lv.users
            .filter((u) => u.slotType && u.slotType !== "FIXED_USER")
            .map((u) => ({
              slotType: u.slotType as ApprovalSlotType,
              roleDescription: u.roleDescription || "",
              isSigReq: !!u.isSigReq,
            }));

          const levelName =
            flexibleSlots.length > 0
              ? flexibleSlots[0].roleDescription
              : lv.users.find((u) => !u.slotType || u.slotType === "FIXED_USER")
                ?.roleDescription || `Level ${lv.level}`;

          // NEW: Convert to unified approvers array
          const approvers: ApproverItem[] = lv.users.map((u, idx) => {
            const isFlexible = u.slotType && u.slotType !== "FIXED_USER";
            const fullName = u.nickname
              ? `${[u.name, u.lastname].filter(Boolean).join(" ")} (${u.nickname})`
              : [u.name, u.lastname].filter(Boolean).join(" ");
            
            return {
              id: `approver-${lv.level}-${idx}-${Date.now()}`,
              type: isFlexible ? "flexible" : "fixed",
              userId: isFlexible ? undefined : u.id,
              userLabel: isFlexible ? undefined : fullName,
              roleDescription: u.roleDescription || "",
              isSigReq: !!u.isSigReq,
            } as ApproverItem;
          });

          return {
            name: levelName,
            users: lv.users
              .filter((u) => !u.slotType || u.slotType === "FIXED_USER")
              .map((u) => ({
                value: u.id,
                label: u.nickname
                  ? `${[u.name, u.lastname].filter(Boolean).join(" ")} (${u.nickname
                  })`
                  : [u.name, u.lastname].filter(Boolean).join(" "),
                isSigReq: !!u.isSigReq,
              })),
            flexibleSlots,
            isFlexibleLevel: flexibleSlots.length > 0,
            approvalRequirement: (lv.users[0]?.approvalRequirement as "ALL" | "ANY") || "ALL",
            approvers, // NEW: Add unified approvers array
          };
        });
        setApprovalLevels(levels);
      } catch (error) {
        // ✅ Improved fallback: try to extract approval levels from list data
        console.error("Error fetching memo type details:", error);

        setForm({
          id: mode === "edit" ? m.id : undefined,
          originalId: mode === "duplicate" ? m.id : undefined, // เก็บ ID ต้นฉบับสำหรับ duplicate
          name: mode === "duplicate" ? `${m.name} (copy)` : m.name,
          description: m.description,
          abbreviation:
            mode === "duplicate" && m.abbreviation
              ? `${m.abbreviation}-COPY`
              : m.abbreviation,
          isActive: m.isActive,
          teamId: m.teamId ?? undefined, // ถ้าไม่ได้ใช้โหมดทีม อยู่เฉยๆ ได้
          businessUnitId: m.businessUnitId ?? undefined,
          defaultTypeFileId:
            mode === "edit" ? m.defaultTypeFileId ?? null : null,
          forEveryone: m.forEveryone ?? false,
          forAllDepartmentUnderSelectedBu:
            m.forAllDepartmentUnderSelectedBu ?? false,
          forEveryDepartmentAcrossBU: m.forEveryDepartmentAcrossBU ?? false,
          departmentId: (m as any).department?.id ?? undefined,
        } as typeof form);

        setExistingFiles(mode === "edit" ? m.typeFiles ?? [] : mode === "duplicate" ? m.typeFiles ?? [] : []);
        setDefaultChoice(
          mode === "edit" && m.defaultTypeFileId
            ? `id:${m.defaultTypeFileId}`
            : null
        );

        // ✅ Extract approval levels from list data if available
        if (m.approvalLevels && m.approvalLevels.length > 0) {
          const levels = m.approvalLevels.map((lv) => {
            const flexibleSlots = lv.users
              .filter((u) => u.slotType && u.slotType !== "FIXED_USER")
              .map((u) => ({
                slotType: u.slotType as ApprovalSlotType,
                roleDescription: u.roleDescription || "",
                isSigReq: !!u.isSigReq,
              }));

            const levelName =
              flexibleSlots.length > 0
                ? flexibleSlots[0].roleDescription
                : lv.users.find((u) => !u.slotType || u.slotType === "FIXED_USER")
                  ?.roleDescription || `Level ${lv.level}`;

            // NEW: Convert to unified approvers array
            const approvers: ApproverItem[] = lv.users.map((u, idx) => {
              const isFlexible = u.slotType && u.slotType !== "FIXED_USER";
              const fullName = u.nickname
                ? `${[u.name, u.lastname].filter(Boolean).join(" ")} (${u.nickname})`
                : [u.name, u.lastname].filter(Boolean).join(" ");
              
              return {
                id: `approver-${lv.level}-${idx}-${Date.now()}`,
                type: isFlexible ? "flexible" : "fixed",
                userId: isFlexible ? undefined : u.id,
                userLabel: isFlexible ? undefined : fullName,
                roleDescription: u.roleDescription || "",
                isSigReq: !!u.isSigReq,
              } as ApproverItem;
            });

            return {
              name: levelName,
              users: lv.users
                .filter((u) => !u.slotType || u.slotType === "FIXED_USER")
                .map((u) => ({
                  value: u.id,
                  label: u.nickname
                    ? `${[u.name, u.lastname].filter(Boolean).join(" ")} (${u.nickname
                    })`
                    : [u.name, u.lastname].filter(Boolean).join(" "),
                  isSigReq: !!u.isSigReq,
                })),
              flexibleSlots,
              isFlexibleLevel: flexibleSlots.length > 0,
              approvalRequirement: (lv.users[0]?.approvalRequirement as "ALL" | "ANY") || "ALL",
              approvers, // NEW: Add unified approvers array
            };
          });
          setApprovalLevels(levels);
        } else {
          // ✅ If no approval levels in list data, set empty array
          setApprovalLevels([]);
        }
      }

      // สำคัญ: set เป็นโหมดที่เปิดจริง (edit/duplicate)
      setModalMode(mode);
    } else {
      // โหมดสร้างใหม่
      setForm({
        name: "",
        description: "",
        abbreviation: "",
        isActive: true,
        teamId: undefined,
        businessUnitId: undefined,
        departmentId: undefined,
        defaultTypeFileId: null,
        forEveryone: false,
        forAllDepartmentUnderSelectedBu: true, // Default to true as per requirement
        forEveryDepartmentAcrossBU: false,
        originalId: undefined,
      });
      setDefaultChoice(null);
      setModalMode("create");
      setApprovalLevels([{ name: "", users: [], flexibleSlots: [], approvers: [], approvalRequirement: "ALL" }]);
    }
  };

  const closeModal = () => {
    setFiles([]);
    setModalMode(null);
    setApprovalLevels([{ name: "", users: [], flexibleSlots: [], approvers: [], approvalRequirement: "ALL" }]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      // โหมดสิทธิ์
      const isScopeUnderBU = !!form.forAllDepartmentUnderSelectedBu;

      // Validate - Business Unit is always required
      if (!form.businessUnitId) {
        toast.error(t("requireBUWhenNoMode", "กรุณาเลือก BU"));
        return;
      }

      // Department is required only when forAllDepartmentUnderSelectedBu is false
      if (!isScopeUnderBU && !form.departmentId) {
        toast.error(t("requireDeptWhenNoMode", "กรุณาเลือก Department"));
        return;
      }

      if (modalMode === "create" || modalMode === "duplicate") {
        const fd = new FormData();
        fd.append("name", form.name.trim());
        fd.append("description", form.description.trim());
        fd.append("abbreviation", form.abbreviation ?? "");
        fd.append("isActive", String(!!form.isActive));

        // Add duplicateFromId if this is a duplication
        if (modalMode === "duplicate" && form.originalId) {
          fd.append("duplicateFromId", String(form.originalId));
        }

        // flags - only forAllDepartmentUnderSelectedBu is used now
        fd.append("forEveryone", "false");
        fd.append("forEveryDepartmentAcrossBU", "false");
        fd.append("forAllDepartmentUnderSelectedBu", String(isScopeUnderBU));

        /* ---------- SCOPE FIELDS ---------- */
        fd.append("businessUnitId", String(form.businessUnitId!));
        if (isScopeUnderBU) {
          // When forAllDepartmentUnderSelectedBu is true, department is optional
          fd.append("departmentId", form.departmentId ? String(form.departmentId) : "");
        } else {
          // When forAllDepartmentUnderSelectedBu is false, department is required
          fd.append("departmentId", String(form.departmentId!));
        }

        // default file
        if (defaultChoice === null) {
          fd.append("defaultTypeFileId", "");
        } else if (defaultChoice.startsWith("id:")) {
          fd.append("defaultTypeFileId", defaultChoice.split(":")[1]);
        } else if (defaultChoice.startsWith("new:")) {
          fd.append("defaultMainFileIndex", defaultChoice.split(":")[1]);
        }

        // files
        for (const f of files) if (isAllowedFile(f)) fd.append("files", f);

        // Approval Line validate
        if (approvalLevels.length === 0) {
          toast.error(t("needAtLeastOneLevel"));
          return;
        }
        if (!validateLevelsNoDup()) return;
        
        // NEW: Validate using approvers array if available, otherwise fall back to legacy
        const emptyLv = approvalLevels.findIndex((lv) => {
          const approvers = lv.approvers || [];
          if (approvers.length > 0) {
            // Using new unified approvers system
            // Check if any fixed approver is missing user selection
            const hasInvalidFixed = approvers.some(a => a.type === "fixed" && !a.userId);
            // Check if any flexible approver is missing role description
            const hasInvalidFlexible = approvers.some(a => a.type === "flexible" && !a.roleDescription?.trim());
            return approvers.length === 0 || hasInvalidFixed || hasInvalidFlexible;
          } else {
            // Legacy validation
            if (lv.isFlexibleLevel) {
              return lv.flexibleSlots.length === 0 || !lv.name?.trim();
            }
            return (lv.users?.length ?? 0) === 0;
          }
        });
        if (emptyLv >= 0) {
          const lv = approvalLevels[emptyLv];
          const approvers = lv.approvers || [];
          if (approvers.length > 0) {
            const hasInvalidFixed = approvers.some(a => a.type === "fixed" && !a.userId);
            const hasInvalidFlexible = approvers.some(a => a.type === "flexible" && !a.roleDescription?.trim());
            if (approvers.length === 0) {
              toast.error(t("levelRequireApprover", { index: emptyLv + 1 }));
            } else if (hasInvalidFixed) {
              toast.error(t("approval.selectUserForFixed", { index: emptyLv + 1, defaultValue: `Level ${emptyLv + 1}: Please select a user for fixed approver` }));
            } else if (hasInvalidFlexible) {
              toast.error(t("approval.roleRequiredForFlexible", { index: emptyLv + 1, defaultValue: `Level ${emptyLv + 1}: Please enter a role for flexible approver` }));
            }
          } else {
            toast.error(
              lv.isFlexibleLevel
                ? t("levelRequireFlexName", { index: emptyLv + 1 })
                : t("levelRequireApprover", { index: emptyLv + 1 })
            );
          }
          return;
        }

        // NEW: Generate payload using approvers array if available
        const payloadLevels = approvalLevels.map((lv) => {
          const approvers = lv.approvers || [];
          if (approvers.length > 0) {
            // Using new unified approvers system
            return {
              users: approvers.map((a) => {
                if (a.type === "fixed") {
                  return {
                    id: a.userId,
                    isSigReq: a.isSigReq,
                    slotType: "FIXED_USER" as const,
                    roleDescription: a.roleDescription || "",
                    approvalRequirement: lv.approvalRequirement || "ALL",
                  };
                } else {
                  return {
                    slotType: "FLEXIBLE_SLOT" as const,
                    roleDescription: a.roleDescription || "",
                    isSigReq: a.isSigReq,
                    approvalRequirement: lv.approvalRequirement || "ALL",
                  };
                }
              }),
            };
          } else {
            // Legacy payload generation
            return {
              users: lv.isFlexibleLevel
                ? lv.flexibleSlots.map((slot) => ({
                    slotType: "FLEXIBLE_SLOT" as const,
                    roleDescription: slot.roleDescription || lv.name || "",
                    isSigReq: slot.isSigReq ?? true,
                    approvalRequirement: lv.approvalRequirement || "ALL",
                  }))
                : [
                  ...lv.users.map((u) => ({
                    id: u.value,
                    isSigReq: !!u.isSigReq,
                    slotType: "FIXED_USER" as const,
                    roleDescription: lv.name || "",
                    approvalRequirement: lv.approvalRequirement || "ALL",
                  })),
                ],
            };
          }
        });
        fd.append("createApprovalLine", "true");
        fd.append("approvalLevels", JSON.stringify(payloadLevels));

        const response = await axios.post("/api/memotypes", fd, { withCredentials: true });
        
        // Float to top
        if (response.data && response.data.id) {
          setEditedMemoTypeIds(prev => new Set(prev).add(response.data.id));
        } else if (response.data && response.data.memoType && response.data.memoType.id) {
          setEditedMemoTypeIds(prev => new Set(prev).add(response.data.memoType.id));
        }
      } else if (modalMode === "edit" && form.id) {
        const fd = new FormData();
        fd.append("name", form.name.trim());
        fd.append("description", form.description.trim());
        fd.append("abbreviation", form.abbreviation ?? "");
        fd.append("isActive", String(!!form.isActive));

        // flags - only forAllDepartmentUnderSelectedBu is used now
        fd.append("forEveryone", "false");
        fd.append("forEveryDepartmentAcrossBU", "false");
        fd.append("forAllDepartmentUnderSelectedBu", String(isScopeUnderBU));

        /* ---------- SCOPE FIELDS ---------- */
        fd.append("businessUnitId", String(form.businessUnitId!));
        if (isScopeUnderBU) {
          // When forAllDepartmentUnderSelectedBu is true, department is optional
          fd.append("departmentId", form.departmentId ? String(form.departmentId) : "");
        } else {
          // When forAllDepartmentUnderSelectedBu is false, department is required
          fd.append("departmentId", String(form.departmentId!));
        }

        // default file
        // default file
        if (defaultChoice === null) {
          // ไม่มี default
          fd.append("defaultTypeFileId", "");
        } else if (defaultChoice.startsWith("id:")) {
          // ใช้ไฟล์เดิมเป็น default
          fd.append("defaultTypeFileId", defaultChoice.split(":")[1]);
        } else if (defaultChoice.startsWith("new:")) {
          // ใช้ไฟล์ใหม่ที่เพิ่งอัปโหลดรอบนี้เป็น default
          fd.append("defaultMainFileIndex", defaultChoice.split(":")[1]);
        }
        // files
        for (const f of files) fd.append("files", f);

        // อัปเดต Approval Line (ถ้ามีในฟอร์ม)
        if (approvalLevels.length > 0) {
          if (!validateLevelsNoDup()) return;
          
          // NEW: Validate using approvers array if available
          const emptyLv = approvalLevels.findIndex((lv) => {
            const approvers = lv.approvers || [];
            if (approvers.length > 0) {
              const hasInvalidFixed = approvers.some(a => a.type === "fixed" && !a.userId);
              const hasInvalidFlexible = approvers.some(a => a.type === "flexible" && !a.roleDescription?.trim());
              return approvers.length === 0 || hasInvalidFixed || hasInvalidFlexible;
            } else {
              if (lv.isFlexibleLevel) {
                return lv.flexibleSlots.length === 0 || !lv.name?.trim();
              }
              return (lv.users?.length ?? 0) === 0;
            }
          });
          if (emptyLv >= 0) {
            const lv = approvalLevels[emptyLv];
            const approvers = lv.approvers || [];
            if (approvers.length > 0) {
              const hasInvalidFixed = approvers.some(a => a.type === "fixed" && !a.userId);
              const hasInvalidFlexible = approvers.some(a => a.type === "flexible" && !a.roleDescription?.trim());
              if (approvers.length === 0) {
                toast.error(t("levelRequireApprover", { index: emptyLv + 1 }));
              } else if (hasInvalidFixed) {
                toast.error(t("approval.selectUserForFixed", { index: emptyLv + 1, defaultValue: `Level ${emptyLv + 1}: Please select a user for fixed approver` }));
              } else if (hasInvalidFlexible) {
                toast.error(t("approval.roleRequiredForFlexible", { index: emptyLv + 1, defaultValue: `Level ${emptyLv + 1}: Please enter a role for flexible approver` }));
              }
            } else {
              toast.error(
                lv.isFlexibleLevel
                  ? t("levelRequireFlexName", { index: emptyLv + 1 })
                  : t("levelRequireApprover", { index: emptyLv + 1 })
              );
            }
            return;
          }
          
          // NEW: Generate payload using approvers array if available
          const payloadLevels = approvalLevels.map((lv, idx) => {
            const approvers = lv.approvers || [];
            if (approvers.length > 0) {
              return {
                level: idx,
                users: approvers.map((a) => {
                  if (a.type === "fixed") {
                    return {
                      id: a.userId,
                      isSigReq: a.isSigReq,
                      slotType: "FIXED_USER" as const,
                      roleDescription: a.roleDescription || "",
                      approvalRequirement: lv.approvalRequirement || "ALL",
                    };
                  } else {
                    return {
                      slotType: "FLEXIBLE_SLOT" as const,
                      roleDescription: a.roleDescription || "",
                      isSigReq: a.isSigReq,
                      approvalRequirement: lv.approvalRequirement || "ALL",
                    };
                  }
                }),
              };
            } else {
              return {
                level: idx,
                users: lv.isFlexibleLevel
                  ? lv.flexibleSlots.map((slot) => ({
                      slotType: "FLEXIBLE_SLOT" as const,
                      roleDescription: slot.roleDescription || lv.name || "",
                      isSigReq: slot.isSigReq ?? true,
                      approvalRequirement: lv.approvalRequirement || "ALL",
                    }))
                  : [
                    ...lv.users.map((u) => ({
                      id: u.value,
                      isSigReq: !!u.isSigReq,
                      slotType: "FIXED_USER" as const,
                      roleDescription: lv.name || "",
                      approvalRequirement: lv.approvalRequirement || "ALL",
                    })),
                  ],
              };
            }
          });
          fd.append("updateApprovalLine", "true");
          fd.append("approvalLevels", JSON.stringify(payloadLevels));
        }

        await axios.put(`/api/memotypes/${form.id}`, fd, {
          withCredentials: true,
        });

        // Float to top
        setEditedMemoTypeIds(prev => {
          const newSet = new Set(prev);
          newSet.delete(form.id!);
          newSet.add(form.id!);
          return newSet;
        });
      }

      await fetchTypes();
      await fetchCount();
      setFiles([]);
      closeModal();
    } catch (err: any) {
      console.error("❌ submit:", err?.response?.data || err);
      toast.error(err?.response?.data?.error ?? t("saveFailed"));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (window.confirm(t("confirm.delete"))) {
      try {
        await axios.delete(`/api/memotypes/${id}`, { withCredentials: true });
        setTypes((p) => p.filter((x) => x.id !== id));
        await fetchCount();
      } catch (err: any) {
        console.error("❌ delete:", err);
        if (err.response?.status === 409) {
          const memoCount = err.response?.data?.details?.memoCount || 0;
          alert(t("error.cannotDeleteInUse", { count: memoCount }));
        } else {
          alert(t("error.deleteFailed"));
        }
      }
    }
  };
  // ---------- search helpers ----------
  const parseBoolLike = (v?: string | null) => {
    const s = (v ?? "").trim().toLowerCase();
    return ["1", "true", "yes", "y", "on", "t", "ใช่", "เปิด"].includes(s)
      ? true
      : ["0", "false", "no", "n", "off", "f", "ไม่", "ปิด"].includes(s)
        ? false
        : null;
  };

  const getModeOfType = (mt: MemoType) => {
    if (mt.forEveryone) return "everyone";
    if (mt.forEveryDepartmentAcrossBU) return "across";
    if (mt.forAllDepartmentUnderSelectedBu) return "under";
    return "none";
  };

  // ---------- types + parser ----------
  type QueryFilters = {
    id?: string;
    name?: string; // NEW
    desc?: string; // NEW (description)
    abbr?: string;
    bu?: string;
    buId?: string; // NEW
    dept?: string;
    deptId?: string; // NEW
    mode?: "everyone" | "across" | "under" | "none";
    active?: boolean | null;
  };

  const parseQuery = (raw: string): { filters: QueryFilters; rest: string } => {
    const filters: QueryFilters = {};
    const parts = raw.trim().split(/\s+/);
    const rest: string[] = [];

    const allowedModes = ["everyone", "across", "under", "none"] as const;
    type Mode = (typeof allowedModes)[number];
    const isMode = (s: string): s is Mode =>
      (allowedModes as readonly string[]).includes(s);

    for (const p of parts) {
      const m = p.match(/^(\w+):(.*)$/);
      if (!m) {
        rest.push(p);
        continue;
      }
      const key = m[1].toLowerCase();
      const val = (m[2] ?? "").toLowerCase();

      if (key === "id") filters.id = val;
      // name/title
      else if (key === "name" || key === "title") filters.name = val;
      // description/desc
      else if (key === "desc" || key === "description") filters.desc = val;
      // abbreviation
      else if (key === "abbr" || key === "abbrev" || key === "short")
        filters.abbr = val;
      // business unit (by name/id)
      else if (key === "bu" || key === "business" || key === "businessunit")
        filters.bu = val;
      else if (key === "buid" || key === "bu_id") filters.buId = val;
      // department (by name/id)
      else if (key === "dept" || key === "department") filters.dept = val;
      else if (key === "deptid" || key === "dept_id") filters.deptId = val;
      else if (key === "mode") {
        if (isMode(val)) filters.mode = val;
      } else if (key === "active") {
        filters.active = parseBoolLike(val);
      } else {
        // ไม่รู้จัก key ⇒ ถือเป็น free text
        rest.push(p);
      }
    }
    return { filters, rest: rest.join(" ") };
  };

  // ---------- filtered ----------
  const norm = (v: any) =>
    String(v ?? "")
      .toLowerCase()
      .trim();
  const toDateStrings = (iso?: string) => {
    if (!iso) return [] as string[];
    const d = new Date(iso);
    if (isNaN(d.getTime())) return [];
    return [
      d.toISOString().slice(0, 10), // YYYY-MM-DD
      String(d.getFullYear()), // ปี (ค้นหาด้วยปีได้)
      d.toLocaleDateString("th-TH"), // รูปแบบไทย
    ];
  };

  const filtered = React.useMemo(() => {
    const raw = (searchTerm || "").trim();
    let result = types;

    // + NEW: Filter by Active/Hidden Tab
    if (activeTab === "active") {
      result = result.filter((t) => !t.isDelete);
    } else {
      result = result.filter((t) => t.isDelete);
    }

    // Apply dynamic BU dropdown filter first
    if (dynamicBUFilterIds.length > 0) {
      result = result.filter((mt) => mt.businessUnit?.id && dynamicBUFilterIds.includes(mt.businessUnit.id));
    }

    // Apply dynamic Dept dropdown filter
    if (dynamicDeptFilterIds.length > 0) {
      result = result.filter((mt) => mt.department?.id && dynamicDeptFilterIds.includes(mt.department.id));
    }

    // Apply column filters first
    if (Object.values(columnFilters).some(f => f !== "") || selectedApprover) {
      result = result.filter((mt) => {
        const matchesNameFilter =
          !columnFilters.name ||
          mt.name?.toLowerCase().includes(columnFilters.name.toLowerCase());
        const matchesAbbreviationFilter =
          !columnFilters.abbreviation ||
          mt.abbreviation?.toLowerCase().includes(columnFilters.abbreviation.toLowerCase());
        const matchesBusinessUnitFilter =
          !columnFilters.businessUnit ||
          mt.businessUnit?.name?.toLowerCase().includes(columnFilters.businessUnit.toLowerCase());
        const matchesDepartmentFilter =
          !columnFilters.department ||
          mt.department?.name?.toLowerCase().includes(columnFilters.department.toLowerCase());

        // Status filter
        const matchesStatusFilter = !columnFilters.status || columnFilters.status === "all" || (() => {
          if (columnFilters.status === "active") return mt.isActive;
          if (columnFilters.status === "inactive") return !mt.isActive;
          return true;
        })();

        // Approvers filter - search in approver names
        const matchesApproversFilter = !columnFilters.approvers || (() => {
          const searchTerm = columnFilters.approvers.toLowerCase();

          // Check in approval levels
          if (mt.approvalLevels && mt.approvalLevels.length > 0) {
            return mt.approvalLevels.some((level: any) =>
              level.users.some((user: any) => {
                const userName = `${user.name || ''} ${user.lastname || ''}`.trim().toLowerCase();
                const roleDesc = (user.roleDescription || '').toLowerCase();
                return userName.includes(searchTerm) || roleDesc.includes(searchTerm);
              })
            );
          }

          // Check in approval line users
          if (mt.approvalLineId) {
            const approvalLine = approvalLines.find(line => line.id === mt.approvalLineId);
            if (approvalLine && approvalLine.approvalUsers) {
              return approvalLine.approvalUsers.some((approvalUser: any) => {
                if (approvalUser.user) {
                  const userName = `${approvalUser.user.name || ''} ${approvalUser.user.lastname || ''}`.trim().toLowerCase();
                  return userName.includes(searchTerm);
                }
                const roleDesc = (approvalUser.roleDescription || '').toLowerCase();
                return roleDesc.includes(searchTerm);
              });
            }
          }

          return false;
        })();

        // Check if memo type has the selected approver in its approval line
        const matchesApproverFilter = !selectedApprover || (() => {
          if (!mt.approvalLineId) return false;

          // Find the approval line for this memo type
          const approvalLine = approvalLines.find(line => line.id === mt.approvalLineId);
          if (!approvalLine || !approvalLine.approvalUsers) return false;

          // Check if the selected approver is in this approval line
          return approvalLine.approvalUsers.some((approvalUser: any) =>
            approvalUser.user && approvalUser.user.id === selectedApprover.id
          );
        })();

        return matchesNameFilter && matchesAbbreviationFilter && matchesBusinessUnitFilter &&
          matchesDepartmentFilter && matchesStatusFilter && matchesApproversFilter &&
          matchesApproverFilter;
      });
    }

    // Apply search term filter
    if (!raw) return result;

    const q = raw.toLowerCase();
    const { filters, rest } = parseQuery(q);

    result = result.filter((mt) => {
      // ---------- ❶ ฟิลเตอร์แบบระบุ field ----------
      if (filters.id && !String(mt.id).includes(filters.id)) return false;

      if (filters.name && !norm(mt.name).includes(filters.name)) return false;

      if (filters.desc && !norm(mt.description).includes(filters.desc))
        return false;

      if (filters.abbr && !norm(mt.abbreviation).includes(filters.abbr))
        return false;

      // BU name / id (รวม fallback จาก team.businessUnit)
      const buNameAll = norm(
        mt.businessUnit?.name ?? (mt as any).team?.businessUnit?.name
      );
      const buIdAll = String(
        mt.businessUnit?.id ?? (mt as any).team?.businessUnit?.id ?? ""
      );
      if (filters.bu && !buNameAll.includes(filters.bu)) return false;
      if (filters.buId && !buIdAll.includes(filters.buId)) return false;

      // Dept name / id
      const deptName = norm(mt.department?.name);
      const deptId = String(mt.department?.id ?? "");
      if (filters.dept && !deptName.includes(filters.dept)) return false;
      if (filters.deptId && !deptId.includes(filters.deptId)) return false;

      if (filters.mode && getModeOfType(mt) !== filters.mode) return false;

      if (filters.active != null && !!mt.isActive !== filters.active)
        return false;

      // ---------- ❷ free text: รวมทุกคอลัมน์ลง hay ----------
      const activeWords = mt.isActive
        ? "1 true yes y on t ใช่ เปิด active enabled"
        : "0 false no n off f ไม่ ปิด inactive disabled";

      const fileNames =
        (mt.typeFiles ?? []).map((f) => f.fileName).join(" ") || "";

      const approverStrings = (mt.approvalLevels ?? []).flatMap((lv) =>
        lv.users.map(
          (u) =>
            `${u.name ?? ""} ${u.lastname ?? ""} ${u.nickname ?? ""} ${u.roleDescription ?? ""
            }`
        )
      );

      const hay = norm(
        [
          mt.id,
          mt.name,
          mt.abbreviation,
          mt.description,
          buNameAll, // BU name (รวม fallback)
          buIdAll, // BU id
          deptName, // Dept name
          deptId, // Dept id
          getModeOfType(mt), // โหมด
          activeWords, // active/inactive คำพ้อง
          ...toDateStrings(mt.createdAt),
          fileNames, // ชื่อไฟล์ template
          ...approverStrings, // รายชื่อ/บทบาทผู้อนุมัติ
        ]
          .filter((x) => x !== undefined && x !== null)
          .join(" ")
      );

      // ---------- ❸ free-text tokens (AND) ----------
      const restQ = rest.trim();
      if (!restQ) return true; // ค้นด้วย key:value ล้วน ⇒ ผ่าน
      const tokens = restQ.split(/\s+/).filter(Boolean);
      const matches = tokens.every((tk) => hay.includes(tk));

      // Simple fallback search if complex search fails
      if (!matches && restQ) {
        const simpleSearch = norm(q);
        return (
          norm(mt.name).includes(simpleSearch) ||
          norm(mt.description).includes(simpleSearch) ||
          norm(mt.abbreviation).includes(simpleSearch) ||
          norm(mt.businessUnit?.name).includes(simpleSearch) ||
          norm(mt.department?.name).includes(simpleSearch)
        );
      }

      return matches;
    });

    return result;
  }, [types, searchTerm, columnFilters, selectedApprover, approvalLines, dynamicBUFilterIds, dynamicDeptFilterIds, activeTab]);

  // Compute counts locally for the tabs
  const countActiveTab = types.filter(t => !t.isDelete).length;
  const countHiddenTab = types.filter(t => t.isDelete).length;

  // Compute unique business units from the current data (for dynamic dropdown)
  const availableBusinessUnits = React.useMemo(() => {
    const buMap = new Map<number, { id: number; name: string }>();
    types.forEach((mt) => {
      if (mt.businessUnit?.id && mt.businessUnit?.name) {
        buMap.set(mt.businessUnit.id, {
          id: mt.businessUnit.id,
          name: mt.businessUnit.name,
        });
      }
    });
    return Array.from(buMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'th-TH'));
  }, [types]);

  // Compute available departments based on selected BUs
  const availableDepartments = React.useMemo(() => {
    const deptMap = new Map<number, { id: number; name: string }>();
    
    types.forEach((mt) => {
      // If BU filter is active, only show departments from selected BUs
      if (dynamicBUFilterIds.length > 0) {
        if (mt.businessUnit?.id && dynamicBUFilterIds.includes(mt.businessUnit.id) && mt.department?.id && mt.department?.name) {
          deptMap.set(mt.department.id, {
            id: mt.department.id,
            name: mt.department.name,
          });
        }
      } else {
        // No BU filter, show all departments
        if (mt.department?.id && mt.department?.name) {
          deptMap.set(mt.department.id, {
            id: mt.department.id,
            name: mt.department.name,
          });
        }
      }
    });
    
    return Array.from(deptMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'th-TH'));
  }, [types, dynamicBUFilterIds]);

  const editedOrderMap = React.useMemo(() => new Map(
    Array.from(editedMemoTypeIds).reverse().map((id, index) => [String(id), index])
  ), [editedMemoTypeIds]);

  // ใช้ comparator ใหม่
  const sorted = React.useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      // Float edited lines to the top (newest first).
      const indexA = editedOrderMap.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER;
      const indexB = editedOrderMap.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER;
      
      if (indexA !== indexB) {
        return indexA - indexB;
      }
      
      return comparator(a, b);
    });
    return arr;
  }, [filtered, comparator, editedOrderMap]);

  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
    setCurrentPage(1);
  };



  const isAll = pageSize === 0;

  // ใหม่ (ถ้า All ให้คืนทั้งก้อน และมีแค่ 1 หน้า)
  const totalPages = isAll
    ? 1
    : Math.max(1, Math.ceil(sorted.length / pageSize));
  const paginated = isAll
    ? sorted
    : sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  React.useEffect(() => {
    if (isAll) {
      if (currentPage !== 1) setCurrentPage(1);
      return;
    }
    const tp = Math.max(1, Math.ceil(sorted.length / pageSize));
    if (currentPage > tp) setCurrentPage(tp);
  }, [isAll, sorted.length, pageSize]);

  // บังคับ All เมื่อกำลังค้นหา และคืนค่าเดิมเมื่อเคลียร์
  const pageSizeBeforeSearchRef = React.useRef<number>(pageSize);
  const isSearchingRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    const q = (searchTerm || "").trim();
    const hasSearchTerm = q.length > 0;

    if (hasSearchTerm && !isSearchingRef.current) {
      // Starting search - save current page size and switch to All
      isSearchingRef.current = true;
      if (pageSize !== 0) {
        pageSizeBeforeSearchRef.current = pageSize;
        setPageSize(0); // All
      }
      setCurrentPage(1);
    } else if (!hasSearchTerm && isSearchingRef.current) {
      // Ending search - restore previous page size
      isSearchingRef.current = false;
      const previousPageSize = pageSizeBeforeSearchRef.current || PAGE_SIZE_OPTIONS[0];
      if (pageSize === 0 && previousPageSize !== 0) {
        setPageSize(previousPageSize);
      }
      setCurrentPage(1);
    } else if (hasSearchTerm) {
      // Continue searching - ensure we're on page 1
      setCurrentPage(1);
    }
  }, [searchTerm, pageSize]);

  // Show loading state while checking permissions
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#183e33]"></div>
        <span className="ml-3 text-gray-600">{t("loading", "Loading...")}</span>
      </div>
    );
  }

  // Check if user is blocked from accessing this page
  if (blocked) {
    return <UnauthorizedAccess />;
  }

  return (
    <div className="p-6 w-full">
      {/* header */}
      <div className="flex flex-col gap-4 mb-6">
        {/* + NEW: Tabs */}
        <div className="flex space-x-4 border-b border-gray-200">
          <button
            className={`py-2 px-4 font-medium border-b-2 transition-colors ${
              activeTab === "active"
                ? "border-[#183e33] text-[#183e33]"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
            onClick={() => {
              setActiveTab("active");
              setCurrentPage(1);
            }}
          >
            {t("tab.all", { count: countActiveTab })}
          </button>
          <button
            className={`py-2 px-4 font-medium border-b-2 transition-colors ${
              activeTab === "hidden"
                ? "border-[#183e33] text-[#183e33]"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
            onClick={() => {
              setActiveTab("hidden");
              setCurrentPage(1);
            }}
          >
            {t("tab.deleted", { count: countHiddenTab })}
          </button>
        </div>

        {/* Filter Row - Single line layout */}
        <div className="flex flex-wrap items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
          {/* Search Document Types */}
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <input
              type="text"
              placeholder={t("searchPlaceholder", "Search document types...")}
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#183e33]"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
            />
            <svg
              className="absolute left-3 top-2.5 h-5 w-5 text-gray-400"
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

          {/* Divider */}
          <div className="hidden md:block h-8 w-px bg-gray-300"></div>

          {/* Dynamic Business Unit Filter Dropdown - Multi-select */}
          {availableBusinessUnits.length > 1 && (
            <div className="flex items-center gap-2 w-full sm:w-auto">
              {/* <span className="text-sm text-gray-600 whitespace-nowrap">
                {t("filter.byBU")}
              </span> */}
              <div className="relative min-w-[400px] max-sm:min-w-full max-sm:w-full" ref={buDropdownRef}>
                <button
                  onClick={() => setIsBUDropdownOpen(!isBUDropdownOpen)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#183e33] bg-white flex items-center justify-between"
                >
                  <span className={dynamicBUFilterIds.length > 0 ? "text-gray-900" : "text-gray-500"}>
                    {dynamicBUFilterIds.length > 0
                      ? `${dynamicBUFilterIds.length} ${t("filter.selected", "selected")}`
                      : t("filter.selectBUs", "Select business units...")}
                  </span>
                  <div className="flex items-center gap-2">
                    {dynamicBUFilterIds.length > 0 && (
                      <span className="bg-blue-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                        {dynamicBUFilterIds.length}
                      </span>
                    )}
                    <BiChevronDown className={`w-5 h-5 transition-transform ${isBUDropdownOpen ? "rotate-180" : ""}`} />
                  </div>
                </button>
                {isBUDropdownOpen && (
                  <div className="absolute z-20 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                    {availableBusinessUnits.map((bu) => (
                      <div
                        key={bu.id}
                        onClick={() => {
                          const isSelected = dynamicBUFilterIds.includes(bu.id);
                          if (isSelected) {
                            setDynamicBUFilterIds(dynamicBUFilterIds.filter(id => id !== bu.id));
                          } else {
                            setDynamicBUFilterIds([...dynamicBUFilterIds, bu.id]);
                          }
                          setCurrentPage(1);
                        }}
                        className="cursor-pointer select-none relative py-2 px-3 hover:bg-blue-100 hover:text-blue-900 text-gray-900"
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={dynamicBUFilterIds.includes(bu.id)}
                            onChange={() => {}}
                            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 pointer-events-none"
                          />
                          <span className={dynamicBUFilterIds.includes(bu.id) ? "font-semibold" : "font-normal"}>
                            {bu.name}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {dynamicBUFilterIds.length > 0 && (
                <button
                  onClick={() => setDynamicBUFilterIds([])}
                  className="text-xs text-red-600 hover:text-red-700 flex items-center gap-1"
                  title={t("filter.clearBU", "Clear BU filter")}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* Divider - only show if dynamic BU filter is visible */}
          {availableBusinessUnits.length > 1 && (
            <div className="hidden md:block h-8 w-px bg-gray-300"></div>
          )}

          {/* Dynamic Department Filter Dropdown - Multi-select */}
          {availableDepartments.length > 0 && (
            <div className="flex items-center gap-2 w-full sm:w-auto">
              {/* <span className="text-sm text-gray-600 whitespace-nowrap">
                {t("filter.byDept", "Department")}
              </span> */}
              <Listbox
                value={dynamicDeptFilterIds}
                onChange={(selected) => {
                  setDynamicDeptFilterIds(selected);
                  setCurrentPage(1);
                }}
                multiple
              >
                {({ open }) => (
                  <div className="relative min-w-[400px] max-sm:min-w-full max-sm:w-full">
                    <Listbox.Button className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#183e33] bg-white flex items-center justify-between">
                      <span className={dynamicDeptFilterIds.length > 0 ? "text-gray-900" : "text-gray-500"}>
                        {dynamicDeptFilterIds.length > 0
                          ? `${dynamicDeptFilterIds.length} ${t("filter.selected", "selected")}`
                          : t("filter.selectDepts", "Select departments...")}
                      </span>
                      <div className="flex items-center gap-2">
                        {dynamicDeptFilterIds.length > 0 && (
                          <span className="bg-green-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                            {dynamicDeptFilterIds.length}
                          </span>
                        )}
                        <BiChevronDown className={`w-5 h-5 transition-transform ${open ? "rotate-180" : ""}`} />
                      </div>
                    </Listbox.Button>
                    <Listbox.Options className="absolute z-20 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                      {availableDepartments.map((dept) => (
                        <Listbox.Option
                          key={dept.id}
                          value={dept.id}
                          className={({ active }) =>
                            `cursor-pointer select-none relative py-2 px-3 ${
                              active ? "bg-green-100 text-green-900" : "text-gray-900"
                            }`
                          }
                        >
                          {({ selected }) => (
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => {}}
                                className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                              />
                              <span className={selected ? "font-semibold" : "font-normal"}>
                                {dept.name}
                              </span>
                            </div>
                          )}
                        </Listbox.Option>
                      ))}
                    </Listbox.Options>
                  </div>
                )}
              </Listbox>
              {dynamicDeptFilterIds.length > 0 && (
                <button
                  onClick={() => setDynamicDeptFilterIds([])}
                  className="text-xs text-red-600 hover:text-red-700 flex items-center gap-1"
                  title={t("filter.clearDept", "Clear Department filter")}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* Divider */}
          {availableDepartments.length > 0 && (
            <div className="hidden md:block h-8 w-px bg-gray-300"></div>
          )}

          {/* Approver Filter */}
          <div className="relative min-w-[200px] w-full sm:w-auto" ref={approverSearchInputRef}>
            <div className="relative">
              <input
                type="text"
                placeholder={t("filter.approver.searchPlaceholder")}
                className="w-full pl-8 pr-8 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#183e33]"
                value={approverSearchTerm}
                onChange={(e) => handleApproverSearchChange(e.target.value)}
                onFocus={() => setShowApproverDropdown(true)}
              />
              <svg
                className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
              {selectedApprover && (
                <button
                  onClick={clearApproverFilter}
                  className="absolute right-2 top-2 text-gray-400 hover:text-gray-600"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Approver Search Dropdown */}
            {showApproverDropdown && (
              <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {isSearchingApprover ? (
                  <div className="p-3 text-center text-gray-500 text-sm">
                    <div className="animate-spin inline-block w-4 h-4 border-2 border-gray-300 border-t-orange-500 rounded-full mr-2"></div>
                    {t("filter.approver.searching")}
                  </div>
                ) : approverSearchResults.length > 0 ? (
                  approverSearchResults.map((user) => (
                    <button
                      key={user.id}
                      onClick={() => selectApproverToFilter(user)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-orange-50 flex items-center gap-2"
                    >
                      <div className="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center text-xs font-medium text-orange-600">
                        {(user.firstName?.[0] || user.email?.[0] || "?").toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium text-gray-900">
                          {[user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "Unknown"}
                        </div>
                        {user.nickname && (
                          <div className="text-xs text-gray-500">({user.nickname})</div>
                        )}
                      </div>
                    </button>
                  ))
                ) : approverSearchTerm ? (
                  <div className="p-3 text-center text-gray-500 text-sm">
                    {t("filter.approver.noResults")}
                  </div>
                ) : (
                  <div className="p-3 text-center text-gray-400 text-sm">
                    {t("filter.approver.initial")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Spacer to push right-side items */}
          <div className="flex-1"></div>

          {/* Total Records Display */}
          <div className="flex items-center">
            <div className="bg-gray-100 border border-gray-200 rounded-lg px-3 py-1.5">
              <span className="text-sm text-gray-700 font-medium">
                {selectedApprover || dynamicBUFilterIds.length > 0 || dynamicDeptFilterIds.length > 0
                  ? t("pagination.found_plural", { count: sorted.length })
                  : t("totalRecords", { count: types.length })
                }
              </span>
            </div>
          </div>
        </div>

        {/* Action Row - Page size, Create button, View Log */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left side - Selected Filters Badges */}
          <div className="flex items-center gap-2 flex-wrap">
            {selectedApprover && (
              <div className="bg-orange-100 border border-orange-200 rounded-lg px-3 py-1.5">
                <span className="text-xs text-orange-600 font-medium">{t("filter.approver.filteringBy")}</span>
                <span className="text-sm text-orange-800 ml-1">{selectedApprover.name}</span>
              </div>
            )}
            {dynamicBUFilterIds.length > 0 && (
              <div className="bg-blue-100 border border-blue-200 rounded-lg px-3 py-1.5 flex items-center gap-2">
                <span className="text-xs text-blue-600 font-medium">BU:</span>
                <span className="text-sm text-blue-800">
                  {dynamicBUFilterIds.map(id => 
                    availableBusinessUnits.find(bu => bu.id === id)?.name
                  ).filter(Boolean).join(", ")}
                </span>
                <button
                  onClick={() => setDynamicBUFilterIds([])}
                  className="text-blue-600 hover:text-blue-800"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
            {dynamicDeptFilterIds.length > 0 && (
              <div className="bg-green-100 border border-green-200 rounded-lg px-3 py-1.5 flex items-center gap-2">
                <span className="text-xs text-green-600 font-medium">Dept:</span>
                <span className="text-sm text-green-800">
                  {dynamicDeptFilterIds.map(id => 
                    availableDepartments.find(dept => dept.id === id)?.name
                  ).filter(Boolean).join(", ")}
                </span>
                <button
                  onClick={() => setDynamicDeptFilterIds([])}
                  className="text-green-600 hover:text-green-800"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          {/* Right side - Page size, Create, View Log */}
          <div className="flex items-center gap-3">
            {/* page size select */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">{t("pageSize")}</span>
              <Listbox
                value={pageSize}
                onChange={(n) => {
                  setPageSize(n);
                  setCurrentPage(1);
                }}
              >
                <div className="relative w-20">
                  <Listbox.Button className="w-full border border-gray-300 rounded-lg px-2 py-1.5 flex justify-between items-center text-sm bg-white">
                    {pageSize === 0 ? "All" : pageSize} <BiChevronDown />
                  </Listbox.Button>
                  <Listbox.Options className="absolute mt-1 w-full bg-white shadow-lg rounded-lg overflow-auto z-10">
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <Listbox.Option
                        key={n}
                        value={n}
                        className={({ active, selected }) =>
                          `cursor-pointer px-2 py-1 text-sm ${active ? "bg-[#183e33] text-white" : "text-gray-700"
                          } ${selected ? "font-semibold" : ""}`
                        }
                      >
                        {n === 0 ? "All" : n}
                      </Listbox.Option>
                    ))}
                  </Listbox.Options>
                </div>
              </Listbox>
            </div>

            {/* create button */}
            <button
              onClick={() => ready && openModal("create")}
              disabled={!ready}
              className="bg-[#183e33] text-white px-4 py-2 rounded-lg hover:bg-[#141716] disabled:opacity-50 text-sm font-medium"
            >
              {t("btnCreate")}
            </button>

            {/* view log button */}
            <button
              onClick={() => setShowLogModal(true)}
              className="bg-gray-600 text-white px-4 py-2 rounded-lg hover:bg-gray-700 text-sm font-medium"
            >
              {t("viewLog")}
            </button>
          </div>
        </div>
      </div>
      {/* Responsive Card/Table Layout */}
      <div className="bg-white shadow-xl rounded-2xl overflow-hidden">
        {/* Desktop Table View */}
        <div className="hidden lg:block">
          <div className="overflow-x-auto">
            <table className="w-full table-fixed divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {/* # Column */}
                  <th className="w-12 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    #
                  </th>

                  {/* Name Column with Excel Filter */}
                  <th className="w-64 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                    <div className="flex items-center justify-normal">
                      <span className="flex items-center gap-1">
                        {t("col.name")}
                        {(columnFilters.name || sortColumn === "name") && (
                          <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                        )}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenFilterDropdown(openFilterDropdown === "name" ? null : "name");
                        }}
                        className="p-1 hover:bg-gray-200 rounded transition-colors"
                      >
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </div>
                    {/* Dropdown Menu */}
                    {openFilterDropdown === "name" && (
                      <div
                        ref={filterDropdownRef}
                        className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="p-2 border-b border-gray-100">
                          <button
                            onClick={() => handleSort("name", "asc")}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "name" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                            </svg>
                            {t("sort.az")}
                          </button>
                          <button
                            onClick={() => handleSort("name", "desc")}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "name" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                            </svg>
                            {t("sort.za")}
                          </button>
                          {sortColumn === "name" && (
                            <button
                              onClick={clearSort}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 text-red-600"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                              {t("sort.clear")}
                            </button>
                          )}
                        </div>
                        <div className="p-2">
                          <label className="block text-xs text-gray-500 mb-1">{t("filter.byText")}</label>
                          <input
                            type="text"
                            placeholder={t("filter.typeToFilter")}
                            value={columnFilters.name}
                            onChange={(e) => handleColumnFilterChange("name", e.target.value)}
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          {columnFilters.name && (
                            <button
                              onClick={() => clearColumnFilter("name")}
                              className="mt-2 w-full flex items-center justify-center gap-1 px-3 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                              {t("filter.clearFilter")}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </th>

                  {/* Business Unit Column with Excel Filter */}
                  <th className="w-32 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1">
                        {t("col.bu")}
                        {(dynamicBUFilterIds.length > 0 || sortColumn === "businessUnit") && (
                          <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                        )}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenFilterDropdown(openFilterDropdown === "businessUnit" ? null : "businessUnit");
                        }}
                        className="p-1 hover:bg-gray-200 rounded transition-colors"
                      >
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </div>
                    {openFilterDropdown === "businessUnit" && (
                      <div
                        ref={filterDropdownRef}
                        className="absolute top-full left-0 mt-1 w-96 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="p-2 border-b border-gray-100">
                          <button
                            onClick={() => handleSort("businessUnit", "asc")}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "businessUnit" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                            </svg>
                            {t("sort.az")}
                          </button>
                          <button
                            onClick={() => handleSort("businessUnit", "desc")}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "businessUnit" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                            </svg>
                            {t("sort.za")}
                          </button>
                          {sortColumn === "businessUnit" && (
                            <button
                              onClick={clearSort}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 text-red-600"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                              {t("sort.clear")}
                            </button>
                          )}
                        </div>
                        <div className="p-2">
                          <label className="block text-xs font-medium text-gray-700 mb-2">{t("filter.filterByBUCol")}</label>
                          <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg bg-gray-50">
                            <div className="p-2 space-y-1">
                              {availableBusinessUnits.map((bu) => (
                                <label
                                  key={bu.id}
                                  className="flex items-center gap-2 px-2 py-1.5 hover:bg-white rounded cursor-pointer"
                                >
                                  <input
                                    type="checkbox"
                                    checked={dynamicBUFilterIds.includes(bu.id)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setDynamicBUFilterIds([...dynamicBUFilterIds, bu.id]);
                                      } else {
                                        setDynamicBUFilterIds(dynamicBUFilterIds.filter(id => id !== bu.id));
                                      }
                                    }}
                                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                                  />
                                  <span className="text-sm text-gray-700">{bu.name}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                          {dynamicBUFilterIds.length > 0 && (
                            <button
                              onClick={() => {
                                setDynamicBUFilterIds([]);
                                setOpenFilterDropdown(null);
                              }}
                              className="mt-2 w-full flex items-center justify-center gap-1 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded border border-red-200"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                              {t("filter.nSelectedClear", { count: dynamicBUFilterIds.length })}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </th>

                  {/* Department Column with Excel Filter */}
                  <th className="w-32 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1">
                        {t("col.dept")}
                        {(dynamicDeptFilterIds.length > 0 || sortColumn === "department") && (
                          <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                        )}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenFilterDropdown(openFilterDropdown === "department" ? null : "department");
                        }}
                        className="p-1 hover:bg-gray-200 rounded transition-colors"
                      >
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </div>
                    {openFilterDropdown === "department" && (
                      <div
                        ref={filterDropdownRef}
                        className="absolute top-full left-0 mt-1 w-96 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="p-2 border-b border-gray-100">
                          <button
                            onClick={() => handleSort("department", "asc")}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "department" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                            </svg>
                            {t("sort.az")}
                          </button>
                          <button
                            onClick={() => handleSort("department", "desc")}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "department" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                            </svg>
                            {t("sort.za")}
                          </button>
                          {sortColumn === "department" && (
                            <button
                              onClick={clearSort}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 text-red-600"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                              {t("sort.clear")}
                            </button>
                          )}
                        </div>
                        <div className="p-2">
                          <label className="block text-xs font-medium text-gray-700 mb-2">
                            {dynamicBUFilterIds.length > 0
                              ? t(dynamicBUFilterIds.length > 1 ? "filter.filterByDeptWithBUs" : "filter.filterByDeptWithBU", { count: dynamicBUFilterIds.length })
                              : t("filter.filterByDeptCol")}
                          </label>
                          {(() => {
                            // Calculate available departments based on selected BUs directly from types
                            const deptMap = new Map<number, { id: number; name: string }>();
                            
                            types.forEach((t) => {
                              // Only include departments from selected BUs (or all if no BU selected)
                              if (dynamicBUFilterIds.length === 0 || (t.businessUnit?.id && dynamicBUFilterIds.includes(t.businessUnit.id))) {
                                if (t.department?.id && t.department?.name) {
                                  deptMap.set(t.department.id, {
                                    id: t.department.id,
                                    name: t.department.name,
                                  });
                                }
                              }
                            });
                            
                            const availableDepts = Array.from(deptMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'th-TH'));
                            
                            return (
                              <>
                                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg bg-gray-50">
                                  <div className="p-2 space-y-1">
                                    {availableDepts.map((dept) => (
                                      <label
                                        key={dept.id}
                                        className="flex items-center gap-2 px-2 py-1.5 hover:bg-white rounded cursor-pointer"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={dynamicDeptFilterIds.includes(dept.id)}
                                          onChange={(e) => {
                                            if (e.target.checked) {
                                              setDynamicDeptFilterIds([...dynamicDeptFilterIds, dept.id]);
                                            } else {
                                              setDynamicDeptFilterIds(dynamicDeptFilterIds.filter(id => id !== dept.id));
                                            }
                                          }}
                                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                                        />
                                        <span className="text-sm text-gray-700">{dept.name}</span>
                                      </label>
                                    ))}
                                  </div>
                                </div>
                                {availableDepts.length === 0 && (
                                  <p className="mt-2 text-xs text-gray-500 italic text-center py-4">
                                    {dynamicBUFilterIds.length > 0
                                      ? t("filter.noDeptInBU")
                                      : t("filter.noDeptAny")}
                                  </p>
                                )}
                                {dynamicDeptFilterIds.length > 0 && (
                                  <button
                                    onClick={() => {
                                      setDynamicDeptFilterIds([]);
                                      setOpenFilterDropdown(null);
                                    }}
                                    className="mt-2 w-full flex items-center justify-center gap-1 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded border border-red-200"
                                  >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                    {t("filter.nSelectedClear", { count: dynamicDeptFilterIds.length })}
                                  </button>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                  </th>

                  {/* Status Column with Excel Filter */}
                  <th className="w-32 px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1">
                        {t("col.status")}
                        {(columnFilters.status || sortColumn === "status") && (
                          <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                        )}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenFilterDropdown(openFilterDropdown === "status" ? null : "status");
                        }}
                        className="p-1 hover:bg-gray-200 rounded transition-colors"
                      >
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </div>
                    {openFilterDropdown === "status" && (
                      <div
                        ref={filterDropdownRef}
                        className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="p-2 border-b border-gray-100">
                          <button
                            onClick={() => handleSort("status", "asc")}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "status" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                            </svg>
                            {t("sort.activeFirst")}
                          </button>
                          <button
                            onClick={() => handleSort("status", "desc")}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "status" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                            </svg>
                            {t("sort.inactiveFirst")}
                          </button>
                          {sortColumn === "status" && (
                            <button
                              onClick={clearSort}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 text-red-600"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                              {t("sort.clear")}
                            </button>
                          )}
                        </div>
                        <div className="p-2">
                          <label className="block text-xs text-gray-500 mb-1">{t("filter.status.label")}</label>
                          <select
                            value={columnFilters.status || "all"}
                            onChange={(e) => handleColumnFilterChange("status", e.target.value)}
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="all">{t("filter.status.all")}</option>
                            <option value="active">{t("filter.status.active")}</option>
                            <option value="inactive">{t("filter.status.inactive")}</option>
                          </select>
                          {columnFilters.status && columnFilters.status !== "all" && (
                            <button
                              onClick={() => clearColumnFilter("status")}
                              className="mt-2 w-full flex items-center justify-center gap-1 px-3 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                              {t("filter.clearFilter")}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </th>



                  {/* Approvers Column with Excel Filter */}
                  <th className="flex-1 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                    <div className="flex items-center justify-normal">
                      <span className="flex items-center gap-1">
                        {t("col.approvers")}
                        {(columnFilters.approvers || sortColumn === "approvers") && (
                          <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                        )}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenFilterDropdown(openFilterDropdown === "approvers" ? null : "approvers");
                          }}
                          className="p-1 hover:bg-gray-200 rounded transition-colors"
                        >
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                          </svg>
                        </button>
                        {hasActiveFilters && (
                          <button
                            onClick={clearAllFilters}
                            className="text-xs text-red-600 hover:text-red-700 flex items-center gap-1"
                            title={t("filter.clearAll")}
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            {t("filter.clearAll")}
                          </button>
                        )}
                      </div>
                    </div>
                    {openFilterDropdown === "approvers" && (
                      <div
                        ref={filterDropdownRef}
                        className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="p-2 border-b border-gray-100">
                          <button
                            onClick={() => handleSort("approvers", "asc")}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "approvers" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                            </svg>
                            {t("sort.levelCount")}
                          </button>
                          <button
                            onClick={() => handleSort("approvers", "desc")}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "approvers" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                            </svg>
                            {t("sort.levelCountDesc")}
                          </button>
                          {sortColumn === "approvers" && (
                            <button
                              onClick={clearSort}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 text-red-600"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                              {t("sort.clear")}
                            </button>
                          )}
                        </div>
                        <div className="p-2">
                          <label className="block text-xs text-gray-500 mb-1">{t("filter.approver.label")}</label>
                          <input
                            type="text"
                            placeholder={t("filter.approver.placeholder")}
                            value={columnFilters.approvers || ""}
                            onChange={(e) => handleColumnFilterChange("approvers", e.target.value)}
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          {columnFilters.approvers && (
                            <button
                              onClick={() => clearColumnFilter("approvers")}
                              className="mt-2 w-full flex items-center justify-center gap-1 px-3 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                              {t("filter.clearFilter")}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </th>

                  {/* Actions Column */}
                  <th className="w-24 px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {t("col.actions")}
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                      {t("loading", "Loading...")}
                    </td>
                  </tr>
                ) : paginated.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                      <div className="flex flex-col items-center">
                        <svg
                          className="w-10 h-10 text-gray-300 mb-3"
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
                        <p className="font-medium">{t("noData", "No data found")}</p>
                        <p className="text-xs text-gray-400">Try adjusting your search criteria</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  paginated.map((item, index) => {
                    // Get approval line data for this memo type by matching approvalLineId
                    const matchedApprovalLine = item.approvalLineId
                      ? approvalLines.find(line => line.id === item.approvalLineId)
                      : null;

                    return (
                      <tr 
                        key={item.id} 
                        className={`transition-colors cursor-pointer ${
                          editedMemoTypeIds.has(item.id) 
                            ? "bg-green-50 hover:bg-green-100" 
                            : "hover:bg-gray-50"
                        }`}
                        onClick={() => openModal("edit", item)}
                      >
                        {/* Row Number */}
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="text-xs font-medium text-gray-500">{index + 1}</div>
                        </td>
                        {/* Name */}
                        <td className="px-3 py-2">
                          <div className="text-sm font-medium text-gray-900 line-clamp-2" title={item.name}>
                            {item.name}
                          </div>
                        </td>
                        {/* Business Unit */}
                        <td className="px-3 py-2">
                          <div className="text-xs text-gray-900 truncate" title={item.businessUnit?.name ?? "-"}>
                            {item.businessUnit?.name ?? "-"}
                          </div>
                        </td>
                        {/* Department */}
                        <td className="px-3 py-2">
                          <div className="text-xs text-gray-900 truncate" title={item.department?.name ?? "-"}>
                            {item.department?.name ?? "-"}
                          </div>
                        </td>
                        {/* Status */}
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-1 items-start">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${item.isActive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                              }`}>
                              {item.isActive ? t("status.active") : t("status.inactive")}
                            </span>
                            {item.forAllDepartmentUnderSelectedBu && (
                              <span 
                                className="text-[10.5px] font-medium text-gray-400 leading-none mt-0.5" 
                                title="For All Departments Under Selected BU"
                              >
                                All Depts (BU)
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Approvers */}
                        <td className="px-3 py-2">
                          <div className="text-xs text-gray-900">
                            {item.approvalLevels && item.approvalLevels.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {item.approvalLevels.map((level: any, levelIdx: number) => {
                                  // Determine approval requirement for this level
                                  const approvalReq = level.users.length > 1
                                    ? (level.users[0]?.approvalRequirement || "ALL")
                                    : "ALL";

                                  return (
                                    <div
                                      key={levelIdx}
                                      className="bg-white border border-gray-200 rounded-lg p-2 shadow-sm min-w-0 flex-shrink-0"
                                    >
                                      {/* Level Header with Approval Requirement */}
                                      <div className="flex items-center justify-between mb-2 pb-1 border-b border-gray-100">
                                        <div className="flex items-center gap-2">
                                          <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-semibold bg-blue-600 text-white">
                                            {t("approval.level")} {level.level + 1}
                                          </span>
                                          <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium border ${approvalReq === "ANY"
                                            ? "bg-orange-50 text-orange-700 border-orange-200"
                                            : "bg-green-50 text-green-700 border-green-200"
                                            }`}>
                                            {approvalReq === "ANY" ? t("badgeAny", "Any") : t("badgeAll", "All")}
                                          </span>
                                        </div>
                                      </div>

                                      {/* Approvers List */}
                                      <div className="flex flex-wrap gap-1">
                                        {level.users.map((user: any, idx: number) => {
                                          const slotDisplay = getSlotTypeDisplay(user.slotType);
                                          const hasUser = user.name;
                                          const userName = hasUser
                                            ? `${user.name || ''} ${user.lastname || ''}`.trim()
                                            : null;

                                          return (
                                            <div key={idx} className="flex items-center gap-1">
                                              {userName ? (
                                                <span className="inline-flex items-center px-2 py-1 rounded-md bg-gray-100 text-xs font-medium text-gray-800 border" title={userName}>
                                                  {userName.length > 12 ? `${userName.substring(0, 12)}...` : userName}
                                                </span>
                                              ) : (
                                                <span
                                                  className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${slotDisplay.badgeClass}`}
                                                  title={slotDisplay.text}
                                                >
                                                  {slotDisplay.text}
                                                </span>
                                              )}
                                              {user.isSigReq && (
                                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-200" title="Signature Required">
                                                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                                    <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                                                  </svg>
                                                </span>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : matchedApprovalLine && matchedApprovalLine.approvalUsers && matchedApprovalLine.approvalUsers.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {(() => {
                                  // Group approvers by level
                                  const groupedByLevel: Record<number, any[]> = {};
                                  matchedApprovalLine.approvalUsers.forEach((approvalUser: any) => {
                                    const level = approvalUser.level ?? 0;
                                    if (!groupedByLevel[level]) groupedByLevel[level] = [];
                                    groupedByLevel[level].push(approvalUser);
                                  });

                                  return Object.entries(groupedByLevel)
                                    .sort(([a], [b]) => parseInt(a) - parseInt(b))
                                    .map(([level, users]) => {
                                      // Determine approval requirement for this level
                                      const approvalReq = users.length > 1
                                        ? (users[0]?.approvalRequirement || "ALL")
                                        : "ALL";

                                      return (
                                        <div
                                          key={level}
                                          className="bg-white border border-gray-200 rounded-lg p-2 shadow-sm min-w-0 flex-shrink-0"
                                        >
                                          {/* Level Header with Approval Requirement */}
                                          <div className="flex items-center justify-between mb-2 pb-1 border-b border-gray-100">
                                            <div className="flex items-center gap-2">
                                              <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-semibold bg-blue-600 text-white">
                                                {t("approval.level")} {parseInt(level) + 1}
                                              </span>
                                              <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium border ${approvalReq === "ANY"
                                                ? "bg-orange-50 text-orange-700 border-orange-200"
                                                : "bg-green-50 text-green-700 border-green-200"
                                                }`}>
                                                {approvalReq === "ANY" ? t("badgeAny", "Any") : t("badgeAll", "All")}
                                              </span>
                                            </div>
                                          </div>

                                          {/* Approvers List */}
                                          <div className="flex flex-wrap gap-1">
                                            {users.map((approvalUser: any, idx: number) => {
                                              const slotDisplay = getSlotTypeDisplay(approvalUser.slotType);
                                              const hasUser = approvalUser.user && approvalUser.user.name;
                                              const userName = hasUser
                                                ? `${approvalUser.user.name || ''} ${approvalUser.user.lastname || ''}`.trim()
                                                : null;

                                              return (
                                                <div key={idx} className="flex items-center gap-1">
                                                  {userName ? (
                                                    <span className="inline-flex items-center px-2 py-1 rounded-md bg-gray-100 text-xs font-medium text-gray-800 border" title={userName}>
                                                      {userName.length > 12 ? `${userName.substring(0, 12)}...` : userName}
                                                    </span>
                                                  ) : (
                                                    <span
                                                      className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${slotDisplay.badgeClass}`}
                                                      title={slotDisplay.text}
                                                    >
                                                      {slotDisplay.text}
                                                    </span>
                                                  )}
                                                  {approvalUser.isSigReq && (
                                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-200" title="Signature Required">
                                                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                                        <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                                                      </svg>
                                                    </span>
                                                  )}
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      );
                                    });
                                })()}
                              </div>
                            ) : item.approvalLine ? (
                              <span className="text-gray-400 text-xs">{t("noApprovers", "No Approvers")}</span>
                            ) : (
                              <span className="text-gray-400 text-xs">{t("noLine", "No approval line")}</span>
                            )}
                          </div>
                        </td>
                        {/* Actions */}
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center space-x-2">
                            {(item.isDelete || !item.isActive) && (
                            <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleToggleHidden(item);
                                }}
                                title={item.isDelete ? "Click to Restore" : "Click to Delete"}
                                className={`${item.isDelete ? "text-gray-500 hover:text-gray-700" : "text-red-500 hover:text-red-700"} transition-colors`}
                            >
                              <FontAwesomeIcon icon={item.isDelete ? faClockRotateLeft : faTrash} className="w-4 h-4" />
                            </button>
                            )}
                            <button
                              onClick={() => openModal("duplicate", item)}
                              title="Duplicate"
                              className="text-emerald-600 hover:text-emerald-800 transition-colors"
                            >
                              <FontAwesomeIcon icon={faCopy} className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => openModal("edit", item)}
                              title="Edit"
                              className="text-blue-600 hover:text-blue-800 transition-colors"
                            >
                              <FontAwesomeIcon icon={faPenToSquare} className="w-4 h-4" />
                            </button>

                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Mobile/Tablet Card View */}
        <div className="lg:hidden">
          {loading ? (
            <div className="text-center py-8 text-gray-500">
              {t("loading", "Loading...")}
            </div>
          ) : paginated.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              {t("noData", "No data found")}
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {paginated.map((item) => (
                <div key={item.id} className="p-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <h3 className="text-lg font-medium text-gray-900 truncate">
                          {item.name}
                        </h3>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          {item.abbreviation}
                        </span>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${item.isActive
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                          }`}>
                          {item.isActive ? t("status.active", "Active") : t("status.inactive", "Inactive")}
                        </span>
                      </div>

                      <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                        {item.description}
                      </p>

                      <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                        <div>
                          <span className="text-gray-500">{t("col.id")}:</span>
                          <span className="ml-1 text-gray-900">{item.id}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">{t("col.dept")}:</span>
                          <span className="ml-1 text-gray-900">{item.department?.name ?? "-"}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">{t("col.bu")}:</span>
                          <span className="ml-1 text-gray-900">{item.businessUnit?.name ?? "-"}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">{t("col.createdAt")}:</span>
                          <span className="ml-1 text-gray-900">{fmtAD.format(parseDbDate(item.createdAt))}</span>
                        </div>
                      </div>

                      {/* Approvers Section for Mobile */}
                      <div className="border-t pt-3">
                        <div className="text-sm font-medium text-gray-700 mb-2">{t("col.approvers")}:</div>
                        <div className="text-xs text-gray-900">
                          {item.approvalLevels && item.approvalLevels.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {item.approvalLevels.map((level: any, levelIdx: number) => {
                                const approvalReq = level.users.length > 1
                                  ? (level.users[0]?.approvalRequirement || "ALL")
                                  : "ALL";

                                return (
                                  <div
                                    key={levelIdx}
                                    className="bg-white border border-gray-200 rounded-lg p-2 shadow-sm min-w-0 flex-shrink-0"
                                  >
                                    <div className="flex items-center justify-between mb-2 pb-1 border-b border-gray-100">
                                      <div className="flex items-center gap-2">
                                        <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-semibold bg-blue-600 text-white">
                                          {t("approval.level")} {level.level + 1}
                                        </span>
                                        <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium border ${approvalReq === "ANY"
                                          ? "bg-orange-50 text-orange-700 border-orange-200"
                                          : "bg-green-50 text-green-700 border-green-200"
                                          }`}>
                                          {approvalReq === "ANY" ? t("badgeAny", "Any") : t("badgeAll", "All")}
                                        </span>
                                      </div>
                                    </div>

                                    <div className="flex flex-wrap gap-1">
                                      {level.users.map((user: any, idx: number) => {
                                        const slotDisplay = getSlotTypeDisplay(user.slotType);
                                        const hasUser = user.name;
                                        const userName = hasUser
                                          ? `${user.name || ''} ${user.lastname || ''}`.trim()
                                          : null;

                                        return (
                                          <div key={idx} className="flex items-center gap-1">
                                            {userName ? (
                                              <span className="inline-flex items-center px-2 py-1 rounded-md bg-gray-100 text-xs font-medium text-gray-800 border" title={userName}>
                                                {userName.length > 12 ? `${userName.substring(0, 12)}...` : userName}
                                              </span>
                                            ) : (
                                              <span
                                                className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${slotDisplay.badgeClass}`}
                                                title={slotDisplay.text}
                                              >
                                                {slotDisplay.text}
                                              </span>
                                            )}
                                            {user.isSigReq && (
                                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-200" title="Signature Required">
                                                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                                  <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                                                </svg>
                                              </span>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : item.approvalLine ? (
                            <span className="text-gray-400 text-xs">No Approvers</span>
                          ) : (
                            <span className="text-gray-400 text-xs">No approval line</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col space-y-2 ml-4">
                      {(item.isDelete || !item.isActive) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleHidden(item);
                        }}
                        className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${item.isDelete ? "text-gray-400 hover:text-gray-600 bg-gray-50" : "text-red-600 hover:text-red-800 hover:bg-red-50"}`}
                        title={item.isDelete ? "Click to Restore" : "Click to Delete"}
                      >
                         <FontAwesomeIcon icon={item.isDelete ? faTrash : faEyeSlash} className="w-4 h-4" />
                      </button>
                      )}
                      <button
                        onClick={() => openModal("duplicate", item)}
                        className="flex items-center justify-center w-8 h-8 text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50 rounded-full transition-colors"
                        title="Duplicate"
                      >
                        <FontAwesomeIcon icon={faCopy} className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => openModal("edit", item)}
                        className="flex items-center justify-center w-8 h-8 text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-full transition-colors"
                        title="Edit"
                      >
                        <FontAwesomeIcon icon={faPenToSquare} className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(item.id)}
                        className="flex items-center justify-center w-8 h-8 text-red-600 hover:text-red-800 hover:bg-red-50 rounded-full transition-colors"
                        title="Delete"
                      >
                        <FontAwesomeIcon icon={faTrash} className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {/* pagination */}
      {!isAll && totalPages > 1 && (
        <div className="flex justify-center flex-wrap gap-2 mt-4">
          {/* Prev */}
          <button
            className="px-3 py-1 rounded border text-sm font-medium bg-white text-green-900 border-gray-300 disabled:opacity-40"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
          >
            {t("pagination.prev")}
          </button>

          {/* windowed numbers */}
          {makePageWindow(currentPage, totalPages, 1).map((p, idx) =>
            p === "..." ? (
              <span
                key={`dots-${idx}`}
                className="px-2 text-gray-500 select-none"
              >
                …
              </span>
            ) : (
              <button
                key={`p-${p}`}
                className={`px-3 py-1 rounded border text-sm font-medium ${currentPage === p
                  ? "bg-[#183e33] text-white"
                  : "bg-white text-green-900 border-gray-300 hover:bg-gray-100"
                  }`}
                onClick={() => setCurrentPage(p as number)}
              >
                {p}
              </button>
            )
          )}

          {/* Next */}
          <button
            className="px-3 py-1 rounded border text-sm font-medium bg-white text-green-900 border-gray-300 disabled:opacity-40"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
          >
            {t("pagination.next")}
          </button>
        </div>
      )}

      {/* modal */}
      {modalMode && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center overflow-y-auto p-4">
          <div className="bg-white border border-[#183e33] rounded-xl shadow-2xl p-8 w-full max-w-lg pointer-events-auto relative animate-fade-in drop-shadow-lg">
            {/* close button */}
            <button
              className="absolute top-3 right-3 text-green-500 hover:text-red-500 text-xl font-bold"
              onClick={closeModal}
              disabled={isSubmitting}
            >
              ✕
            </button>

            <h2 className="text-2xl font-bold text-center mb-6 text-[#183e33]">
              {modalMode === "create"
                ? t("modal.create")
                : modalMode === "edit"
                  ? t("modal.edit")
                  : t("modal.duplicate", "Duplicate")}
            </h2>

            <form className="grid grid-cols-1 gap-4" onSubmit={handleSubmit}>
              {/* ---------- Basic fields ---------- */}
              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("label.name")}
                </label>
                <input
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-[#183e33] rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 text-gray-700"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("label.abbr")}
                </label>
                <input
                  name="abbreviation"
                  value={form.abbreviation}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-[#183e33] rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 text-gray-700"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("label.desc")}
                </label>
                <textarea
                  name="description"
                  value={form.description}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-[#183e33] rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 text-gray-700"
                  required
                />
              </div>



              {/* ---------- Toggle for forAllDepartmentUnderSelectedBu ---------- */}
              <div className="bg-gradient-to-r from-blue-50 to-blue-100 border border-blue-200 rounded-xl p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-blue-800 mb-1">
                      {t("toggle.forAllDeptUnderBu")}
                    </span>
                    <span className="text-xs text-blue-600">
                      {form.forAllDepartmentUnderSelectedBu
                        ? t("toggle.forAllDeptUnderBuDesc")
                        : t("toggle.forAllDeptUnderBuDescOff")}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${form.forAllDepartmentUnderSelectedBu ? 'bg-blue-200 text-blue-800' : 'bg-gray-200 text-gray-600'}`}>
                      {form.forAllDepartmentUnderSelectedBu ? "ON" : "OFF"}
                    </span>
                    <label className="toggle-switch-container">
                      <input
                        type="checkbox"
                        checked={!!form.forAllDepartmentUnderSelectedBu}
                        onChange={(e) => {
                          setForm((prev) => ({
                            ...prev,
                            forAllDepartmentUnderSelectedBu: e.target.checked,
                            // Clear other scope flags when this is enabled
                            forEveryone: false,
                            forEveryDepartmentAcrossBU: false,
                          }));
                        }}
                      />
                      <span className="toggle-switch-track"></span>
                    </label>
                  </div>
                </div>
              </div>

              {/* ---------- Business Unit (always visible) ---------- */}
              <div>
                <label className="block text-sm font-semibold mb-1 text-green-700">
                  {t("label.bu")}
                </label>
                <select
                  name="businessUnitId"
                  value={form.businessUnitId ?? ""}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-[#183e33] rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                  required
                >
                  <option value="">{t("optional.selectNone")}</option>
                  {businessUnits.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* ---------- Department (always visible) ---------- */}
              <div>
                <label className="block text-sm font-semibold mb-1 text-green-700">
                  {t("label.department")}
                </label>
                <Listbox
                  value={form.departmentId ?? null}
                  onChange={(val) => {
                    setForm((prev) => ({
                      ...prev,
                      departmentId: val ?? undefined,
                    }));
                  }}
                >
                  {({ open }) => (
                    <div className="relative">
                      <Listbox.Button className="w-full px-3 py-2 border border-[#183e33] rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 text-left bg-white flex items-center justify-between">
                        <span className={form.departmentId ? "text-gray-900" : "text-gray-500"}>
                          {form.departmentId
                            ? departments.find((d) => d.id === form.departmentId)?.name || t("optional.selectNone")
                            : t("optional.selectNone")}
                        </span>
                        <BiChevronDown className={`w-5 h-5 transition-transform ${open ? "rotate-180" : ""}`} />
                      </Listbox.Button>
                      <Listbox.Options className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-auto">
                        <Listbox.Option
                          value={null}
                          className={({ active }) =>
                            `cursor-pointer select-none relative py-2 px-3 ${
                              active ? "bg-green-100 text-green-900" : "text-gray-900"
                            }`
                          }
                        >
                          {t("optional.selectNone")}
                        </Listbox.Option>
                        {departments.map((d) => (
                          <Listbox.Option
                            key={d.id}
                            value={d.id}
                            className={({ active }) =>
                              `cursor-pointer select-none relative py-2 px-3 ${
                                active ? "bg-green-100 text-green-900" : "text-gray-900"
                              }`
                            }
                          >
                            {d.name}
                          </Listbox.Option>
                        ))}
                      </Listbox.Options>
                    </div>
                  )}
                </Listbox>
                {form.forAllDepartmentUnderSelectedBu && (
                  <p className="text-xs text-blue-600 mt-1">
                    {t("hints.underBuOnly", "Optional when 'For All Departments Under Selected BU' is enabled")}
                  </p>
                )}
              </div>

              {/* ---------- Team / Department ---------- */}

              {/* ---------- Line of Approval Information ---------- */}
              {(modalMode === "edit" || modalMode === "duplicate") && form.id && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-blue-800 mb-2">
                    {t("approval.lineInfo", "Line of Approval Information")}
                  </h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-blue-600 font-medium">ID:</span>
                      <span className="ml-2 text-blue-900">
                        {types.find(type => type.id === form.id)?.approvalLineId || "N/A"}
                      </span>
                    </div>
                    <div>
                      <span className="text-blue-600 font-medium">Name:</span>
                      <span className="ml-2 text-blue-900">
                        {types.find(type => type.id === form.id)?.approvalLine?.name ||
                          types.find(type => type.id === form.id)?.name || "N/A"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* ---------- Active Toggle ---------- */}
              {!form.isDelete && (
                <div className="bg-gradient-to-r from-gray-50 to-gray-100 border border-gray-200 rounded-xl p-5 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold text-gray-800 mb-1">
                        {t("label.active")}
                      </span>
                      <span className="text-xs text-gray-500">
                        {form.isActive
                          ? t("status.activeDesc", "This memo type is available for use")
                          : t("status.inactiveDesc", "This memo type is disabled")}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`toggle-status-badge ${form.isActive ? 'active' : 'inactive'}`}>
                        {form.isActive ? t("status.active") : t("status.inactive")}
                      </span>
                      <label className="toggle-switch-container">
                        <input
                          type="checkbox"
                          id="isActive"
                          name="isActive"
                          checked={form.isActive}
                          onChange={handleChange}
                        />
                        <span className="toggle-switch-track"></span>
                      </label>
                    </div>
                  </div>
                </div>
              )}



              {/* ---------- Approval Line ---------- */}
              <div className="mt-6">
                <div className="rounded-xl p-6 bg-white">
                  <div className="mb-4">
                    <div className="text-lg font-bold text-[#183e33]">
                      {t("approval.title")}
                    </div>
                  </div>

                  <div className="mt-4 space-y-4">
                    {approvalLevels.map((lv, idx) => (
                      <React.Fragment key={idx}>
                        {/* Insert Level Button - appears between levels */}
                        {idx > 0 && (
                          <div className="relative flex items-center justify-center py-2 group">
                            <div className="absolute inset-0 flex items-center">
                              <div className="w-full border-t-2 border-dashed border-emerald-300 group-hover:border-emerald-500 transition-colors"></div>
                            </div>
                            <button
                              type="button"
                              onClick={() => insertLevelAt(idx)}
                              className="relative z-10 flex items-center justify-center w-8 h-8 rounded-full bg-emerald-500 border-2 border-emerald-600 text-white hover:bg-emerald-600 hover:border-emerald-700 transition-all duration-200 shadow-md hover:shadow-lg"
                              title={t("approval.insertLevel", "Insert level here")}
                            >
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" />
                              </svg>
                            </button>
                          </div>
                        )}
                        <div className="rounded-xl border border-gray-300 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
                          {/* Level Header - Simplified without Flexible Level checkbox */}
                          <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-200">
                            <div className="flex items-center gap-2">
                              <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-[#183e33] text-white font-bold text-sm">
                                {idx + 1}
                              </span>
                              <span className="font-semibold text-gray-800 text-lg">
                                {t("approval.level")} {idx + 1}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeLevel(idx)}
                              className="flex items-center justify-center w-8 h-8 rounded-full text-red-500 hover:bg-red-50 hover:text-red-700 transition-colors"
                              title={t("approval.removeLevel")}
                            >
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>

                          {/* Approval Requirement Selector - Show when multiple approvers */}
                          {(lv.approvers?.length || 0) > 1 && (
                            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg mb-4">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                  </svg>
                                  <label className="text-sm font-semibold text-amber-800">
                                    {t("approval.approvalRequirement", "Approval Requirement")}
                                  </label>
                                </div>
                                <select
                                  value={lv.approvalRequirement || "ALL"}
                                  onChange={(e) =>
                                    setApprovalLevels((prev) => {
                                      const copy = [...prev];
                                      copy[idx] = {
                                        ...copy[idx],
                                        approvalRequirement: e.target.value as "ALL" | "ANY",
                                      };
                                      return copy;
                                    })
                                  }
                                  className="px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500 font-medium"
                                >
                                  <option value="ALL">{t("approval.allMustApprove", "All Approvers Must Approve")}</option>
                                  <option value="ANY">{t("approval.anyCanApprove", "Any Approver Can Approve")}</option>
                                </select>
                              </div>
                            </div>
                          )}

                          {/* Unified Approvers Section */}
                          <div className="space-y-4">
                            <label className="block text-sm font-semibold text-gray-700">
                              {t("approval.approvers")}
                            </label>

                            {/* List of Approvers (both fixed and flexible) */}
                            {(lv.approvers?.length || 0) > 0 && (
                              <div className="space-y-3">
                                {lv.approvers?.map((approver) => (
                                  <div
                                    key={approver.id}
                                    className={`rounded-lg border px-4 py-3 ${
                                      approver.type === "flexible"
                                        ? "bg-orange-50 border-orange-200"
                                        : "bg-white border-gray-200"
                                    }`}
                                  >
                                    <div className="flex items-center justify-between mb-3">
                                      <div className="flex items-center gap-3">
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                                          approver.type === "flexible"
                                            ? "bg-orange-100"
                                            : "bg-emerald-100"
                                        }`}>
                                          {approver.type === "flexible" ? (
                                            <svg className="w-4 h-4 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                                            </svg>
                                          ) : (
                                            <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                            </svg>
                                          )}
                                        </div>
                                        <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                                          approver.type === "flexible"
                                            ? "bg-orange-100 text-orange-700"
                                            : "bg-emerald-100 text-emerald-700"
                                        }`}>
                                          {approver.type === "flexible"
                                            ? t("approval.flexibleSlotLabel", "Flexible Slot")
                                            : t("approval.fixedUser", "Fixed User")}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-3">
                                        {/* Signature Toggle */}
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs text-gray-500">
                                            {approver.isSigReq
                                              ? t("approval.sigRequired")
                                              : t("approval.sigNotRequired")}
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => updateApprover(idx, approver.id, { isSigReq: !approver.isSigReq })}
                                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                              approver.isSigReq ? "bg-emerald-500" : "bg-gray-300"
                                            }`}
                                            title={t("approval.toggleSigReq")}
                                          >
                                            <span
                                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow ${
                                                approver.isSigReq ? "translate-x-6" : "translate-x-1"
                                              }`}
                                            />
                                          </button>
                                        </div>
                                        {/* Remove Button */}
                                        <button
                                          type="button"
                                          onClick={() => removeApprover(idx, approver.id)}
                                          className="flex items-center justify-center w-7 h-7 rounded-full text-red-500 hover:bg-red-100 hover:text-red-700 transition-colors"
                                          title={t("approval.removeApprover", "Remove approver")}
                                        >
                                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                                          </svg>
                                        </button>
                                      </div>
                                    </div>

                                    {/* Approver Content */}
                                    <div className="ml-11 space-y-3">
                                      {approver.type === "fixed" ? (
                                        /* Fixed User - User Selector */
                                        <>
                                          <AsyncSelect<{ value: number; label: string }, false>
                                            cacheOptions
                                            defaultOptions
                                            loadOptions={makeLoadOptionsForApprover(idx, approver.id)}
                                            value={approver.userId ? { value: approver.userId, label: approver.userLabel || "" } : null}
                                            onChange={(opt) => {
                                              if (opt) {
                                                updateApprover(idx, approver.id, {
                                                  userId: opt.value,
                                                  userLabel: opt.label,
                                                });
                                              }
                                            }}
                                            placeholder={t("approval.selectUserPh", "Select user...")}
                                            styles={{
                                              control: (base) => ({
                                                ...base,
                                                borderColor: '#d1d5db',
                                                borderRadius: '0.5rem',
                                                padding: '2px',
                                                '&:hover': {
                                                  borderColor: '#10b981',
                                                },
                                              }),
                                              placeholder: (base) => ({
                                                ...base,
                                                color: '#9ca3af',
                                              }),
                                            }}
                                          />
                                          {/* Role Input for Fixed User */}
                                          <input
                                            type="text"
                                            placeholder={t("approval.roleNamePh", "Role name (optional)")}
                                            value={approver.roleDescription || ""}
                                            onChange={(e) => updateApprover(idx, approver.id, { roleDescription: e.target.value })}
                                            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-emerald-400"
                                          />
                                        </>
                                      ) : (
                                        /* Flexible Slot - Role Input Only */
                                        <input
                                          type="text"
                                          placeholder={t("approval.slotRolePh", "Role name (e.g., Department Head, Project Manager)")}
                                          value={approver.roleDescription || ""}
                                          onChange={(e) => updateApprover(idx, approver.id, { roleDescription: e.target.value })}
                                          className="w-full rounded-lg border border-orange-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-orange-400 bg-white"
                                        />
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Empty State */}
                            {(lv.approvers?.length || 0) === 0 && (
                              <div className="text-center py-6 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
                                <svg className="w-10 h-10 mx-auto text-gray-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                </svg>
                                <p className="text-sm text-gray-500">
                                  {t("approval.noApproversYet", "No approvers added yet. Add a fixed user or flexible slot below.")}
                                </p>
                              </div>
                            )}

                            {/* Add Approver Buttons */}
                            <div className="flex gap-3 mt-4">
                              <button
                                type="button"
                                onClick={() => addFixedApprover(idx)}
                                className="flex-1 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-emerald-300 py-3 text-emerald-600 font-medium text-sm bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-400 transition-all duration-200"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                                </svg>
                                {t("approval.addFixedUser", "Add Fixed User")}
                              </button>
                              <button
                                type="button"
                                onClick={() => addFlexibleApprover(idx)}
                                className="flex-1 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-orange-300 py-3 text-orange-600 font-medium text-sm bg-orange-50 hover:bg-orange-100 hover:border-orange-400 transition-all duration-200"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                                </svg>
                                {t("approval.addFlexibleSlot", "Add Flexible Slot")}
                              </button>
                            </div>
                          </div>

                          {/* LEGACY: Hidden old Role Name Input - kept for backward compatibility */}
                          <input
                            type="hidden"
                            value={lv.name ?? ""}
                            onChange={(e) =>
                              setApprovalLevels((prev) => {
                                const copy = [...prev];
                                copy[idx] = {
                                  ...copy[idx],
                                  name: e.target.value,
                                };
                                return copy;
                              })
                            }
                          />
                        </div>
                      </React.Fragment>
                    ))}

                    {/* Add Level Button - Emphasized */}
                    <button
                      type="button"
                      onClick={addLevel}
                      className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-emerald-400 py-4 text-emerald-700 font-semibold text-base bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-500 transition-all duration-200"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                      </svg>
                      {t("approval.addLevel")}
                    </button>
                  </div>
                </div>

                {/* ---------- Files upload ---------- */}
                <label className="block text-sm font-semibold text-green-700 mb-2">
                  {t("files.sectionUploadTitle")}
                </label>

                <div className="flex items-center justify-center gap-3 ">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-[12px]
               bg-[#183e33] text-white hover:bg-[#141716] transition-colors
               w-full sm:w-auto sm:min-w-[220px]"
                  >
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                    {t("files.uploadBtn")}
                  </button>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.xlsx,.xls,.csv,.ods,.doc,.docx,.pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const picked = Array.from(e.target.files || []);
                    const allowed = picked.filter(isAllowedFile);
                    const rejected = picked.filter((f) => !isAllowedFile(f));

                    if (rejected.length) {
                      const names = rejected.map((f) => f.name).join(", ");
                      toast.error(
                        `ชนิดไฟล์ไม่รองรับ: ${names} (รองรับเฉพาะ รูปภาพ, Excel/CSV/ODS, Word, PDF)`
                      );
                    }

                    // Check file size limit (50MB = 50 * 1024 * 1024 bytes)
                    const maxSize = 50 * 1024 * 1024;
                    const oversizedFiles = allowed.filter(f => f.size > maxSize);

                    if (oversizedFiles.length > 0) {
                      const fileDetails = oversizedFiles.map(f => `${f.name} (${formatFileSize(f.size)})`).join(', ');
                      toast.error(`File size exceeds 50MB limit: ${fileDetails}. Please select smaller files.`);
                      // Remove oversized files from allowed list
                      const validFiles = allowed.filter(f => f.size <= maxSize);
                      if (validFiles.length === 0) {
                        e.currentTarget.value = "";
                        return;
                      }
                    }

                    const validFiles = allowed.filter(f => f.size <= maxSize);
                    if (validFiles.length) {
                      setFiles((prev) => [...prev, ...validFiles]);

                      // ✅ กรณีสร้างใหม่: เลือกไฟล์แรกเป็น default
                      if (modalMode === "create" && defaultChoice === null) {
                        setDefaultChoice(`new:0`);
                      }

                      // ✅ กรณีแก้ไข: ถ้า type เดิมยังไม่มีไฟล์ (existingFiles.length === 0)
                      // และยังไม่มี default (form.defaultTypeFileId ไม่มีค่า) ให้ตั้งไฟล์แรกที่เพิ่งเลือกเป็น default
                      if (
                        modalMode === "edit" &&
                        defaultChoice === null &&
                        (existingFiles?.length ?? 0) === 0 &&
                        !form.defaultTypeFileId
                      ) {
                        setDefaultChoice(`new:0`);
                      }
                    }

                    // รีเซ็ตค่าเพื่อให้เลือกไฟล์เดิมซ้ำได้
                    e.currentTarget.value = "";
                  }}
                />

                {files.length > 0 && (
                  <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                    {modalMode === "create" ? (
                      // ❗️ส่วน create เดิม ไม่ต้องแก้
                      <ul className="space-y-1 text-sm text-gray-700">
                        <li className="flex items-center justify-between gap-3 border-b last:border-b-0 pb-1">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="radio"
                              name="newDefault"
                              checked={defaultChoice === null}
                              onChange={() => setDefaultChoice(null)}
                            />
                            <span>{t("files.noDefault")}</span>
                          </label>
                        </li>

                        {files.map((f, i) => (
                          <li
                            key={i}
                            className="flex items-center justify-between gap-3 border-b last:border-b-0 pb-1"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <input
                                type="radio"
                                name="newDefault"
                                checked={defaultChoice === `new:${i}`}
                                onChange={() => setDefaultChoice(`new:${i}`)}
                                title={t("files.markAsDefault")}
                              />
                              <span className="truncate">{f.name}</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setFiles((prev) => prev.filter((_, idx) => idx !== i));
                                setDefaultChoice((prev) => {
                                  if (!prev?.startsWith("new:")) return prev;
                                  const cur = Number(prev.split(":")[1]);
                                  if (cur === i) return null;
                                  if (cur > i) return `new:${cur - 1}`;
                                  return prev;
                                });
                              }}
                              className="text-red-600 hover:text-red-700 text-xs"
                            >
                              {t("files.remove")}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      // ❗️ส่วน edit — เพิ่ม radio ให้เลือก new file เป็น default ได้
                      <ul className="space-y-1 text-sm text-gray-700">
                        {files.map((f, i) => (
                          <li
                            key={i}
                            className="flex items-center justify-between gap-3 border-b last:border-b-0 pb-1"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <input
                                type="radio"
                                name="defaultTemplate"
                                checked={defaultChoice === `new:${i}`}
                                onChange={() => setDefaultChoice(`new:${i}`)}
                                title={t("files.markAsDefault")}
                              />
                              <span className="truncate">{f.name}</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setFiles((prev) => prev.filter((_, idx) => idx !== i));
                                setDefaultChoice((prev) => {
                                  if (!prev?.startsWith("new:")) return prev;
                                  const cur = Number(prev.split(":")[1]);
                                  if (cur === i) return null;
                                  if (cur > i) return `new:${cur - 1}`;
                                  return prev;
                                });
                              }}
                              className="text-red-600 hover:text-red-700 text-xs"
                            >
                              {t("files.remove")}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

              </div>

              {/* ---------- Existing files (edit and duplicate) ---------- */}
              {(modalMode === "edit" || modalMode === "duplicate") && (
                <div>
                  <label className="block text-sm font-semibold text-green-700 mb-1">
                    {modalMode === "edit"
                      ? t("files.existingTitle")
                      : t("files.toBeDuplicatedTitle")}
                  </label>

                  {modalMode === "duplicate" && (
                    <div className="mb-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">
                      {t("files.duplicateInfo")}
                    </div>
                  )}

                  {existingFiles && existingFiles.length > 0 ? (
                    <ul className="text-sm text-gray-700 divide-y divide-gray-200 rounded-lg border border-gray-200">
                      <li className="flex items-center justify-between gap-3 px-3 py-2">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="radio"
                            name="defaultTemplate"
                            checked={defaultChoice === null}
                            onChange={() => setDefaultChoice(null)}
                          />
                          <span className="text-gray-700">
                            {t("files.noDefault")}
                          </span>
                        </label>
                      </li>

                      {existingFiles.map((f) => (
                        <li
                          key={f.id}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            {modalMode !== "duplicate" && (
                              <input
                                type="radio"
                                name="defaultTemplate"
                                checked={defaultChoice === `id:${f.id}`}
                                onChange={() => setDefaultChoice(`id:${f.id}`)}
                                title={t("files.markAsDefault")}
                              />
                            )}
                            {modalMode === "duplicate" && (
                              <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                                {t("files.willBeDuplicated")}
                              </span>
                            )}
                            <a
                              href={toSecure(f.filePath)}
                              target="_blank"
                              rel="noopener"
                              className="text-[#183e33] hover:underline break-words truncate"
                            >
                              {f.fileName}
                            </a>
                          </div>

                          <div className="shrink-0 flex items-center gap-2">
                            <span className="text-xs text-gray-500">
                              {t("files.sizeKb", {
                                size: Math.max(
                                  1,
                                  Math.round((f.size || 0) / 1024)
                                ),
                              })}
                            </span>
                            {isPdfFile(f.fileName) && (
                              <button
                                type="button"
                                onClick={() => handlePreviewPdf(f)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border text-xs hover:bg-green-50 hover:border-green-300 text-green-600"
                                title={t("files.preview")}
                              >
                                <FiEye className="w-3.5 h-3.5" />
                                <span>{t("files.preview")}</span>
                              </button>
                            )}
                            {modalMode !== "duplicate" && (
                              <button
                                type="button"
                                onClick={() => {
                                  handleDeleteExistingFile(form.id!, f.id);
                                  setDefaultChoice((prev) =>
                                    prev === `id:${f.id}` ? null : prev
                                  );
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border text-xs hover:bg-red-50 hover:border-red-300 text-red-600"
                                title={t("files.remove")}
                              >
                                <FaTrashAlt className="w-3.5 h-3.5" />
                                <span>{t("files.remove")}</span>
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-gray-500">{t("files.none")}</p>
                  )}
                </div>
              )}

              {/* ---------- Footer ---------- */}
              <div className="mt-4 flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 bg-gray-300 rounded-md hover:bg-gray-400"
                >
                  {t("btnCancel")}
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-[#183e33] text-white rounded-md hover:bg-[#141716]"
                >
                  {t("btnSave")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PDF Viewer */}
      <PDFViewer
        isOpen={pdfViewerState.isOpen}
        onClose={closePdfViewer}
        fileUrl={pdfViewerState.fileUrl}
        fileName={pdfViewerState.fileName}
      />
      <AdminLogModal
        isOpen={showLogModal}
        onClose={() => setShowLogModal(false)}
        module="MEMO_TYPE"
        title="Document Type Management Log"
      />
    </div>
  );
};

export default MemoTypeManager;
