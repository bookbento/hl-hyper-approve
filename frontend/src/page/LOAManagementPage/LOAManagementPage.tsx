// src/page/LoaManagement/LoaManagementPage.tsx
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import axios from "axios";
import { Listbox } from "@headlessui/react";
import { ChevronDown, Check } from "lucide-react";
import UnauthorizedAccess from "../../components/UnauthorizedAccess";
import AdminLogModal from "../../components/AdminLogModal";

// Type for manageable business units
interface ManageableBU {
  id: number;
  name: string;
  abbreviation?: string | null;
  isPrimary?: boolean;
}

interface MeRes {
  id: number;
  name: string;
  email: string;
  role: string;
  roles?: string[];
}

interface LineOfApproval {
  pivotId: number;
  lineOfApprovalId: number;
  lineName: string | null;
  level: number;
  businessUnitName: string | null;
  departmentName: string | null;
  memoTypeName: string | null;
  memoTypeAbbr: string | null;
  slots: SlotData[];
}

interface MemoTypeForLine {
  id: number;
  name: string;
  abbreviation: string;
  description: string;
  businessUnit: {
    id: number;
    name: string;
  } | null;
  department: {
    id: number;
    name: string;
  } | null;
  createdAt: string;
}

interface SlotData {
  level: number;
  userId: number | null;
  userName: string | null;
  isTarget: boolean;
  slotType: string | null;
  isSigReq: boolean;
  roleDescription: string | null;
  approvalRequirement: "ALL" | "ANY";
}

interface EditableSlot {
  level: number;
  userId: number | null;
  userName: string | null;
  slotType: string;
  isSigReq: boolean;
  roleDescription: string;
  approvalRequirement: "ALL" | "ANY";
}

interface UserSearchResult {
  id: number;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  email: string | null;
}

const SLOT_TYPES = [
  { value: "FIXED_USER", label: "Fixed User" },
  { value: "FLEXIBLE_SLOT", label: "Flexible Slot" },
];

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

const LoaManagementPage: React.FC = () => {
  const { t } = useTranslation("loa");
  const [lines, setLines] = useState<LineOfApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [me, setMe] = useState<MeRes | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedLine, setSelectedLine] = useState<LineOfApproval | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [memoTypesForLine, setMemoTypesForLine] = useState<MemoTypeForLine[]>([]);
  const [loadingMemoTypes, setLoadingMemoTypes] = useState(false);

  // Edit mode states
  const [isEditMode, setIsEditMode] = useState(false);
  const [editLineName, setEditLineName] = useState("");
  const [editSlots, setEditSlots] = useState<EditableSlot[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [editedLineIds, setEditedLineIds] = useState<Set<number>>(new Set());

  // User search states
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [userSearchResults, setUserSearchResults] = useState<UserSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [activeSlotIndex, setActiveSlotIndex] = useState<number | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Bulk Update Approver states
  const [approverSearchTerm, setApproverSearchTerm] = useState(""); // Search for approver to filter lines
  const [approverSearchResults, setApproverSearchResults] = useState<UserSearchResult[]>([]);
  const [isSearchingApprover, setIsSearchingApprover] = useState(false);
  const [showApproverDropdown, setShowApproverDropdown] = useState(false);
  const approverSearchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const approverSearchInputRef = useRef<HTMLDivElement>(null);
  const [selectedLineIds, setSelectedLineIds] = useState<Set<number>>(new Set());
  const [isBulkUpdateModalOpen, setIsBulkUpdateModalOpen] = useState(false);
  const [newApproverSearchQuery, setNewApproverSearchQuery] = useState("");
  const [newApproverSearchResults, setNewApproverSearchResults] = useState<UserSearchResult[]>([]);
  const [isSearchingNewApprover, setIsSearchingNewApprover] = useState(false);
  const [selectedNewApprover, setSelectedNewApprover] = useState<UserSearchResult | null>(null);
  const [selectedFromApprover, setSelectedFromApprover] = useState<{ id: number; name: string } | null>(null);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [bulkUpdateAction, setBulkUpdateAction] = useState<"replace" | "flexible" | "remove">("replace");
  const newApproverSearchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Bulk Update Signature Required states
  const [isBulkSignatureModalOpen, setIsBulkSignatureModalOpen] = useState(false);
  const [bulkSignatureAction, setBulkSignatureAction] = useState<"enable" | "disable">("enable");
  const [isBulkUpdatingSignature, setIsBulkUpdatingSignature] = useState(false);

  // Bulk Reorder Approver states
  const [isBulkReorderModalOpen, setIsBulkReorderModalOpen] = useState(false);
  const [bulkReorderAction, setBulkReorderAction] = useState<"moveToFirst" | "plusOne" | "minusOne" | "moveToLast">("moveToFirst");
  const [isBulkReordering, setIsBulkReordering] = useState(false);
  const [showLogModal, setShowLogModal] = useState(false);

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const pageSizeOptions = [5, 10, 20, 50, 0]; // 0 means "All"

  // DCC Multi-Business Unit Management
  const [manageableBusinessUnits, setManageableBusinessUnits] = useState<ManageableBU[]>([]);
  const [selectedBusinessUnitId, setSelectedBusinessUnitId] = useState<number | "all">("all");

  // Dynamic Business Unit Filter (for all users - based on data in table) - Multi-select
  const [dynamicBUFilterIds, setDynamicBUFilterIds] = useState<string[]>([]);
  const [isBUDropdownOpen, setIsBUDropdownOpen] = useState(false);
  const buDropdownRef = useRef<HTMLDivElement>(null);
  
  // Department Filter state - Multi-select
  const [dynamicDeptFilterIds, setDynamicDeptFilterIds] = useState<string[]>([]);
  const [isDeptDropdownOpen, setIsDeptDropdownOpen] = useState(false);
  const deptDropdownRef = useRef<HTMLDivElement>(null);
  
  // Memo Type Filter state
  const [dynamicMemoTypeFilterId, setDynamicMemoTypeFilterId] = useState<string>("all");

  // Approvers Filter state - Multi-select
  const [dynamicApproverFilterIds, setDynamicApproverFilterIds] = useState<number[]>([]);
  const [isApproverDropdownOpen, setIsApproverDropdownOpen] = useState(false);
  const approverDropdownRef = useRef<HTMLDivElement>(null);

  // Reset department filter when BU filter changes
  useEffect(() => {
    if (dynamicBUFilterIds.length > 0) {
      setDynamicDeptFilterIds([]);
    }
  }, [dynamicBUFilterIds]);

  // Compute unique business units from the lines data (for dynamic dropdown)
  const availableBusinessUnits = React.useMemo(() => {
    const buMap = new Map<string, string>();
    lines.forEach((line) => {
      if (line.businessUnitName) {
        buMap.set(line.businessUnitName, line.businessUnitName);
      }
    });
    return Array.from(buMap.values()).sort((a, b) => a.localeCompare(b, 'th-TH'));
  }, [lines]);

  // Compute unique departments from the lines data (filtered by selected BUs)
  const availableDepartments = React.useMemo(() => {
    const deptMap = new Map<string, string>();
    lines.forEach((line) => {
      // Only include departments that match the selected BUs (or all if no BU selected)
      if (line.departmentName && (dynamicBUFilterIds.length === 0 || dynamicBUFilterIds.includes(line.businessUnitName || ""))) {
        deptMap.set(line.departmentName, line.departmentName);
      }
    });
    return Array.from(deptMap.values()).sort((a, b) => a.localeCompare(b, 'th-TH'));
  }, [lines, dynamicBUFilterIds]);

  // Compute unique memo types from the lines data
  const availableMemoTypes = React.useMemo(() => {
    const memoTypeMap = new Map<string, { name: string; abbr: string | null }>();
    lines.forEach((line) => {
      if (line.memoTypeName) {
        const key = line.memoTypeName;
        if (!memoTypeMap.has(key)) {
          memoTypeMap.set(key, {
            name: line.memoTypeName,
            abbr: line.memoTypeAbbr
          });
        }
      }
    });
    return Array.from(memoTypeMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'th-TH'));
  }, [lines]);

  // Compute unique approvers from the lines data
  const availableApprovers = React.useMemo(() => {
    const approverMap = new Map<number, { id: number; name: string }>();
    lines.forEach((line) => {
      line.slots.forEach((slot) => {
        if (slot.userId && slot.userName && slot.slotType === "FIXED_USER") {
          if (!approverMap.has(slot.userId)) {
            approverMap.set(slot.userId, {
              id: slot.userId,
              name: slot.userName
            });
          }
        }
      });
    });
    return Array.from(approverMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'th-TH'));
  }, [lines]);

  // Excel-style Column Filter & Sort states
  type ColumnKey = "lineName" | "businessUnitName" | "departmentName" | "memoTypeName" | "approvers";
  const [columnFilters, setColumnFilters] = useState<Record<ColumnKey, string>>({
    lineName: "",
    businessUnitName: "",
    departmentName: "",
    memoTypeName: "",
    approvers: "",
  });
  const [sortColumn, setSortColumn] = useState<ColumnKey | "levelCount" | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [openFilterDropdown, setOpenFilterDropdown] = useState<ColumnKey | null>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

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

  // Close BU dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (buDropdownRef.current && !buDropdownRef.current.contains(event.target as Node)) {
        setIsBUDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close Dept dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (deptDropdownRef.current && !deptDropdownRef.current.contains(event.target as Node)) {
        setIsDeptDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close Approver dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (approverDropdownRef.current && !approverDropdownRef.current.contains(event.target as Node)) {
        setIsApproverDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSort = (column: ColumnKey, direction: "asc" | "desc") => {
    setSortColumn(column);
    setSortDirection(direction);
    setOpenFilterDropdown(null);
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
    setColumnFilters((prev) => ({ ...prev, [column]: "" }));
    setOpenFilterDropdown(null);
  };

  const clearAllFilters = () => {
    setColumnFilters({
      lineName: "",
      businessUnitName: "",
      departmentName: "",
      memoTypeName: "",
      approvers: "",
    });
    setSortColumn(null);
    setSortDirection("asc");
    // Clear BU, Dept, Memo Type, and Approver filters
    setDynamicBUFilterIds([]);
    setDynamicDeptFilterIds([]);
    setDynamicMemoTypeFilterId("all");
    setDynamicApproverFilterIds([]);
  };

  const hasActiveFilters = Object.values(columnFilters).some((f) => f !== "") || sortColumn !== null || dynamicBUFilterIds.length > 0 || dynamicDeptFilterIds.length > 0 || dynamicMemoTypeFilterId !== "all" || dynamicApproverFilterIds.length > 0;
  const handleRowClick = (line: LineOfApproval) => {
    setSelectedLine(line);
    setIsModalOpen(true);
    setIsEditMode(false);
    fetchMemoTypesForLine(line.lineOfApprovalId);
  };

  const fetchMemoTypesForLine = async (lineId: number) => {
    try {
      setLoadingMemoTypes(true);
      const response = await fetch(`/api/approver-lines/${lineId}/memo-types`, {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Failed to fetch memo types");
      }

      const data = await response.json();
      setMemoTypesForLine(data);
    } catch (error) {
      console.error("Error fetching memo types:", error);
      setMemoTypesForLine([]);
    } finally {
      setLoadingMemoTypes(false);
    }
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setSelectedLine(null);
    setIsEditMode(false);
    setEditSlots([]);
    setEditLineName("");
    setActiveSlotIndex(null);
    setUserSearchQuery("");
    setUserSearchResults([]);
    setMemoTypesForLine([]);
  };

  const enterEditMode = () => {
    if (!selectedLine) return;
    setIsEditMode(true);
    setEditLineName(selectedLine.lineName || "");
    setEditSlots(
      selectedLine.slots.map((slot) => ({
        level: slot.level,
        userId: slot.userId,
        userName: slot.userName,
        slotType: slot.slotType || "FIXED_USER",
        isSigReq: slot.isSigReq,
        roleDescription: slot.roleDescription || "",
        approvalRequirement: slot.approvalRequirement || "ALL",
      }))
    );
  };

  const cancelEdit = () => {
    setIsEditMode(false);
    setEditSlots([]);
    setEditLineName("");
    setActiveSlotIndex(null);
    setUserSearchQuery("");
    setUserSearchResults([]);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Check user permissions first
        const { data: meRes } = await axios.get<MeRes>("/api/me", {
          withCredentials: true,
        });
        if (!alive) return;
        setMe(meRes);

        // Check if user has admin or dcc role
        const roles = meRes.roles || [meRes.role];
        const hasRole = (target: string) =>
          roles.some((r) => (r ?? "").toUpperCase() === target);
        const isAdminOrDcc = hasRole("ADMIN") || hasRole("DCC");

        if (!isAdminOrDcc) {
          setBlocked(true);
          setLoading(false);
          return;
        }

        // Fetch manageable business units for DCC users (not Admin)
        if (hasRole("DCC") && !hasRole("ADMIN")) {
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

        // Fetch approval lines if authorized
        await fetchApprovalLines();
      } catch (err) {
        console.error("🔴 init error:", err);
        if (alive) {
          setBlocked(true);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setActiveSlotIndex(null);
        setUserSearchResults([]);
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

  const fetchApprovalLines = async (businessUnitId?: number | "all") => {
    try {
      setLoading(true);
      const params: Record<string, any> = {};
      // Add businessUnitId filter if a specific BU is selected (not "all")
      if (businessUnitId && businessUnitId !== "all") {
        params.businessUnitId = businessUnitId;
      }
      const response = await fetch(`/api/approver-lines${Object.keys(params).length > 0 ? '?' + new URLSearchParams(params as any).toString() : ''}`, {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Failed to fetch approval lines");
      }

      const data = await response.json();
      setLines(data);
    } catch (error) {
      console.error("Error fetching approval lines:", error);
      toast.error("Failed to load approval lines");
    } finally {
      setLoading(false);
    }
  };

  // Refetch lines when selected business unit changes (for DCC users)
  useEffect(() => {
    if (!loading && manageableBusinessUnits.length > 1) {
      fetchApprovalLines(selectedBusinessUnitId);
    }
  }, [selectedBusinessUnitId]);

  // Search users with debounce
  const searchUsers = useCallback(async (query: string) => {
    if (!query.trim()) {
      setUserSearchResults([]);
      return;
    }

    try {
      setIsSearching(true);
      const { data } = await axios.get<UserSearchResult[]>("/api/users/search", {
        params: { q: query, limit: 10 },
        withCredentials: true,
      });
      setUserSearchResults(data);
    } catch (error) {
      console.error("Error searching users:", error);
      setUserSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleUserSearchChange = (query: string, slotIndex: number) => {
    setUserSearchQuery(query);
    setActiveSlotIndex(slotIndex);

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      searchUsers(query);
    }, 300);
  };

  // Search for approvers to filter lines
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
    setSelectedFromApprover({ id: user.id, name: displayName });
    setApproverSearchTerm(displayName);
    setShowApproverDropdown(false);
    setApproverSearchResults([]);
    setSelectedLineIds(new Set()); // Clear previous selections
  };

  const clearApproverFilter = () => {
    setSelectedFromApprover(null);
    setApproverSearchTerm("");
    setApproverSearchResults([]);
    setSelectedLineIds(new Set());
  };

  const selectUser = (user: UserSearchResult, slotIndex: number) => {
    const displayName = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "Unknown";
    setEditSlots((prev) =>
      prev.map((slot, idx) =>
        idx === slotIndex
          ? { ...slot, userId: user.id, userName: displayName, slotType: "FIXED_USER" }
          : slot
      )
    );
    setActiveSlotIndex(null);
    setUserSearchQuery("");
    setUserSearchResults([]);
  };

  // Bulk Update: Search for new approver
  const searchNewApprover = useCallback(async (query: string) => {
    if (!query.trim()) {
      setNewApproverSearchResults([]);
      return;
    }

    try {
      setIsSearchingNewApprover(true);
      const { data } = await axios.get<UserSearchResult[]>("/api/users/search", {
        params: { q: query, limit: 10 },
        withCredentials: true,
      });
      setNewApproverSearchResults(data);
    } catch (error) {
      console.error("Error searching new approver:", error);
      setNewApproverSearchResults([]);
    } finally {
      setIsSearchingNewApprover(false);
    }
  }, []);

  const handleNewApproverSearchChange = (query: string) => {
    setNewApproverSearchQuery(query);
    setSelectedNewApprover(null);

    if (newApproverSearchTimeoutRef.current) {
      clearTimeout(newApproverSearchTimeoutRef.current);
    }

    newApproverSearchTimeoutRef.current = setTimeout(() => {
      searchNewApprover(query);
    }, 300);
  };

  const toggleLineSelection = (lineId: number) => {
    setSelectedLineIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(lineId)) {
        newSet.delete(lineId);
      } else {
        newSet.add(lineId);
      }
      return newSet;
    });
  };

  const toggleSelectAll = (lineIds: number[]) => {
    setSelectedLineIds((prev) => {
      const allSelected = lineIds.every((id) => prev.has(id));
      if (allSelected) {
        return new Set();
      } else {
        return new Set(lineIds);
      }
    });
  };

  const openBulkUpdateModal = () => {
    if (selectedLineIds.size === 0) {
      toast.error("Please select at least one line to update");
      return;
    }
    if (!selectedFromApprover) {
      toast.error("Please search and select an approver first");
      return;
    }
    setIsBulkUpdateModalOpen(true);
  };

  const closeBulkUpdateModal = () => {
    setIsBulkUpdateModalOpen(false);
    setNewApproverSearchQuery("");
    setNewApproverSearchResults([]);
    setSelectedNewApprover(null);
    setBulkUpdateAction("replace");
  };

  const openBulkSignatureModal = () => {
    if (selectedLineIds.size === 0) {
      toast.error("Please select at least one line to update");
      return;
    }
    if (!selectedFromApprover) {
      toast.error("Please search and select an approver first");
      return;
    }
    setIsBulkSignatureModalOpen(true);
  };

  const closeBulkSignatureModal = () => {
    setIsBulkSignatureModalOpen(false);
    setBulkSignatureAction("enable");
  };

  const performBulkUpdate = async () => {
    if (!selectedFromApprover) {
      toast.error("Please select an approver to update");
      return;
    }

    if (bulkUpdateAction === "replace" && !selectedNewApprover) {
      toast.error("Please select a new approver for replacement");
      return;
    }

    if (selectedLineIds.size === 0) {
      toast.error("Please select at least one line to update");
      return;
    }

    try {
      setIsBulkUpdating(true);

      const payload = {
        fromUserId: selectedFromApprover.id,
        lineOfApprovalIds: Array.from(selectedLineIds),
        action: bulkUpdateAction,
        affectTemplates: true,
        affectRunningMemos: false,
        affectCcGroups: false,
        dryRun: false,
      };

      // Only include toUserId for replace action
      if (bulkUpdateAction === "replace" && selectedNewApprover) {
        (payload as any).toUserId = selectedNewApprover.id;
      }

      const response = await axios.post("/api/approvers/bulk-update", payload, {
        withCredentials: true,
      });

      if (response.data.ok) {
        const actionText = {
          replace: "replaced",
          flexible: "changed to flexible slots",
          remove: "removed"
        }[bulkUpdateAction];

        toast.success(
          `Successfully ${actionText} ${response.data.templatePivotsChanged} approval slot(s)`
        );

        setEditedLineIds((prev) => {
          const newSet = new Set(prev);
          selectedLineIds.forEach(id => {
            newSet.delete(id);
            newSet.add(id);
          });
          return newSet;
        });

        closeBulkUpdateModal();
        setSelectedLineIds(new Set());
        setApproverSearchTerm("");
        setSelectedFromApprover(null);
        await fetchApprovalLines();
      }
    } catch (error: any) {
      console.error("Error performing bulk update:", error);
      toast.error(error.response?.data?.error || "Failed to update approvers");
    } finally {
      setIsBulkUpdating(false);
    }
  };

  const performBulkSignatureUpdate = async () => {
    if (!selectedFromApprover) {
      toast.error("Please select an approver to update");
      return;
    }

    if (selectedLineIds.size === 0) {
      toast.error("Please select at least one line to update");
      return;
    }

    try {
      setIsBulkUpdatingSignature(true);

      const payload = {
        fromUserId: selectedFromApprover.id,
        lineOfApprovalIds: Array.from(selectedLineIds),
        action: bulkSignatureAction,
        affectTemplates: true,
        dryRun: false,
      };

      const response = await axios.post("/api/approvers/bulk-signature-update", payload, {
        withCredentials: true,
      });

      if (response.data.ok) {
        const actionText = bulkSignatureAction === "enable" ? "enabled" : "disabled";
        toast.success(
          `Successfully ${actionText} signature requirement for ${response.data.templatePivotsChanged} approval slot(s)`
        );

        setEditedLineIds((prev) => {
          const newSet = new Set(prev);
          selectedLineIds.forEach(id => {
            newSet.delete(id);
            newSet.add(id);
          });
          return newSet;
        });

        closeBulkSignatureModal();
        setSelectedLineIds(new Set());
        setApproverSearchTerm("");
        setSelectedFromApprover(null);
        await fetchApprovalLines();
      }
    } catch (error: any) {
      console.error("Error performing bulk signature update:", error);
      toast.error(error.response?.data?.error || "Failed to update signature requirements");
    } finally {
      setIsBulkUpdatingSignature(false);
    }
  };

  const openBulkReorderModal = () => {
    if (selectedLineIds.size === 0) {
      toast.error("Please select at least one line to reorder");
      return;
    }
    if (!selectedFromApprover) {
      toast.error("Please search and select an approver first");
      return;
    }
    setIsBulkReorderModalOpen(true);
  };

  const closeBulkReorderModal = () => {
    setIsBulkReorderModalOpen(false);
    setBulkReorderAction("moveToFirst");
  };

  const performBulkReorder = async () => {
    if (!selectedFromApprover) {
      toast.error("Please select an approver to reorder");
      return;
    }

    if (selectedLineIds.size === 0) {
      toast.error("Please select at least one line to reorder");
      return;
    }

    try {
      setIsBulkReordering(true);

      const payload = {
        fromUserId: selectedFromApprover.id,
        lineOfApprovalIds: Array.from(selectedLineIds),
        action: bulkReorderAction,
        affectTemplates: true,
        dryRun: false,
      };

      const response = await axios.post("/api/approvers/bulk-reorder", payload, {
        withCredentials: true,
      });

      if (response.data.ok) {
        const actionText = {
          moveToFirst: "moved to first level",
          plusOne: "moved up one level",
          minusOne: "moved down one level",
          moveToLast: "moved to last level"
        }[bulkReorderAction];

        const skippedText = response.data.slotsSkipped > 0
          ? ` (${response.data.slotsSkipped} already at target level)`
          : "";

        toast.success(
          `Successfully ${actionText} for ${response.data.templatePivotsChanged} approval slot(s)${skippedText}`
        );

        setEditedLineIds((prev) => {
          const newSet = new Set(prev);
          selectedLineIds.forEach(id => {
            newSet.delete(id);
            newSet.add(id);
          });
          return newSet;
        });

        closeBulkReorderModal();
        setSelectedLineIds(new Set());
        setApproverSearchTerm("");
        setSelectedFromApprover(null);
        await fetchApprovalLines();
      }
    } catch (error: any) {
      console.error("Error performing bulk reorder:", error);
      toast.error(error.response?.data?.error || "Failed to reorder approver");
    } finally {
      setIsBulkReordering(false);
    }
  };

  const updateSlot = (index: number, field: keyof EditableSlot, value: any) => {
    setEditSlots((prev) =>
      prev.map((slot, idx) => {
        if (idx !== index) return slot;

        const updated = { ...slot, [field]: value };

        // If changing to non-FIXED_USER, clear the user
        if (field === "slotType" && value !== "FIXED_USER") {
          updated.userId = null;
          updated.userName = null;
        }

        return updated;
      })
    );
  };

  const addSlot = () => {
    const maxLevel = editSlots.length > 0 ? Math.max(...editSlots.map((s) => s.level)) : -1;
    setEditSlots((prev) => [
      ...prev,
      {
        level: maxLevel + 1,
        userId: null,
        userName: null,
        slotType: "FIXED_USER",
        isSigReq: false,
        roleDescription: "",
        approvalRequirement: "ALL",
      },
    ]);
  };

  const addSlotToLevel = (level: number) => {
    setEditSlots((prev) => [
      ...prev,
      {
        level: level,
        userId: null,
        userName: null,
        slotType: "FIXED_USER",
        isSigReq: false,
        roleDescription: "",
        approvalRequirement: "ALL",
      },
    ]);
  };



  const removeSlot = (index: number) => {
    setEditSlots((prev) => prev.filter((_, idx) => idx !== index));
    // Close any active dropdowns when removing slots
    setActiveSlotIndex(null);
    setUserSearchQuery("");
    setUserSearchResults([]);
  };

  const saveChanges = async () => {
    if (!selectedLine) return;

    try {
      setIsSaving(true);

      // Prepare slots data for API
      const slotsPayload = editSlots.map((slot) => ({
        level: slot.level,
        userId: slot.slotType === "FIXED_USER" ? slot.userId : null,
        slotType: slot.slotType,
        isSigReq: slot.isSigReq,
        roleDescription: slot.roleDescription || null,
        approvalRequirement: slot.approvalRequirement || "ALL",
      }));

      await axios.put(
        `/api/approver-lines/${selectedLine.lineOfApprovalId}`,
        {
          lineName: editLineName,
          slots: slotsPayload,
        },
        { withCredentials: true }
      );

      setEditedLineIds((prev) => {
        const newSet = new Set(prev);
        if (selectedLine) {
          newSet.delete(selectedLine.lineOfApprovalId);
          newSet.add(selectedLine.lineOfApprovalId);
        }
        return newSet;
      });

      toast.success("Line of approval updated successfully");

      // Refresh data
      await fetchApprovalLines();

      // Update selected line with new data
      const updatedLines = await (await fetch("/api/approver-lines", { credentials: "include" })).json();
      const updatedLine = updatedLines.find(
        (l: LineOfApproval) => l.lineOfApprovalId === selectedLine.lineOfApprovalId
      );
      if (updatedLine) {
        setSelectedLine(updatedLine);
      }

      setIsEditMode(false);
    } catch (error: any) {
      console.error("Error saving changes:", error);
      toast.error(error.response?.data?.error || "Failed to save changes");
    } finally {
      setIsSaving(false);
    }
  };

  // Group lines by lineOfApprovalId to avoid duplicates
  const uniqueLines = lines.reduce((acc, line) => {
    const existing = acc.find((l) => l.lineOfApprovalId === line.lineOfApprovalId);
    if (!existing) {
      acc.push(line);
    }
    return acc;
  }, [] as LineOfApproval[]);

  // Filter lines based on search term and column filters
  const filteredLines = uniqueLines.filter((line) => {
    // Dynamic BU filter - filter by business unit name (multi-select)
    const matchesDynamicBUFilter = dynamicBUFilterIds.length === 0 || dynamicBUFilterIds.includes(line.businessUnitName || "");
    
    // Dynamic Dept filter - filter by department name (multi-select)
    const matchesDynamicDeptFilter = dynamicDeptFilterIds.length === 0 || dynamicDeptFilterIds.includes(line.departmentName || "");
    
    // Dynamic Memo Type filter - filter by memo type name
    const matchesDynamicMemoTypeFilter = dynamicMemoTypeFilterId === "all" || line.memoTypeName === dynamicMemoTypeFilterId;

    // Dynamic Approver filter - filter by approver user ID (multi-select)
    const matchesDynamicApproverFilter = dynamicApproverFilterIds.length === 0 || 
      line.slots.some(slot => slot.userId && dynamicApproverFilterIds.includes(slot.userId));

    // Global search filter - searches across all columns
    const matchesGlobalSearch =
      !searchTerm ||
      line.lineName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      line.businessUnitName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      line.departmentName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      line.memoTypeName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      line.memoTypeAbbr?.toLowerCase().includes(searchTerm.toLowerCase());

    // Column-specific filters - each filter only searches in its own column
    const matchesLineNameFilter =
      !columnFilters.lineName ||
      line.lineName?.toLowerCase().includes(columnFilters.lineName.toLowerCase());
    const matchesBusinessUnitFilter =
      !columnFilters.businessUnitName ||
      line.businessUnitName?.toLowerCase().includes(columnFilters.businessUnitName.toLowerCase());
    const matchesDepartmentFilter =
      !columnFilters.departmentName ||
      line.departmentName?.toLowerCase().includes(columnFilters.departmentName.toLowerCase());
    // Memo Type text filter (for additional text search within selected dropdown)
    const matchesMemoTypeFilter =
      !columnFilters.memoTypeName ||
      line.memoTypeName?.toLowerCase().includes(columnFilters.memoTypeName.toLowerCase()) ||
      line.memoTypeAbbr?.toLowerCase().includes(columnFilters.memoTypeName.toLowerCase());

    // Approvers filter - search in approver names
    const matchesApproversFilter =
      !columnFilters.approvers ||
      line.slots.some((slot) =>
        slot.userName?.toLowerCase().includes(columnFilters.approvers.toLowerCase())
      );

    return (
      matchesDynamicBUFilter &&
      matchesDynamicDeptFilter &&
      matchesDynamicMemoTypeFilter &&
      matchesDynamicApproverFilter &&
      matchesGlobalSearch &&
      matchesLineNameFilter &&
      matchesBusinessUnitFilter &&
      matchesDepartmentFilter &&
      matchesMemoTypeFilter &&
      matchesApproversFilter
    );
  });

  // Further filter by approver if approverSearchTerm and selectedFromApprover are set
  const approverFilteredLines = selectedFromApprover
    ? filteredLines.filter((line) =>
      line.slots.some(
        (slot) =>
          slot.userId === selectedFromApprover.id && slot.slotType === "FIXED_USER"
      )
    )
    : filteredLines;

  const finalFilteredLines = approverFilteredLines;

  // Create order map for recently edited lines (Convert IDs to string for safe comparison)
  const editedOrderMap = new Map(
    Array.from(editedLineIds).reverse().map((id, index) => [String(id), index])
  );

  // Sort lines
  const sortedLines = [...finalFilteredLines].sort(
    (a, b) => {
      if (!sortColumn) {
        // Always float edited lines to the top (newest first). Unedited lines keep their original order.
        const indexA = editedOrderMap.get(String(a.lineOfApprovalId)) ?? Number.MAX_SAFE_INTEGER;
        const indexB = editedOrderMap.get(String(b.lineOfApprovalId)) ?? Number.MAX_SAFE_INTEGER;
        
        if (indexA !== indexB) {
          return indexA - indexB;
        }
        return 0; // Maintain original order if neither is edited, or if they are somehow the same
      }

      // Special handling for level count sorting
      if (sortColumn === "levelCount") {
        const aLevels = new Set(a.slots.map(s => s.level)).size;
        const bLevels = new Set(b.slots.map(s => s.level)).size;
        return sortDirection === "asc" ? aLevels - bLevels : bLevels - aLevels;
      }

      const aValue = a[sortColumn as keyof LineOfApproval] || "";
      const bValue = b[sortColumn as keyof LineOfApproval] || "";

      const comparison = String(aValue).localeCompare(String(bValue), undefined, { sensitivity: "base" });
      return sortDirection === "asc" ? comparison : -comparison;
    }
  );

  // Lines to display in the table
  const totalPages = pageSize === 0 ? 1 : Math.ceil(sortedLines.length / pageSize);
  const displayedLines = pageSize === 0 
    ? sortedLines 
    : sortedLines.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // Pagination helper functions
  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    setCurrentPage(1);
  };

  const getPageNumbers = () => {
    const pages = [];
    const maxVisiblePages = 5;
    
    if (totalPages <= maxVisiblePages) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      const start = Math.max(1, currentPage - 2);
      const end = Math.min(totalPages, start + maxVisiblePages - 1);
      
      for (let i = start; i <= end; i++) {
        pages.push(i);
      }
    }
    
    return pages;
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#183e33]"></div>
        <span className="ml-3 text-gray-600">Loading approval lines...</span>
      </div>
    );
  }

  if (blocked) {
    return <UnauthorizedAccess />;
  }

  return (
    <div className="p-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 mb-6">
        {/* Filter Row - Single line layout (matching MemoTypeManager) */}
        <div className="flex flex-wrap items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
          {/* Line Search */}
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <input
              type="text"
              placeholder="Search approval lines..."
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

          {/* Dynamic Business Unit Filter Dropdown - shows for all users when there are multiple BUs in data */}
          {availableBusinessUnits.length > 1 && (
            <>
              <div className="hidden md:block h-8 w-px bg-gray-300"></div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                {/* <span className="text-sm text-gray-600 whitespace-nowrap">
                  {t("businessUnitFilter.label", "Business Unit:")}
                </span> */}
                <div className="relative min-w-[250px] max-sm:min-w-full max-sm:w-full" ref={buDropdownRef}>
                  <button
                    onClick={() => setIsBUDropdownOpen(!isBUDropdownOpen)}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#183e33] bg-white min-w-[250px] max-sm:w-full flex items-center justify-between"
                  >
                    <span className="truncate">
                      {dynamicBUFilterIds.length === 0
                        ? t("businessUnitFilter.all", "All Business Units")
                        : `${dynamicBUFilterIds.length} selected`}
                    </span>
                    <svg className="w-4 h-4 ml-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {isBUDropdownOpen && (
                    <div className="absolute z-50 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
                      <div className="p-2">
                        {availableBusinessUnits.map((buName) => (
                          <label
                            key={buName}
                            className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 rounded cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={dynamicBUFilterIds.includes(buName)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setDynamicBUFilterIds([...dynamicBUFilterIds, buName]);
                                } else {
                                  setDynamicBUFilterIds(dynamicBUFilterIds.filter((id) => id !== buName));
                                }
                                setCurrentPage(1);
                              }}
                              className="w-4 h-4 text-[#183e33] border-gray-300 rounded focus:ring-[#183e33] pointer-events-none"
                            />
                            <span className="text-sm text-gray-700">{buName}</span>
                          </label>
                        ))}
                      </div>
                      {dynamicBUFilterIds.length > 0 && (
                        <div className="border-t border-gray-200 p-2">
                          <button
                            onClick={() => {
                              setDynamicBUFilterIds([]);
                              setCurrentPage(1);
                            }}
                            className="w-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded flex items-center justify-center gap-1"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Clear Selection
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Department Filter Dropdown */}
          {availableDepartments.length > 0 && (
            <>
              <div className="hidden md:block h-8 w-px bg-gray-300"></div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                {/* <span className="text-sm text-gray-600 whitespace-nowrap">
                  {t("departmentFilter.label", "Department:")}
                </span> */}
                <div className="relative min-w-[250px] max-sm:min-w-full max-sm:w-full" ref={deptDropdownRef}>
                  <button
                    onClick={() => setIsDeptDropdownOpen(!isDeptDropdownOpen)}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#183e33] bg-white min-w-[250px] max-sm:w-full flex items-center justify-between"
                  >
                    <span className="truncate">
                      {dynamicDeptFilterIds.length === 0
                        ? t("departmentFilter.all", "All Departments")
                        : `${dynamicDeptFilterIds.length} selected`}
                    </span>
                    <svg className="w-4 h-4 ml-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {isDeptDropdownOpen && (
                    <div className="absolute z-50 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
                      <div className="p-2">
                        {availableDepartments.map((deptName) => (
                          <label
                            key={deptName}
                            className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 rounded cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={dynamicDeptFilterIds.includes(deptName)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setDynamicDeptFilterIds([...dynamicDeptFilterIds, deptName]);
                                } else {
                                  setDynamicDeptFilterIds(dynamicDeptFilterIds.filter((id) => id !== deptName));
                                }
                                setCurrentPage(1);
                              }}
                              className="w-4 h-4 text-[#183e33] border-gray-300 rounded focus:ring-[#183e33] pointer-events-none"
                            />
                            <span className="text-sm text-gray-700">{deptName}</span>
                          </label>
                        ))}
                      </div>
                      {dynamicDeptFilterIds.length > 0 && (
                        <div className="border-t border-gray-200 p-2">
                          <button
                            onClick={() => {
                              setDynamicDeptFilterIds([]);
                              setCurrentPage(1);
                            }}
                            className="w-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded flex items-center justify-center gap-1"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Clear Selection
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Divider */}
          <div className="hidden md:block h-8 w-px bg-gray-300"></div>

          {/* Approver Search */}
          <div className="relative min-w-[200px] w-full sm:w-auto" ref={approverSearchInputRef}>
            <div className="relative">
              <input
                type="text"
                placeholder="Search approver..."
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
              {selectedFromApprover && (
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
                    Searching...
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
                    No users found
                  </div>
                ) : (
                  <div className="p-3 text-center text-gray-400 text-sm">
                    Type to search for an approver
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
                {selectedFromApprover 
                  ? `${sortedLines.length} line${sortedLines.length !== 1 ? 's' : ''} found`
                  : t("totalRecords", { count: uniqueLines.length })
                }
              </span>
            </div>
          </div>
        </div>

        {/* Action Row - Page size, View Log, and Bulk Actions when filtering */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left side - Selected Approver Badge and Bulk Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {selectedFromApprover && (
              <>
                <div className="bg-orange-100 border border-orange-200 rounded-lg px-3 py-1.5">
                  <span className="text-xs text-orange-600 font-medium">Filtering:</span>
                  <span className="text-sm text-orange-800 ml-1">{selectedFromApprover.name}</span>
                </div>
                {selectedLineIds.size > 0 && (
                  <span className="text-sm text-blue-600 font-medium">
                    {selectedLineIds.size} selected
                  </span>
                )}
                <button
                  onClick={openBulkUpdateModal}
                  disabled={selectedLineIds.size === 0}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-orange-600 rounded-lg hover:bg-orange-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Bulk Update
                </button>
                <button
                  onClick={openBulkSignatureModal}
                  disabled={selectedLineIds.size === 0}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                  Bulk Signature
                </button>
                <button
                  onClick={openBulkReorderModal}
                  disabled={selectedLineIds.size === 0}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                  </svg>
                  Bulk Reorder
                </button>
              </>
            )}
          </div>

          {/* Right side - Page size, View Log */}
          <div className="flex items-center gap-3">

            {/* Page Size Selector */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">{t("pageSize", "Page size")}</span>
              <Listbox value={pageSize} onChange={handlePageSizeChange}>
                <div className="relative w-20">
                  <Listbox.Button className="w-full border border-gray-300 rounded-lg px-2 py-1.5 flex justify-between items-center text-sm bg-white">
                    {pageSize === 0 ? "All" : pageSize} <ChevronDown className="h-4 w-4 text-gray-400" />
                  </Listbox.Button>
                  <Listbox.Options className="absolute mt-1 w-full bg-white shadow-lg rounded-lg overflow-auto z-10">
                    {pageSizeOptions.map((n) => (
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

            {/* View Log button */}
            <button
              onClick={() => setShowLogModal(true)}
              className="bg-gray-600 text-white px-4 py-2 rounded-lg hover:bg-gray-700 text-sm font-medium"
            >
              {t("viewLog")}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white shadow-xl rounded-2xl overflow-hidden">

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full table-fixed divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {/* Checkbox Column - Only visible when filtering by approver */}
                {selectedFromApprover && (
                  <th className="w-12 px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={displayedLines.length > 0 && displayedLines.every((l) => selectedLineIds.has(l.lineOfApprovalId))}
                      onChange={() => toggleSelectAll(displayedLines.map((l) => l.lineOfApprovalId))}
                      className="w-4 h-4 text-orange-600 border-gray-300 rounded focus:ring-orange-500"
                    />
                  </th>
                )}
                <th className="w-16 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  #
                </th>

                {/* Line Name Column with Excel Filter */}
                <th className={`${selectedFromApprover ? 'w-56' : 'w-64'} px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative`}>
                  <div className="flex items-center justify-normal">
                    <span className="flex items-center gap-1">
                      Line Name
                      {(columnFilters.lineName || sortColumn === "lineName") && (
                        <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                      )}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenFilterDropdown(openFilterDropdown === "lineName" ? null : "lineName");
                      }}
                      className="p-1 hover:bg-gray-200 rounded transition-colors"
                    >
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                  {/* Dropdown Menu */}
                  {openFilterDropdown === "lineName" && (
                    <div
                      ref={filterDropdownRef}
                      className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="p-2 border-b border-gray-100">
                        <button
                          onClick={() => handleSort("lineName", "asc")}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "lineName" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                          </svg>
                          Sort A to Z
                        </button>
                        <button
                          onClick={() => handleSort("lineName", "desc")}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "lineName" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                          </svg>
                          Sort Z to A
                        </button>
                        {sortColumn === "lineName" && (
                          <button
                            onClick={clearSort}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 text-red-600"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Clear Sort
                          </button>
                        )}
                      </div>
                      <div className="p-2">
                        <label className="block text-xs text-gray-500 mb-1">Filter by text:</label>
                        <input
                          type="text"
                          placeholder="Type to filter..."
                          value={columnFilters.lineName}
                          onChange={(e) => handleColumnFilterChange("lineName", e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        {columnFilters.lineName && (
                          <button
                            onClick={() => clearColumnFilter("lineName")}
                            className="mt-2 w-full flex items-center justify-center gap-1 px-3 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Clear Filter
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
                      Business Unit
                      {(dynamicBUFilterIds.length > 0 || sortColumn === "businessUnitName") && (
                        <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                      )}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenFilterDropdown(openFilterDropdown === "businessUnitName" ? null : "businessUnitName");
                      }}
                      className="p-1 hover:bg-gray-200 rounded transition-colors"
                    >
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                  {openFilterDropdown === "businessUnitName" && (
                    <div
                      ref={filterDropdownRef}
                      className="absolute top-full left-0 mt-1 w-96 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="p-2 border-b border-gray-100">
                        <button
                          onClick={() => handleSort("businessUnitName", "asc")}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "businessUnitName" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                          </svg>
                          Sort A to Z
                        </button>
                        <button
                          onClick={() => handleSort("businessUnitName", "desc")}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "businessUnitName" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                          </svg>
                          Sort Z to A
                        </button>
                        {sortColumn === "businessUnitName" && (
                          <button
                            onClick={clearSort}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 text-red-600"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Clear Sort
                          </button>
                        )}
                      </div>
                      <div className="p-2">
                        <label className="block text-xs font-medium text-gray-700 mb-2">Filter by Business Unit:</label>
                        {availableBusinessUnits.length === 0 ? (
                          <div className="text-center py-4 px-2 bg-gray-50 rounded border border-gray-200">
                            <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                            </svg>
                            <p className="text-sm text-gray-500 italic">No business units available</p>
                          </div>
                        ) : (
                          <>
                            <div className="max-h-48 overflow-y-auto">
                              {availableBusinessUnits.map((buName) => (
                                <label
                                  key={buName}
                                  className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 rounded cursor-pointer"
                                >
                                  <input
                                    type="checkbox"
                                    checked={dynamicBUFilterIds.includes(buName)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setDynamicBUFilterIds([...dynamicBUFilterIds, buName]);
                                      } else {
                                        setDynamicBUFilterIds(dynamicBUFilterIds.filter((id) => id !== buName));
                                      }
                                    }}
                                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 pointer-events-none"
                                  />
                                  <span className="text-sm text-gray-700">{buName}</span>
                                </label>
                              ))}
                            </div>
                            {dynamicBUFilterIds.length > 0 && (
                              <button
                                onClick={() => {
                                  setDynamicBUFilterIds([]);
                                }}
                                className="mt-2 w-full flex items-center justify-center gap-1 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded border border-red-200"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                Clear Filter
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </th>

                {/* Department Column with Excel Filter */}
                <th className="w-32 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1">
                      Department
                      {(dynamicDeptFilterIds.length > 0 || sortColumn === "departmentName") && (
                        <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                      )}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenFilterDropdown(openFilterDropdown === "departmentName" ? null : "departmentName");
                      }}
                      className="p-1 hover:bg-gray-200 rounded transition-colors"
                    >
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                  {openFilterDropdown === "departmentName" && (
                    <div
                      ref={filterDropdownRef}
                      className="absolute top-full left-0 mt-1 w-96 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="p-2 border-b border-gray-100">
                        <button
                          onClick={() => handleSort("departmentName", "asc")}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "departmentName" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                          </svg>
                          Sort A to Z
                        </button>
                        <button
                          onClick={() => handleSort("departmentName", "desc")}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "departmentName" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                          </svg>
                          Sort Z to A
                        </button>
                        {sortColumn === "departmentName" && (
                          <button
                            onClick={clearSort}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 text-red-600"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Clear Sort
                          </button>
                        )}
                      </div>
                      <div className="p-2">
                        <label className="block text-xs font-medium text-gray-700 mb-2">
                          {dynamicBUFilterIds.length > 0
                            ? `Filter by Department (${dynamicBUFilterIds.length} BU${dynamicBUFilterIds.length > 1 ? 's' : ''} selected):`
                            : "Filter by Department:"}
                        </label>
                        {availableDepartments.length === 0 ? (
                          <div className="text-center py-4 px-2 bg-gray-50 rounded border border-gray-200">
                            <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                            </svg>
                            <p className="text-sm text-gray-500 italic">
                              {dynamicBUFilterIds.length > 0
                                ? "No departments available for selected BU(s)"
                                : "Select a Business Unit first"}
                            </p>
                          </div>
                        ) : (
                          <>
                            <div className="max-h-48 overflow-y-auto">
                              {availableDepartments.map((deptName) => (
                                <label
                                  key={deptName}
                                  className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 rounded cursor-pointer"
                                >
                                  <input
                                    type="checkbox"
                                    checked={dynamicDeptFilterIds.includes(deptName)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setDynamicDeptFilterIds([...dynamicDeptFilterIds, deptName]);
                                      } else {
                                        setDynamicDeptFilterIds(dynamicDeptFilterIds.filter((id) => id !== deptName));
                                      }
                                    }}
                                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 pointer-events-none"
                                  />
                                  <span className="text-sm text-gray-700">{deptName}</span>
                                </label>
                              ))}
                            </div>
                            {dynamicDeptFilterIds.length > 0 && (
                              <button
                                onClick={() => {
                                  setDynamicDeptFilterIds([]);
                                }}
                                className="mt-2 w-full flex items-center justify-center gap-1 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded border border-red-200"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                Clear Filter
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </th>

                {/* Memo Type Column with Excel Filter */}
                <th className="w-40 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                  <div className="flex items-center justify-normal">
                    <span className="flex items-center gap-1">
                      Memo Type
                      {(dynamicMemoTypeFilterId !== "all" || sortColumn === "memoTypeName") && (
                        <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                      )}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenFilterDropdown(openFilterDropdown === "memoTypeName" ? null : "memoTypeName");
                      }}
                      className="p-1 hover:bg-gray-200 rounded transition-colors"
                    >
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                  {openFilterDropdown === "memoTypeName" && (
                    <div
                      ref={filterDropdownRef}
                      className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="p-2 border-b border-gray-100">
                        <button
                          onClick={() => handleSort("memoTypeName", "asc")}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "memoTypeName" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                          </svg>
                          Sort A to Z
                        </button>
                        <button
                          onClick={() => handleSort("memoTypeName", "desc")}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "memoTypeName" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                          </svg>
                          Sort Z to A
                        </button>
                        {sortColumn === "memoTypeName" && (
                          <button
                            onClick={clearSort}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 text-red-600"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Clear Sort
                          </button>
                        )}
                      </div>
                      <div className="p-2">
                        <label className="block text-xs font-medium text-gray-700 mb-2">Filter by Memo Type:</label>
                        {availableMemoTypes.length === 0 ? (
                          <div className="text-center py-4 px-2 bg-gray-50 rounded border border-gray-200">
                            <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <p className="text-sm text-gray-500 italic">No memo types available</p>
                          </div>
                        ) : (
                          <>
                            <select
                              value={dynamicMemoTypeFilterId}
                              onChange={(e) => {
                                setDynamicMemoTypeFilterId(e.target.value);
                                setOpenFilterDropdown(null);
                              }}
                              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                            >
                              <option value="all">All Memo Types</option>
                              {availableMemoTypes.map((memoType) => (
                                <option key={memoType.name} value={memoType.name}>
                                  {memoType.abbr ? `${memoType.abbr} - ${memoType.name}` : memoType.name}
                                </option>
                              ))}
                            </select>
                            {dynamicMemoTypeFilterId !== "all" && (
                              <button
                                onClick={() => {
                                  setDynamicMemoTypeFilterId("all");
                                  setOpenFilterDropdown(null);
                                }}
                                className="mt-2 w-full flex items-center justify-center gap-1 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded border border-red-200"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                Clear Filter
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </th>

                <th className="flex-1 px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                  <div className="flex items-center justify-normal">
                    <span className="flex items-center gap-1">
                      Approvers
                      {(columnFilters.approvers || sortColumn === "levelCount") && (
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
                          title="Clear all filters and sorting"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          Clear All
                        </button>
                      )}
                    </div>
                  </div>
                  {/* Dropdown Menu */}
                  {openFilterDropdown === "approvers" && (
                    <div
                      ref={filterDropdownRef}
                      className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="p-2 border-b border-gray-100">
                        <button
                          onClick={() => {
                            setSortColumn("levelCount");
                            setSortDirection("asc");
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "levelCount" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                          </svg>
                          Sort by Level Count (Asc)
                        </button>
                        <button
                          onClick={() => {
                            setSortColumn("levelCount");
                            setSortDirection("desc");
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "levelCount" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                          </svg>
                          Sort by Level Count (Desc)
                        </button>
                        {sortColumn === "levelCount" && (
                          <button
                            onClick={clearSort}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 text-red-600"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Clear Sort
                          </button>
                        )}
                      </div>
                      <div className="p-2">
                        <label className="block text-xs text-gray-500 mb-1">Filter by approver name:</label>
                        <input
                          type="text"
                          placeholder="Type approver name..."
                          value={columnFilters.approvers}
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
                            Clear Filter
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {displayedLines.length === 0 ? (
                <tr>
                  <td colSpan={selectedFromApprover ? 7 : 6} className="px-3 py-8 text-center text-gray-500">
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
                      <p className="font-medium">No approval lines found</p>
                      <p className="text-xs text-gray-400">
                        {selectedFromApprover
                          ? "No lines found for this approver"
                          : "Try adjusting your search criteria"}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                displayedLines.map((line, index) => (
                  <tr
                    key={line.lineOfApprovalId}
                    className={`transition-colors cursor-pointer ${
                      editedLineIds.has(line.lineOfApprovalId) ? 'bg-green-50/70 hover:bg-green-100/70' :
                      selectedLineIds.has(line.lineOfApprovalId) ? 'bg-orange-50 hover:bg-orange-100' : 'hover:bg-gray-50'
                      }`}
                    onClick={() => handleRowClick(line)}
                  >
                    {/* Checkbox Column */}
                    {selectedFromApprover && (
                      <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedLineIds.has(line.lineOfApprovalId)}
                          onChange={() => toggleLineSelection(line.lineOfApprovalId)}
                          className="w-4 h-4 text-orange-600 border-gray-300 rounded focus:ring-orange-500"
                        />
                      </td>
                    )}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-xs font-medium text-gray-500">{index + 1}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div
                          className="text-sm font-medium text-gray-900 line-clamp-2"
                          title={line.lineName || "-"}
                        >
                          {line.lineName || "-"}
                        </div>
                        {editedLineIds.has(line.lineOfApprovalId) && (
                          <span className="inline-flex flex-shrink-0 items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 border border-green-300">
                            Edited
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div
                        className="text-xs text-gray-900 truncate"
                        title={line.businessUnitName || "-"}
                      >
                        {line.businessUnitName || "-"}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div
                        className="text-xs text-gray-900 truncate"
                        title={line.departmentName || "-"}
                      >
                        {line.departmentName || "-"}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs text-gray-900 truncate">
                        {line.memoTypeName ? (
                          <span
                            title={`${line.memoTypeName}${line.memoTypeAbbr ? ` (${line.memoTypeAbbr})` : ""
                              }`}
                          >
                            {line.memoTypeAbbr || line.memoTypeName}
                          </span>
                        ) : (
                          "-"
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs text-gray-900">
                        {line.slots.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {(() => {
                              // Group slots by level
                              const groupedSlots = line.slots.reduce((acc, slot) => {
                                if (!acc[slot.level]) acc[slot.level] = [];
                                acc[slot.level].push(slot);
                                return acc;
                              }, {} as Record<number, typeof line.slots>);

                              return Object.entries(groupedSlots)
                                .sort(([a], [b]) => parseInt(a) - parseInt(b))
                                .map(([level, slots]) => {
                                  // Determine approval requirement for this level
                                  const approvalReq = slots.length > 1 
                                    ? (slots[0]?.approvalRequirement || "ALL")
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
                                            Level {parseInt(level) + 1}
                                          </span>
                                          <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium border ${
                                            approvalReq === "ANY" 
                                              ? "bg-orange-50 text-orange-700 border-orange-200" 
                                              : "bg-green-50 text-green-700 border-green-200"
                                          }`}>
                                            {approvalReq === "ANY" ? "Any" : "All"}
                                          </span>
                                        </div>

                                      </div>
                                      
                                      {/* Approvers List */}
                                      <div className="flex flex-wrap gap-1">
                                        {slots.map((slot, slotIndex) => {
                                          const slotDisplay = getSlotTypeDisplay(slot.slotType);
                                          return (
                                            <div key={slotIndex} className="flex items-center gap-1">
                                              {slot.userName ? (
                                                <span className="inline-flex items-center px-2 py-1 rounded-md bg-gray-100 text-xs font-medium text-gray-800 border" title={slot.userName}>
                                                  {slot.userName.length > 12 ? `${slot.userName.substring(0, 12)}...` : slot.userName}
                                                </span>
                                              ) : (
                                                <span
                                                  className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${slotDisplay.badgeClass}`}
                                                  title={slotDisplay.text}
                                                >
                                                  {slotDisplay.text}
                                                </span>
                                              )}
                                              {slot.isSigReq && (
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
                        ) : (
                          <span className="text-gray-400 text-xs">No approvers</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer with pagination */}
        {sortedLines.length > 0 && (
          <div className="bg-white px-6 py-3 border-t border-gray-200">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              {/* Results info */}
              <div className="text-sm text-gray-700">
                {pageSize === 0 ? (
                  `Showing all ${sortedLines.length} approval line${sortedLines.length !== 1 ? "s" : ""}`
                ) : (
                  `Showing ${Math.min((currentPage - 1) * pageSize + 1, sortedLines.length)} to ${Math.min(currentPage * pageSize, sortedLines.length)} of ${sortedLines.length} approval line${sortedLines.length !== 1 ? "s" : ""}`
                )}
                {selectedFromApprover && (
                  <span className="text-orange-600 ml-1">
                    containing {selectedFromApprover.name}
                  </span>
                )}
              </div>

              {/* Pagination buttons - only show if pageSize is not 0 and there are multiple pages */}
              {pageSize !== 0 && totalPages > 1 && (
                <div className="flex items-center gap-2">
                  {/* Previous button */}
                  <button
                    onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="px-3 py-2 text-sm font-medium text-gray-500 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>

                  {/* Page numbers */}
                  <div className="flex gap-1">
                    {getPageNumbers().map((pageNum) => (
                      <button
                        key={pageNum}
                        onClick={() => setCurrentPage(pageNum)}
                        className={`px-3 py-2 text-sm font-medium rounded-md ${
                          currentPage === pageNum
                            ? 'bg-orange-500 text-white'
                            : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        {pageNum}
                      </button>
                    ))}
                  </div>

                  {/* Next button */}
                  <button
                    onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                    className="px-3 py-2 text-sm font-medium text-gray-500 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Detail/Edit Modal */}
      {isModalOpen && selectedLine && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={isEditMode ? undefined : closeModal}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden m-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-[#183e33] to-[#2a6350] px-6 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">
                  {isEditMode ? "Edit Line of Approval" : "Line of Approval Details"}
                </h2>
                <p className="text-sm text-white/70 mt-1">#{selectedLine.lineOfApprovalId}</p>
              </div>
              <button
                onClick={closeModal}
                className="text-white/80 hover:text-white transition-colors p-1 hover:bg-white/10 rounded-lg"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto max-h-[calc(90vh-160px)]">
              {isEditMode ? (
                /* Edit Mode */
                <>
                  {/* Line Name Input */}
                  <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Line Name</label>
                    <input
                      type="text"
                      value={editLineName}
                      onChange={(e) => setEditLineName(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#183e33] focus:border-transparent"
                      placeholder="Enter line name..."
                    />
                  </div>

                  {/* Read-only Info */}
                  <div className="grid grid-cols-3 gap-4 mb-6">
                    <div className="bg-gray-50 rounded-xl p-3">
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Memo Type
                      </label>
                      <p className="text-sm text-gray-900 mt-1">
                        {selectedLine.memoTypeName || "-"}
                      </p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-3">
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Business Unit
                      </label>
                      <p className="text-sm text-gray-900 mt-1">
                        {selectedLine.businessUnitName || "-"}
                      </p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-3">
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Department
                      </label>
                      <p className="text-sm text-gray-900 mt-1">
                        {selectedLine.departmentName || "-"}
                      </p>
                    </div>
                  </div>

                  {/* Approvers Section */}
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-gray-900 flex items-center">
                        <svg
                          className="w-4 h-4 mr-2 text-[#183e33]"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                          />
                        </svg>
                        Approval Levels ({Object.keys(editSlots.reduce((acc, slot) => ({ ...acc, [slot.level]: true }), {})).length})
                      </h3>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">
                          {editSlots.length} total approver{editSlots.length !== 1 ? 's' : ''}
                        </span>
                        <button
                          onClick={addSlot}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-[#183e33] bg-[#183e33]/10 rounded-lg hover:bg-[#183e33]/20 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 4v16m8-8H4"
                            />
                          </svg>
                          Add Approver
                        </button>
                      </div>
                    </div>

                    <div className="space-y-4" ref={dropdownRef}>
                      {(() => {
                        // Group slots by level for better organization
                        const groupedSlots = editSlots.reduce((acc, slot, originalIndex) => {
                          if (!acc[slot.level]) acc[slot.level] = [];
                          acc[slot.level].push({ ...slot, originalIndex });
                          return acc;
                        }, {} as Record<number, Array<EditableSlot & { originalIndex: number }>>);

                        return Object.entries(groupedSlots)
                          .sort(([a], [b]) => parseInt(a) - parseInt(b))
                          .map(([level, slots]) => (
                            <div key={level} className="border border-gray-200 rounded-xl overflow-hidden bg-white">
                              {/* Level Header */}
                              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-4 py-3 border-b border-blue-100">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-700 font-bold text-sm">
                                      L{parseInt(level) + 1}
                                    </div>
                                    <div>
                                      <h4 className="text-sm font-semibold text-blue-900">
                                        Level {parseInt(level) + 1} Approvers
                                      </h4>
                                      <p className="text-xs text-blue-600">
                                        {slots.length} approver{slots.length !== 1 ? 's' : ''} at this level
                                        {slots.length > 1 && (
                                          <span className="ml-1 text-blue-500">• Multiple approvers can approve in parallel</span>
                                        )}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-3">
                                    {/* Approval Requirement Selector - only show if multiple approvers */}
                                    {slots.length > 1 && (
                                      <div className="flex items-center gap-2">
                                        <label className="text-xs font-medium text-blue-700">Approval Required:</label>
                                        <select
                                          value={slots[0]?.approvalRequirement || "ALL"}
                                          onChange={(e) => {
                                            const newRequirement = e.target.value as "ALL" | "ANY";
                                            // Update all slots at this level to have the same approval requirement
                                            slots.forEach(slot => {
                                              updateSlot(slot.originalIndex, "approvalRequirement", newRequirement);
                                            });
                                          }}
                                          className="px-2 py-1 text-xs border border-blue-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        >
                                          <option value="ALL">All Approvers</option>
                                          <option value="ANY">Any Approver</option>
                                        </select>
                                      </div>
                                    )}
                                    <button
                                      onClick={() => {
                                        const newSlot: EditableSlot = {
                                          level: parseInt(level),
                                          userId: null,
                                          userName: null,
                                          slotType: "FIXED_USER",
                                          isSigReq: false,
                                          roleDescription: "",
                                          approvalRequirement: slots[0]?.approvalRequirement || "ALL",
                                        };
                                        setEditSlots(prev => [...prev, newSlot]);
                                      }}
                                      className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 bg-blue-100 rounded-md hover:bg-blue-200 transition-colors"
                                      title="Add another approver to this level"
                                    >
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                      </svg>
                                      Add to Level
                                    </button>
                                  </div>
                                </div>
                              </div>

                              {/* Approvers in this level */}
                              <div className="divide-y divide-gray-100">
                                {slots.map((slot, slotIndex) => (
                                  <div key={slot.originalIndex} className="p-4 hover:bg-gray-50 transition-colors">
                                    <div className="flex items-start gap-4">
                                      {/* Approver Number within Level */}
                                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-100 text-gray-600 font-medium text-xs shrink-0">
                                        #{slotIndex + 1}
                                      </div>

                                      {/* Slot Details */}
                                      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3">
                                        {/* Slot Type */}
                                        <div>
                                          <label className="text-xs font-medium text-gray-500 mb-1 block">
                                            Slot Type
                                          </label>
                                          <select
                                            value={slot.slotType}
                                            onChange={(e) => updateSlot(slot.originalIndex, "slotType", e.target.value)}
                                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#183e33]"
                                          >
                                            {SLOT_TYPES.map((type) => (
                                              <option key={type.value} value={type.value}>
                                                {type.label}
                                              </option>
                                            ))}
                                          </select>
                                        </div>

                                        {/* User Selection (only for FIXED_USER) */}
                                        {slot.slotType === "FIXED_USER" && (
                                          <div className="relative">
                                            <label className="text-xs font-medium text-gray-500 mb-1 block">
                                              Assigned User
                                            </label>
                                            <input
                                              type="text"
                                              placeholder={slot.userName || "Search user..."}
                                              value={activeSlotIndex === slot.originalIndex ? userSearchQuery : ""}
                                              onChange={(e) => handleUserSearchChange(e.target.value, slot.originalIndex)}
                                              onFocus={() => setActiveSlotIndex(slot.originalIndex)}
                                              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#183e33]"
                                            />
                                            {slot.userName && activeSlotIndex !== slot.originalIndex && (
                                              <div className="absolute right-2 top-7 flex items-center">
                                                <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                                                  {slot.userName}
                                                </span>
                                              </div>
                                            )}

                                            {/* Search Results Dropdown */}
                                            {activeSlotIndex === slot.originalIndex && (
                                              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                                                {isSearching ? (
                                                  <div className="p-3 text-center text-gray-500 text-sm">
                                                    Searching...
                                                  </div>
                                                ) : userSearchResults.length > 0 ? (
                                                  userSearchResults.map((user) => (
                                                    <button
                                                      key={user.id}
                                                      onClick={() => selectUser(user, slot.originalIndex)}
                                                      className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2"
                                                    >
                                                      <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-medium text-gray-600">
                                                        {(user.firstName?.[0] || user.email?.[0] || "?").toUpperCase()}
                                                      </div>
                                                      <div>
                                                        <div className="font-medium text-gray-900">
                                                          {[user.firstName, user.lastName].filter(Boolean).join(" ") ||
                                                            user.email ||
                                                            "Unknown"}
                                                        </div>
                                                        {user.nickname && (
                                                          <div className="text-xs text-gray-500">({user.nickname})</div>
                                                        )}
                                                      </div>
                                                    </button>
                                                  ))
                                                ) : userSearchQuery ? (
                                                  <div className="p-3 text-center text-gray-500 text-sm">
                                                    No users found
                                                  </div>
                                                ) : null}
                                              </div>
                                            )}
                                          </div>
                                        )}

                                        {/* Role Description */}
                                        <div className={slot.slotType !== "FIXED_USER" ? "md:col-span-1" : ""}>
                                          <label className="text-xs font-medium text-gray-500 mb-1 block">
                                            Role Description
                                          </label>
                                          <input
                                            type="text"
                                            value={slot.roleDescription}
                                            onChange={(e) => updateSlot(slot.originalIndex, "roleDescription", e.target.value)}
                                            placeholder="e.g., Manager, Director..."
                                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#183e33]"
                                          />
                                        </div>

                                        {/* Level Control */}
                                        <div>
                                          <label className="text-xs font-medium text-gray-500 mb-1 block">
                                            Approval Level
                                          </label>
                                          <div className="flex items-center gap-2">
                                            <select
                                              value={slot.level}
                                              onChange={(e) => updateSlot(slot.originalIndex, "level", parseInt(e.target.value))}
                                              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#183e33]"
                                            >
                                              {Array.from({ length: Math.max(5, editSlots.length + 1) }, (_, i) => (
                                                <option key={i} value={i}>
                                                  Level {i + 1}
                                                </option>
                                              ))}
                                            </select>
                                            <div className="text-xs text-gray-400">
                                              {slots.length > 1 && slotIndex === 0 && (
                                                <span className="text-blue-600">Parallel</span>
                                              )}
                                            </div>
                                          </div>
                                        </div>

                                        {/* Signature Required Toggle */}
                                        <div className="flex items-center">
                                          <label className="flex items-center cursor-pointer">
                                            <input
                                              type="checkbox"
                                              checked={slot.isSigReq}
                                              onChange={(e) => updateSlot(slot.originalIndex, "isSigReq", e.target.checked)}
                                              className="w-4 h-4 text-[#183e33] border-gray-300 rounded focus:ring-[#183e33]"
                                            />
                                            <span className="ml-2 text-sm text-gray-700">Signature Required</span>
                                          </label>
                                        </div>
                                      </div>

                                      {/* Remove Button */}
                                      <button
                                        onClick={() => removeSlot(slot.originalIndex)}
                                        className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0"
                                        title="Remove this approver"
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
                                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                          />
                                        </svg>
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ));
                      })()}

                      {editSlots.length === 0 && (
                        <div className="bg-gray-50 rounded-xl p-6 text-center">
                          <svg
                            className="w-10 h-10 text-gray-300 mx-auto mb-2"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                            />
                          </svg>
                          <p className="text-sm text-gray-500 mb-2">No approver slots configured</p>
                          <p className="text-xs text-gray-400">Click "Add Approver" to create your first approval level</p>
                        </div>
                      )}
                    </div>

                    {/* Help Text for Multiple Approvers */}
                    {editSlots.length > 0 && (
                      <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                        <div className="flex items-start gap-2">
                          <svg className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <div className="text-xs text-blue-700">
                            <p className="font-medium mb-1">Approval Flow Tips:</p>
                            <ul className="space-y-1 text-blue-600">
                              <li>• Approvers at the same level can approve in parallel (any one can approve)</li>
                              <li>• Higher level numbers require approval from lower levels first</li>
                              <li>• Use "Add to Level" to add multiple approvers who can approve independently</li>
                              <li>• Change the level dropdown to move approvers between levels</li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                /* View Mode */
                <>
                  {/* Basic Info Grid */}
                  <div className="grid grid-cols-2 gap-4 mb-6">
                    <div className="bg-gray-50 rounded-xl p-4">
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Line Name
                      </label>
                      <p className="text-sm font-semibold text-gray-900 mt-1">
                        {selectedLine.lineName || "-"}
                      </p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-4">
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Memo Type
                      </label>
                      <p className="text-sm font-semibold text-gray-900 mt-1">
                        {selectedLine.memoTypeName || "-"}
                        {selectedLine.memoTypeAbbr && (
                          <span className="ml-2 text-xs font-normal text-gray-500">
                            ({selectedLine.memoTypeAbbr})
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-4">
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Business Unit
                      </label>
                      <p className="text-sm font-semibold text-gray-900 mt-1">
                        {selectedLine.businessUnitName || "-"}
                      </p>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-4">
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Department
                      </label>
                      <p className="text-sm font-semibold text-gray-900 mt-1">
                        {selectedLine.departmentName || "-"}
                      </p>
                    </div>
                  </div>

                  {/* Approvers Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
                      <svg
                        className="w-4 h-4 mr-2 text-[#183e33]"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                        />
                      </svg>
                      Approvers ({selectedLine.slots.length})
                    </h3>

                    {selectedLine.slots.length > 0 ? (
                      <div className="space-y-4">
                        {(() => {
                          // Group slots by level
                          const groupedSlots = selectedLine.slots.reduce((acc, slot) => {
                            if (!acc[slot.level]) acc[slot.level] = [];
                            acc[slot.level].push(slot);
                            return acc;
                          }, {} as Record<number, typeof selectedLine.slots>);

                          return Object.entries(groupedSlots)
                            .sort(([a], [b]) => parseInt(a) - parseInt(b))
                            .map(([level, slots]) => (
                              <div key={level} className="border border-gray-200 rounded-xl overflow-hidden">
                                {/* Level Header */}
                                <div className="bg-blue-50 px-4 py-2 border-b border-blue-100">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-700 font-bold text-sm">
                                        L{parseInt(level) + 1}
                                      </div>
                                      <div>
                                        <h4 className="text-sm font-semibold text-blue-900">
                                          Level {parseInt(level) + 1} Approvers
                                        </h4>
                                        <p className="text-xs text-blue-600">
                                          {slots.length} approver{slots.length !== 1 ? 's' : ''} at this level
                                        </p>
                                      </div>
                                    </div>
                                    {/* Approval Requirement Badge */}
                                    {slots.length > 1 && (
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs text-blue-600 font-medium">Approval Required:</span>
                                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                                          slots[0]?.approvalRequirement === "ANY" 
                                            ? "bg-orange-100 text-orange-800 border border-orange-200" 
                                            : "bg-green-100 text-green-800 border border-green-200"
                                        }`}>
                                          {slots[0]?.approvalRequirement === "ANY" ? "Any Approver" : "All Approvers"}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </div>

                                {/* Approvers in this level */}
                                <div className="divide-y divide-gray-100">
                                  {slots.map((slot, slotIndex) => (
                                    <div key={slotIndex} className="bg-white p-4 hover:bg-gray-50 transition-colors">
                                      <div className="flex items-start justify-between">
                                        <div className="flex items-center gap-3">
                                          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-100 text-gray-600 font-medium text-xs">
                                            {slot.userName ?
                                              slot.userName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) :
                                              '?'
                                            }
                                          </div>
                                          <div>
                                            <p className="font-medium text-gray-900">
                                              {slot.userName || "Unassigned"}
                                            </p>
                                            <div className="flex items-center gap-2 mt-1">
                                              {(() => {
                                                const slotDisplay = getSlotTypeDisplay(slot.slotType);
                                                return (
                                                  <span
                                                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${slotDisplay.badgeClass}`}
                                                  >
                                                    {slotDisplay.text}
                                                  </span>
                                                );
                                              })()}
                                              {slot.roleDescription && (
                                                <span className="text-xs text-gray-500">
                                                  {slot.roleDescription}
                                                </span>
                                              )}
                                            </div>
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {slot.isTarget && (
                                            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                                              <svg
                                                className="w-3 h-3 mr-1"
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
                                              Target
                                            </span>
                                          )}
                                          {slot.isSigReq && (
                                            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                              <svg
                                                className="w-3 h-3 mr-1"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24"
                                              >
                                                <path
                                                  strokeLinecap="round"
                                                  strokeLinejoin="round"
                                                  strokeWidth={2}
                                                  d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                                                />
                                              </svg>
                                              Signature Required
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ));
                        })()}
                      </div>
                    ) : (
                      <div className="bg-gray-50 rounded-xl p-6 text-center">
                        <svg
                          className="w-10 h-10 text-gray-300 mx-auto mb-2"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                          />
                        </svg>
                        <p className="text-sm text-gray-500">No approvers assigned to this line</p>
                      </div>
                    )}
                  </div>

                  {/* Memo Types Section */}
                  <div className="mt-6">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center">
                      <svg
                        className="w-4 h-4 mr-2 text-[#183e33]"
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
                      Memo Types Using This Line ({loadingMemoTypes ? "..." : memoTypesForLine.length})
                    </h3>

                    {loadingMemoTypes ? (
                      <div className="bg-gray-50 rounded-xl p-6 text-center">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#183e33] mx-auto mb-2"></div>
                        <p className="text-sm text-gray-500">Loading memo types...</p>
                      </div>
                    ) : memoTypesForLine.length > 0 ? (
                      <div className="space-y-3">
                        {memoTypesForLine.map((memoType) => (
                          <div key={memoType.id} className="border border-gray-200 rounded-xl p-4 hover:bg-gray-50 transition-colors">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <h4 className="font-medium text-gray-900">{memoType.name}</h4>
                                  {memoType.abbreviation && (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                                      {memoType.abbreviation}
                                    </span>
                                  )}
                                </div>
                                {memoType.description && (
                                  <p className="text-sm text-gray-600 mb-2">{memoType.description}</p>
                                )}
                                <div className="flex items-center gap-4 text-xs text-gray-500">
                                  {memoType.businessUnit && (
                                    <div className="flex items-center gap-1">
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                                      </svg>
                                      <span>BU: {memoType.businessUnit.name}</span>
                                    </div>
                                  )}
                                  {memoType.department && (
                                    <div className="flex items-center gap-1">
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                      </svg>
                                      <span>Dept: {memoType.department.name}</span>
                                    </div>
                                  )}
                                  <div className="flex items-center gap-1">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3a1 1 0 011-1h6a1 1 0 011 1v4h3a2 2 0 012 2v1a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h2z" />
                                    </svg>
                                    <span>ID: {memoType.id}</span>
                                  </div>
                                </div>
                              </div>
                              <div className="text-xs text-gray-400">
                                Created: {new Date(memoType.createdAt).toLocaleDateString()}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-gray-50 rounded-xl p-6 text-center">
                        <svg
                          className="w-10 h-10 text-gray-300 mx-auto mb-2"
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
                        <p className="text-sm text-gray-500">No memo types are using this line of approval</p>
                        <p className="text-xs text-gray-400 mt-1">This line is available for assignment to memo types</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-between">
              {isEditMode ? (
                <>
                  <button
                    onClick={cancelEdit}
                    disabled={isSaving}
                    className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm font-medium disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveChanges}
                    disabled={isSaving}
                    className="px-4 py-2 bg-[#183e33] text-white rounded-lg hover:bg-[#2a6350] transition-colors text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                  >
                    {isSaving ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                        Saving...
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
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                        Save Changes
                      </>
                    )}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={enterEditMode}
                    className="px-4 py-2 bg-[#183e33] text-white rounded-lg hover:bg-[#2a6350] transition-colors text-sm font-medium flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                      />
                    </svg>
                    Edit
                  </button>
                  <button
                    onClick={closeModal}
                    className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm font-medium"
                  >
                    Close
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bulk Update Approver Modal */}
      {isBulkUpdateModalOpen && selectedFromApprover && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={closeBulkUpdateModal}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-orange-500 to-orange-600 px-6 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">Bulk Update Approver</h2>
                <p className="text-sm text-white/70 mt-1">
                  Update approver in {selectedLineIds.size} line{selectedLineIds.size !== 1 ? 's' : ''}
                </p>
              </div>
              <button
                onClick={closeBulkUpdateModal}
                className="text-white/80 hover:text-white transition-colors p-1 hover:bg-white/10 rounded-lg"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto flex-1">
              {/* Action Selection */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Choose Action
                </label>
                <div className="grid grid-cols-1 gap-2">
                  {/* Replace Approver */}
                  <label className="flex items-start gap-3 p-2 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
                    <input
                      type="radio"
                      name="bulkAction"
                      value="replace"
                      checked={bulkUpdateAction === "replace"}
                      onChange={(e) => setBulkUpdateAction(e.target.value as "replace" | "flexible" | "remove")}
                      className="w-4 h-4 text-orange-600 border-gray-300 focus:ring-orange-500 mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-gray-900">Replace Approver</div>
                      <div className="text-sm text-gray-500">Replace the selected approver with a new approver</div>
                    </div>
                  </label>

                  {/* Change to Flexible Slot */}
                  <label className="flex items-start gap-3 p-2 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
                    <input
                      type="radio"
                      name="bulkAction"
                      value="flexible"
                      checked={bulkUpdateAction === "flexible"}
                      onChange={(e) => setBulkUpdateAction(e.target.value as "replace" | "flexible" | "remove")}
                      className="w-4 h-4 text-orange-600 border-gray-300 focus:ring-orange-500 mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-gray-900">Change to Flexible Slot</div>
                      <div className="text-sm text-gray-500">Convert the approver position to a flexible slot</div>
                    </div>
                  </label>

                  {/* Remove Approver */}
                  <label className="flex items-start gap-3 p-2 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
                    <input
                      type="radio"
                      name="bulkAction"
                      value="remove"
                      checked={bulkUpdateAction === "remove"}
                      onChange={(e) => setBulkUpdateAction(e.target.value as "replace" | "flexible" | "remove")}
                      className="w-4 h-4 text-orange-600 border-gray-300 focus:ring-orange-500 mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-gray-900">Remove Approver</div>
                      <div className="text-sm text-gray-500 text-red-600">Completely remove the approver from the approval line</div>
                    </div>
                  </label>
                </div>
              </div>

              {/* From Approver */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Current Approver ({bulkUpdateAction === "replace" ? "will be replaced" : bulkUpdateAction === "flexible" ? "will become flexible slot" : "will be removed"})
                </label>
                <div className="flex items-center gap-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 font-bold">
                    {selectedFromApprover.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{selectedFromApprover.name}</p>
                    <p className="text-xs text-red-600">
                      {bulkUpdateAction === "replace" ? "This approver will be replaced" :
                        bulkUpdateAction === "flexible" ? "This position will become a flexible slot" :
                          "This approver will be removed"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Arrow - only show for replace action */}
              {bulkUpdateAction === "replace" && (
                <div className="flex justify-center mb-4">
                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                    <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    </svg>
                  </div>
                </div>
              )}

              {/* To Approver Search - only show for replace action */}
              {bulkUpdateAction === "replace" && (
                <div className="mb-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    New Approver (replacement)
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="Search for new approver..."
                      className="w-full pl-10 pr-4 py-3 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                      value={newApproverSearchQuery}
                      onChange={(e) => handleNewApproverSearchChange(e.target.value)}
                    />
                    <svg
                      className="absolute left-3 top-3.5 h-5 w-5 text-gray-400"
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

                    {/* Search Results Dropdown */}
                    {newApproverSearchQuery && !selectedNewApprover && (
                      <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {isSearchingNewApprover ? (
                          <div className="p-3 text-center text-gray-500 text-sm">
                            <div className="animate-spin inline-block w-4 h-4 border-2 border-gray-300 border-t-orange-500 rounded-full mr-2"></div>
                            Searching...
                          </div>
                        ) : newApproverSearchResults.length > 0 ? (
                          newApproverSearchResults
                            .filter((u) => u.id !== selectedFromApprover.id)
                            .map((user) => (
                              <button
                                key={user.id}
                                onClick={() => setSelectedNewApprover(user)}
                                className="w-full px-4 py-3 text-left text-sm hover:bg-orange-50 flex items-center gap-3 border-b border-gray-100 last:border-0"
                              >
                                <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-green-600 font-bold">
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
                        ) : (
                          <div className="p-3 text-center text-gray-500 text-sm">
                            No users found
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Selected New Approver */}
                  {selectedNewApprover && (
                    <div className="mt-3 flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                      <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-green-600 font-bold">
                        {(selectedNewApprover.firstName?.[0] || selectedNewApprover.email?.[0] || "?").toUpperCase()}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-gray-900">
                          {[selectedNewApprover.firstName, selectedNewApprover.lastName].filter(Boolean).join(" ") || selectedNewApprover.email || "Unknown"}
                        </p>
                        <p className="text-xs text-green-600">New approver</p>
                      </div>
                      <button
                        onClick={() => {
                          setSelectedNewApprover(null);
                          setNewApproverSearchQuery("");
                        }}
                        className="text-gray-400 hover:text-gray-600"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Summary */}
              <div className={`p-4 border rounded-lg ${bulkUpdateAction === "remove" ? "bg-red-50 border-red-200" : "bg-blue-50 border-blue-200"
                }`}>
                <div className="flex items-start gap-2">
                  <svg className={`w-5 h-5 mt-0.5 ${bulkUpdateAction === "remove" ? "text-red-500" : "text-blue-500"
                    }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className={`text-sm ${bulkUpdateAction === "remove" ? "text-red-700" : "text-blue-700"
                    }`}>
                    <p className="font-medium">This will update:</p>
                    <ul className={`mt-1 list-disc list-inside ${bulkUpdateAction === "remove" ? "text-red-600" : "text-blue-600"
                      }`}>
                      <li>{selectedLineIds.size} approval line{selectedLineIds.size !== 1 ? 's' : ''}</li>
                      <li>
                        {bulkUpdateAction === "replace" ? `Replace "${selectedFromApprover.name}" with the new approver` :
                          bulkUpdateAction === "flexible" ? `Change "${selectedFromApprover.name}" positions to flexible slots` :
                            `Remove "${selectedFromApprover.name}" from all selected lines`}
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3 flex-shrink-0">
              <button
                onClick={closeBulkUpdateModal}
                disabled={isBulkUpdating}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={performBulkUpdate}
                disabled={(bulkUpdateAction === "replace" && !selectedNewApprover) || isBulkUpdating}
                className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isBulkUpdating ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Updating...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {bulkUpdateAction === "replace" ? "Replace Approver" :
                      bulkUpdateAction === "flexible" ? "Change to Flexible" :
                        "Remove Approver"}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Update Signature Required Modal */}
      {isBulkSignatureModalOpen && selectedFromApprover && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={closeBulkSignatureModal}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-green-500 to-green-600 px-6 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">Bulk Update Signature Required</h2>
                <p className="text-sm text-white/70 mt-1">
                  Update signature requirement for {selectedLineIds.size} line{selectedLineIds.size !== 1 ? 's' : ''}
                </p>
              </div>
              <button
                onClick={closeBulkSignatureModal}
                className="text-white/80 hover:text-white transition-colors p-1 hover:bg-white/10 rounded-lg"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto flex-1">
              {/* Action Selection */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Choose Action
                </label>
                <div className="grid grid-cols-1 gap-2">
                  {/* Enable Signature Required */}
                  <label className="flex items-start gap-3 p-2 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
                    <input
                      type="radio"
                      name="bulkSignatureAction"
                      value="enable"
                      checked={bulkSignatureAction === "enable"}
                      onChange={(e) => setBulkSignatureAction(e.target.value as "enable" | "disable")}
                      className="w-4 h-4 text-green-600 border-gray-300 focus:ring-green-500 mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-gray-900">Enable Signature Required</div>
                      <div className="text-sm text-gray-500">Require signature for the selected approver in all selected lines</div>
                    </div>
                  </label>

                  {/* Disable Signature Required */}
                  <label className="flex items-start gap-3 p-2 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
                    <input
                      type="radio"
                      name="bulkSignatureAction"
                      value="disable"
                      checked={bulkSignatureAction === "disable"}
                      onChange={(e) => setBulkSignatureAction(e.target.value as "enable" | "disable")}
                      className="w-4 h-4 text-green-600 border-gray-300 focus:ring-green-500 mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-gray-900">Disable Signature Required</div>
                      <div className="text-sm text-gray-500">Remove signature requirement for the selected approver in all selected lines</div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Target Approver */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Target Approver ({bulkSignatureAction === "enable" ? "will require signature" : "signature requirement will be removed"})
                </label>
                <div className={`flex items-center gap-3 p-3 border rounded-lg ${bulkSignatureAction === "enable" ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
                  }`}>
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${bulkSignatureAction === "enable" ? "bg-green-100 text-green-600" : "bg-red-100 text-red-600"
                    }`}>
                    {selectedFromApprover.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{selectedFromApprover.name}</p>
                    <p className={`text-xs ${bulkSignatureAction === "enable" ? "text-green-600" : "text-red-600"
                      }`}>
                      {bulkSignatureAction === "enable" ? "Signature will be required" : "Signature requirement will be removed"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Summary */}
              <div className={`p-4 border rounded-lg ${bulkSignatureAction === "enable" ? "bg-green-50 border-green-200" : "bg-orange-50 border-orange-200"
                }`}>
                <div className="flex items-start gap-2">
                  <svg className={`w-5 h-5 mt-0.5 ${bulkSignatureAction === "enable" ? "text-green-500" : "text-orange-500"
                    }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className={`text-sm ${bulkSignatureAction === "enable" ? "text-green-700" : "text-orange-700"
                    }`}>
                    <p className="font-medium">This will update:</p>
                    <ul className={`mt-1 list-disc list-inside ${bulkSignatureAction === "enable" ? "text-green-600" : "text-orange-600"
                      }`}>
                      <li>{selectedLineIds.size} approval line{selectedLineIds.size !== 1 ? 's' : ''}</li>
                      <li>
                        {bulkSignatureAction === "enable"
                          ? `Enable signature requirement for "${selectedFromApprover.name}" in all selected lines`
                          : `Disable signature requirement for "${selectedFromApprover.name}" in all selected lines`
                        }
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3 flex-shrink-0">
              <button
                onClick={closeBulkSignatureModal}
                disabled={isBulkUpdatingSignature}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={performBulkSignatureUpdate}
                disabled={isBulkUpdatingSignature}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isBulkUpdatingSignature ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Updating...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {bulkSignatureAction === "enable" ? "Enable Signature" : "Disable Signature"}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Reorder Approver Modal */}
      {isBulkReorderModalOpen && selectedFromApprover && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={closeBulkReorderModal}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-purple-500 to-purple-600 px-6 py-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">Bulk Reorder Approver</h2>
                <p className="text-sm text-white/70 mt-1">
                  Reorder approver in {selectedLineIds.size} line{selectedLineIds.size !== 1 ? 's' : ''}
                </p>
              </div>
              <button
                onClick={closeBulkReorderModal}
                className="text-white/80 hover:text-white transition-colors p-1 hover:bg-white/10 rounded-lg"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto flex-1">
              {/* Target Approver */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Approver to Reorder
                </label>
                <div className="flex items-center gap-3 p-3 bg-purple-50 border border-purple-200 rounded-lg">
                  <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 font-bold">
                    {selectedFromApprover.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{selectedFromApprover.name}</p>
                    <p className="text-xs text-purple-600">Will be moved to a new level</p>
                  </div>
                </div>
              </div>

              {/* Action Selection */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Choose Reorder Action
                </label>
                <div className="grid grid-cols-1 gap-2">
                  {/* Move to First Level */}
                  <label className="flex items-start gap-3 p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-purple-50 transition-colors">
                    <input
                      type="radio"
                      name="bulkReorderAction"
                      value="moveToFirst"
                      checked={bulkReorderAction === "moveToFirst"}
                      onChange={(e) => setBulkReorderAction(e.target.value as "moveToFirst" | "plusOne" | "minusOne" | "moveToLast")}
                      className="w-4 h-4 text-purple-600 border-gray-300 focus:ring-purple-500 mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 11l7-7 7 7M5 19l7-7 7 7" />
                        </svg>
                        <span className="font-medium text-gray-900">Move to First Level</span>
                      </div>
                      <div className="text-sm text-gray-500 mt-1">Create a new first level and move the approver before all other approvers</div>
                    </div>
                  </label>

                  {/* Plus One Level (Move Later) */}
                  <label className="flex items-start gap-3 p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-purple-50 transition-colors">
                    <input
                      type="radio"
                      name="bulkReorderAction"
                      value="plusOne"
                      checked={bulkReorderAction === "plusOne"}
                      onChange={(e) => setBulkReorderAction(e.target.value as "moveToFirst" | "plusOne" | "minusOne" | "moveToLast")}
                      className="w-4 h-4 text-purple-600 border-gray-300 focus:ring-purple-500 mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                        </svg>
                        <span className="font-medium text-gray-900">Plus One Level</span>
                      </div>
                      <div className="text-sm text-gray-500 mt-1">Move one level later (e.g., L1 → L2). Creates a new level if at the last position</div>
                    </div>
                  </label>

                  {/* Minus One Level (Move Earlier) */}
                  <label className="flex items-start gap-3 p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-purple-50 transition-colors">
                    <input
                      type="radio"
                      name="bulkReorderAction"
                      value="minusOne"
                      checked={bulkReorderAction === "minusOne"}
                      onChange={(e) => setBulkReorderAction(e.target.value as "moveToFirst" | "plusOne" | "minusOne" | "moveToLast")}
                      className="w-4 h-4 text-purple-600 border-gray-300 focus:ring-purple-500 mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                        </svg>
                        <span className="font-medium text-gray-900">Minus One Level</span>
                      </div>
                      <div className="text-sm text-gray-500 mt-1">Move one level earlier (e.g., L3 → L2). Creates a new level if at the first position</div>
                    </div>
                  </label>

                  {/* Move to Last Level */}
                  <label className="flex items-start gap-3 p-3 border border-gray-200 rounded-lg cursor-pointer hover:bg-purple-50 transition-colors">
                    <input
                      type="radio"
                      name="bulkReorderAction"
                      value="moveToLast"
                      checked={bulkReorderAction === "moveToLast"}
                      onChange={(e) => setBulkReorderAction(e.target.value as "moveToFirst" | "plusOne" | "minusOne" | "moveToLast")}
                      className="w-4 h-4 text-purple-600 border-gray-300 focus:ring-purple-500 mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 13l-7 7-7-7m14-8l-7 7-7-7" />
                        </svg>
                        <span className="font-medium text-gray-900">Move to Last Level</span>
                      </div>
                      <div className="text-sm text-gray-500 mt-1">Create a new last level and move the approver after all other approvers</div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Info Box */}
              <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <svg className="w-5 h-5 mt-0.5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="text-sm text-purple-700">
                    <p className="font-medium">This will update:</p>
                    <ul className="mt-1 list-disc list-inside text-purple-600">
                      <li>{selectedLineIds.size} approval line{selectedLineIds.size !== 1 ? 's' : ''}</li>
                      <li>
                        {bulkReorderAction === "moveToFirst" && `Create a new first level for "${selectedFromApprover.name}"`}
                        {bulkReorderAction === "plusOne" && `Move "${selectedFromApprover.name}" one level later (creates new level if needed)`}
                        {bulkReorderAction === "minusOne" && `Move "${selectedFromApprover.name}" one level earlier (creates new level if needed)`}
                        {bulkReorderAction === "moveToLast" && `Create a new last level for "${selectedFromApprover.name}"`}
                      </li>
                      <li className="text-purple-500 italic">For +/- one level: if the target level has other approvers, they will approve in parallel</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3 flex-shrink-0">
              <button
                onClick={closeBulkReorderModal}
                disabled={isBulkReordering}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={performBulkReorder}
                disabled={isBulkReordering}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isBulkReordering ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Reordering...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Reorder Approver
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Log Modal */}
      <AdminLogModal
        isOpen={showLogModal}
        onClose={() => setShowLogModal(false)}
        module="LOA"
        title="Line of Approval Management Log"
      />
    </div>
  );
};

export default LoaManagementPage;
