// MemoTypeTable.tsx
import React, { useState, useRef, useEffect, useCallback } from "react";
import type { MemoType, TableState } from "../types";
import { useTranslation } from "react-i18next";
import axios from "axios";
import { Listbox } from "@headlessui/react";
import { ChevronDown, Check } from "lucide-react";

interface MemoTypeTableProps {
  memoTypes: MemoType[]; // ← ชุดที่ "พร้อมแสดง" (ถูก paginate มาแล้วจาก hook)
  loading: boolean;
  tableState: TableState;
  onRowClick: (memoType: MemoType) => void;
  onSort: (key: keyof MemoType) => void;
  onSearch: (searchTerm: string) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  totalFiltered: number; // ← เพิ่มมาสำหรับ UI pagination
}

interface UserSearchResult {
  id: number;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  email: string | null;
}
const DB_IS_UTC = true;
function parseDbDate(input: string | number | Date): Date {
  if (input instanceof Date) return input;
  if (typeof input === "number") return new Date(input);
  const s = String(input).trim();

  // รองรับรูปแบบ: 2025-10-28 07:19:59.509
  if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s)) {
    const iso = s.replace(" ", "T") + (DB_IS_UTC ? "Z" : "");
    return new Date(iso);
  }
  // เผื่อกรณี API ส่ง ISO ตรง ๆ
  return new Date(s);
}

// ฟอร์แมต ค.ศ. (ป้องกัน +543) และใช้โซนเวลา Bangkok
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
const MemoTypeTable: React.FC<MemoTypeTableProps> = ({
  memoTypes,
  loading,
  tableState,
  onRowClick,
  onSort,
  onSearch,
  onPageChange,
  onPageSizeChange,
  totalFiltered,
}) => {
  const { t } = useTranslation("memoTypeDisplay");

  // Excel-style Column Filter & Sort states
  type ColumnKey = "name" | "abbreviation" | "businessUnit" | "department" | "approvers";
  const [columnFilters, setColumnFilters] = useState<Record<ColumnKey, string>>({
    name: "",
    abbreviation: "",
    businessUnit: "",
    department: "",
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

  // Business Unit Filter states - removed old accessibleBusinessUnits filter
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

  // Compute unique business units from the current data (for dynamic dropdown)
  const availableBusinessUnits = React.useMemo(() => {
    const buMap = new Map<number, { id: number; name: string }>();
    memoTypes.forEach((mt) => {
      if (mt.businessUnit?.id && mt.businessUnit?.name) {
        buMap.set(mt.businessUnit.id, {
          id: mt.businessUnit.id,
          name: mt.businessUnit.name,
        });
      }
    });
    return Array.from(buMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'th-TH'));
  }, [memoTypes]);

  // Compute available departments based on selected BU
  const availableDepartments = React.useMemo(() => {
    const deptMap = new Map<number, { id: number; name: string }>();
    
    memoTypes.forEach((mt) => {
      // Only include departments from selected BUs (or all if no BU selected)
      if (dynamicBUFilterIds.length === 0 || (mt.businessUnit?.id && dynamicBUFilterIds.includes(mt.businessUnit.id))) {
        if (mt.department?.id && mt.department?.name) {
          deptMap.set(mt.department.id, {
            id: mt.department.id,
            name: mt.department.name,
          });
        }
      }
    });
    
    return Array.from(deptMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'th-TH'));
  }, [memoTypes, dynamicBUFilterIds]);

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

  const handleSort = (column: ColumnKey, direction: "asc" | "desc") => {
    setSortColumn(column);
    setSortDirection(direction);
    setOpenFilterDropdown(null);
    // Also trigger the parent sort handler
    onSort(column as keyof MemoType);
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
      name: "",
      abbreviation: "",
      businessUnit: "",
      department: "",
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

  const hasActiveFilters = Object.values(columnFilters).some((f) => f !== "") || sortColumn !== null || selectedApprover !== null || dynamicBUFilterIds.length > 0 || dynamicDeptFilterIds.length > 0;

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

  // Filter memoTypes based on global search, column filters, approver filter, and business unit filter
  const filteredMemoTypes = memoTypes.filter((memoType) => {
    // Dynamic Business unit dropdown filter (by ID) - shows only BUs in current data - Multi-select
    const matchesDynamicBUFilter = 
      dynamicBUFilterIds.length === 0 || 
      (memoType.businessUnit?.id && dynamicBUFilterIds.includes(memoType.businessUnit.id));

    // Dynamic Department dropdown filter (by ID) - Multi-select
    const matchesDynamicDeptFilter = 
      dynamicDeptFilterIds.length === 0 || 
      (memoType.department?.id && dynamicDeptFilterIds.includes(memoType.department.id));

    // Global search filter (from tableState.searchTerm)
    const globalSearchTerm = tableState.searchTerm.trim().toLowerCase();
    const matchesGlobalSearch = !globalSearchTerm || (
      memoType.name?.toLowerCase?.().includes(globalSearchTerm) ||
      (memoType.abbreviation ?? '').toLowerCase().includes(globalSearchTerm) ||
      (memoType.description ?? '').toLowerCase().includes(globalSearchTerm) ||
      (memoType.businessUnit?.name ?? '').toLowerCase().includes(globalSearchTerm) ||
      (memoType.department?.name ?? '').toLowerCase().includes(globalSearchTerm) ||
      (memoType.team?.name ?? '').toLowerCase().includes(globalSearchTerm)
    );

    // Column filters
    const matchesNameFilter =
      !columnFilters.name ||
      memoType.name?.toLowerCase().includes(columnFilters.name.toLowerCase());
    const matchesAbbreviationFilter =
      !columnFilters.abbreviation ||
      memoType.abbreviation?.toLowerCase().includes(columnFilters.abbreviation.toLowerCase());
    const matchesBUColumnFilter =
      !columnFilters.businessUnit ||
      memoType.businessUnit?.name?.toLowerCase().includes(columnFilters.businessUnit.toLowerCase());
    const matchesDepartmentFilter =
      !columnFilters.department ||
      memoType.department?.name?.toLowerCase().includes(columnFilters.department.toLowerCase());

    // Approvers column filter - search in approver names
    const matchesApproversColumnFilter = !columnFilters.approvers || (() => {
      const searchTerm = columnFilters.approvers.toLowerCase();
      
      // Check in approvalLevels
      if (memoType.approvalLevels && memoType.approvalLevels.length > 0) {
        return memoType.approvalLevels.some((level: any) =>
          level.users?.some((user: any) => {
            const userName = `${user.name || ''} ${user.lastname || ''}`.trim().toLowerCase();
            return userName.includes(searchTerm);
          })
        );
      }
      
      // Check in approval line data
      if (memoType.approvalLineId) {
        const matchedLine = approvalLines.find(line => line.id === memoType.approvalLineId);
        if (matchedLine && matchedLine.approvalUsers) {
          return matchedLine.approvalUsers.some((approvalUser: any) => {
            if (approvalUser.user) {
              const userName = `${approvalUser.user.name || ''} ${approvalUser.user.lastname || ''}`.trim().toLowerCase();
              return userName.includes(searchTerm);
            }
            return false;
          });
        }
      }
      
      return false;
    })();

    // Check if memo type has the selected approver in its approval line
    const matchesApproverFilter = !selectedApprover || (() => {
      if (!memoType.approvalLineId) return false;

      // Find the approval line for this memo type
      const matchedLine = approvalLines.find(line => line.id === memoType.approvalLineId);
      if (!matchedLine || !matchedLine.approvalUsers) return false;

      // Check if the selected approver is in this approval line
      return matchedLine.approvalUsers.some((approvalUser: any) =>
        approvalUser.user && approvalUser.user.id === selectedApprover.id
      );
    })();

    return (
      matchesDynamicBUFilter &&
      matchesGlobalSearch &&
      matchesNameFilter &&
      matchesAbbreviationFilter &&
      matchesDynamicBUFilter &&
      matchesDynamicDeptFilter &&
      matchesBUColumnFilter &&
      matchesDepartmentFilter &&
      matchesApproversColumnFilter &&
      matchesApproverFilter
    );
  });

  // Debug logging
  console.log('=== MEMO TYPE FILTER DEBUG ===');
  console.log('Original memoTypes count:', memoTypes.length);
  console.log('Global search term:', tableState.searchTerm);
  console.log('Selected approver:', selectedApprover);
  console.log('Column filters:', columnFilters);
  console.log('Filtered memoTypes count:', filteredMemoTypes.length);
  console.log('Filtered memoTypes:', filteredMemoTypes.map(m => ({ id: m.id, name: m.name })));

  // Apply sorting to filtered data
  const sortedFilteredMemoTypes = React.useMemo(() => {
    const arr = [...filteredMemoTypes];
    const collator = new Intl.Collator('th-TH', { numeric: true, sensitivity: 'base' });
    
    const compareStrings = (a?: string | null, b?: string | null) => {
      if (!a && !b) return 0;
      if (!a) return 1;
      if (!b) return -1;
      return collator.compare(a, b);
    };

    const compareNumbers = (a?: number | null, b?: number | null) => {
      return (a ?? 0) - (b ?? 0);
    };

    // Helper function to count approval levels
    const countLevels = (memoType: any) => {
      if (memoType.approvalLevels && memoType.approvalLevels.length > 0) {
        return memoType.approvalLevels.length;
      }
      
      // Fallback to approval line data
      if (memoType.approvalLineId) {
        const matchedLine = approvalLines.find(line => line.id === memoType.approvalLineId);
        if (matchedLine && matchedLine.approvalUsers) {
          // Count unique levels
          const levels = new Set(matchedLine.approvalUsers.map((au: any) => au.level ?? 0));
          return levels.size;
        }
      }
      
      return 0;
    };

    arr.sort((a: any, b: any) => {
      let result = 0;
      switch (tableState.sortKey) {
        case 'id': result = compareNumbers(a.id, b.id); break;
        case 'name': result = compareStrings(a.name, b.name); break;
        case 'abbreviation': result = compareStrings(a.abbreviation, b.abbreviation); break;
        case 'createdAt':
          result = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'isActive': result = a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1; break;
        case 'businessUnit': result = compareStrings(a.businessUnit?.name, b.businessUnit?.name); break;
        case 'department': result = compareStrings(a.department?.name, b.department?.name); break;
        case 'team': result = compareStrings(a.team?.name, b.team?.name); break;
        case 'approvalLevels':
          // Sort by number of levels
          result = compareNumbers(countLevels(a), countLevels(b));
          break;
        default:
          result = compareStrings(String(a?.[tableState.sortKey] ?? ''), String(b?.[tableState.sortKey] ?? ''));
      }
      return tableState.sortDirection === 'asc' ? result : -result;
    });
    return arr;
  }, [filteredMemoTypes, tableState.sortKey, tableState.sortDirection, approvalLines]);

  // Apply all filters to get the complete filtered dataset
  const allFilteredMemoTypes = React.useMemo(() => sortedFilteredMemoTypes, [
    sortedFilteredMemoTypes
  ]);

  const getSortIcon = (columnKey: keyof MemoType) => {
    if (tableState.sortKey !== columnKey) {
      return (
        <svg
          className="w-4 h-4 opacity-40"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
          />
        </svg>
      );
    }
    return tableState.sortDirection === "asc" ? (
      <svg
        className="w-4 h-4 text-[#183e33]"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M5 15l7-7 7 7"
        />
      </svg>
    ) : (
      <svg
        className="w-4 h-4 text-[#183e33]"
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
    );
  };

  // Calculate pagination info based on all filtered data
  const totalFilteredCount = allFilteredMemoTypes.length;
  const actualPageSize = tableState.pageSize && tableState.pageSize > 0 ? tableState.pageSize : totalFilteredCount;
  const actualTotalPages = Math.max(1, Math.ceil(totalFilteredCount / Math.max(actualPageSize, 1)));
  const actualCurrentPage = Math.min(tableState.currentPage, actualTotalPages);
  
  // Apply pagination to the filtered data
  const paginatedFilteredMemoTypes = React.useMemo(() => {
    console.log('=== PAGINATION DEBUG ===');
    console.log('Total filtered count:', totalFilteredCount);
    console.log('Page size:', actualPageSize);
    console.log('Current page:', actualCurrentPage);
    console.log('Total pages:', actualTotalPages);
    
    if (actualPageSize >= totalFilteredCount) {
      console.log('Showing all items (page size >= total)');
      return allFilteredMemoTypes; // Show all if page size is larger than total
    }
    const startIndex = (actualCurrentPage - 1) * actualPageSize;
    const endIndex = startIndex + actualPageSize;
    console.log('Start index:', startIndex);
    console.log('End index:', endIndex);
    const slicedData = allFilteredMemoTypes.slice(startIndex, endIndex);
    console.log('Sliced data count:', slicedData.length);
    console.log('Sliced data:', slicedData.map(m => ({ id: m.id, name: m.name })));
    return slicedData;
  }, [allFilteredMemoTypes, actualCurrentPage, actualPageSize, totalFilteredCount]);

  // Calculate display indices
  const actualStartIndex = totalFilteredCount === 0 ? 0 : (actualCurrentPage - 1) * actualPageSize + 1;
  const actualEndIndex = totalFilteredCount === 0 ? 0 : Math.min(actualStartIndex + paginatedFilteredMemoTypes.length - 1, totalFilteredCount);

  const handleKeyDown = (event: React.KeyboardEvent, memoType: MemoType) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowClick(memoType);
    }
  };

  // ✅ pageSize 0 => All
  const ps =
    tableState.pageSize && tableState.pageSize > 0
      ? tableState.pageSize
      : totalFilteredCount;
  const totalPages = actualTotalPages;

  // ✅ ช่วงตัวเลข "Showing X to Y of Z" - use actual filtered data
  const visibleCount = paginatedFilteredMemoTypes.length; // Use paginated filtered data
  const startIndex = actualStartIndex;
  const endIndex = actualEndIndex;

  if (loading) {
    return (
      <div className="bg-white shadow-xl rounded-2xl overflow-hidden -mx-6 sm:mx-0">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#183e33]"></div>
          <span className="ml-3 text-gray-600">
            {t("loading", "Loading...")}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white shadow-xl rounded-2xl overflow-hidden -mx-6 sm:mx-0">
      {/* Search Bar, Business Unit Filter, and Approver Filter */}
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex flex-wrap items-center gap-4">
          {/* Global Search */}
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <input
              type="text"
              placeholder={t("searchPlaceholder", "Search document types...")}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#183e33]"
              value={tableState.searchTerm}
              onChange={(e) => onSearch(e.target.value)}
              aria-label={t("searchAriaLabel", "Search document types")}
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

          {/* Dynamic Business Unit Filter Dropdown - shows only BUs in current data - Multi-select */}
          {availableBusinessUnits.length > 1 && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600 whitespace-nowrap">
                  {t("dynamicBUFilter.label", "Filter by BU:")}
                </span>
                <div className="relative min-w-[400px] max-sm:min-w-full" ref={buDropdownRef}>
                  <button
                    onClick={() => setIsBUDropdownOpen(!isBUDropdownOpen)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#183e33] bg-white flex items-center justify-between"
                  >
                    <span className={dynamicBUFilterIds.length > 0 ? "text-gray-900" : "text-gray-500"}>
                      {dynamicBUFilterIds.length > 0
                        ? `${dynamicBUFilterIds.length} selected`
                        : t("dynamicBUFilter.all", "All Business Units")}
                    </span>
                    <div className="flex items-center gap-2">
                      {dynamicBUFilterIds.length > 0 && (
                        <span className="bg-blue-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                          {dynamicBUFilterIds.length}
                        </span>
                      )}
                      <ChevronDown className={`w-4 h-4 transition-transform ${isBUDropdownOpen ? "rotate-180" : ""}`} />
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
                    title="Clear BU filter"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Divider */}
              <div className="hidden md:block h-8 w-px bg-gray-300"></div>
            </>
          )}

          {/* Approver Filter */}
          <div className="relative min-w-[200px]" ref={approverSearchInputRef}>

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

          {/* Selected Approver Badge */}
          {selectedApprover && (
            <div className="flex items-center gap-2">
              <div className="bg-orange-100 border border-orange-200 rounded-lg px-3 py-1.5">
                <span className="text-xs text-orange-600 font-medium">Filtering:</span>
                <span className="text-sm text-orange-800 ml-1">{selectedApprover.name}</span>
              </div>
              <div className="text-sm text-gray-500">
                {allFilteredMemoTypes.length} type{allFilteredMemoTypes.length !== 1 ? 's' : ''} found
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto w-full">
        <table
          className="w-full table-fixed divide-y divide-gray-200"
          role="table"
          aria-label={t("tableAriaLabel", "Memo types table")}
        >
          <thead className="bg-gray-50">
            <tr>
              {/* Name Column with Excel Filter */}
              <th className="w-80 px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                <div className="flex items-center justify-normal">
                  <span className="flex items-center gap-1">
                    {t("columns.name", "Name")}
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
                        Sort A to Z
                      </button>
                      <button
                        onClick={() => handleSort("name", "desc")}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "name" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                        </svg>
                        Sort Z to A
                      </button>
                      {sortColumn === "name" && (
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
                          Clear Filter
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </th>

              {/* Abbreviation Column with Excel Filter */}
              <th className="w-32 px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    {t("columns.abbreviation", "Abbreviation")}
                    {(columnFilters.abbreviation || sortColumn === "abbreviation") && (
                      <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                    )}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenFilterDropdown(openFilterDropdown === "abbreviation" ? null : "abbreviation");
                    }}
                    className="p-1 hover:bg-gray-200 rounded transition-colors"
                  >
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
                {openFilterDropdown === "abbreviation" && (
                  <div
                    ref={filterDropdownRef}
                    className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="p-2 border-b border-gray-100">
                      <button
                        onClick={() => handleSort("abbreviation", "asc")}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "abbreviation" && sortDirection === "asc" ? "bg-blue-50 text-blue-700" : ""}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                        </svg>
                        Sort A to Z
                      </button>
                      <button
                        onClick={() => handleSort("abbreviation", "desc")}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "abbreviation" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                        </svg>
                        Sort Z to A
                      </button>
                      {sortColumn === "abbreviation" && (
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
                        value={columnFilters.abbreviation}
                        onChange={(e) => handleColumnFilterChange("abbreviation", e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      {columnFilters.abbreviation && (
                        <button
                          onClick={() => clearColumnFilter("abbreviation")}
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
              <th className="w-40 px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    {t("columns.businessUnit", "Business Unit")}
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
                        Sort A to Z
                      </button>
                      <button
                        onClick={() => handleSort("businessUnit", "desc")}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "businessUnit" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                        </svg>
                        Sort Z to A
                      </button>
                      {sortColumn === "businessUnit" && (
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
                          Clear Filter ({dynamicBUFilterIds.length} selected)
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </th>

              {/* Department Column with Excel Filter */}
              <th className="w-40 px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    {t("columns.department", "Department")}
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
                        Sort A to Z
                      </button>
                      <button
                        onClick={() => handleSort("department", "desc")}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "department" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                        </svg>
                        Sort Z to A
                      </button>
                      {sortColumn === "department" && (
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
                              ? "No departments available for selected BUs"
                              : "No departments available"}
                          </p>
                        </div>
                      ) : (
                        <>
                          <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg bg-gray-50">
                            <div className="p-2 space-y-1">
                              {availableDepartments.map((dept) => (
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
                              Clear Filter ({dynamicDeptFilterIds.length} selected)
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </th>

              {/* Approvers Column with Excel Filter */}
              <th className="flex-1 px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider relative">
                <div className="flex items-center justify-normal">
                  <span className="flex items-center gap-1">
                    Approvers
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
                    className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
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
                        Sort by Level Count
                      </button>
                      <button
                        onClick={() => handleSort("approvers", "desc")}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-gray-100 ${sortColumn === "approvers" && sortDirection === "desc" ? "bg-blue-50 text-blue-700" : ""}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
                        </svg>
                        Sort by Level Count (Desc)
                      </button>
                      {sortColumn === "approvers" && (
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

              {/* Created Date Column */}
              <th className="w-32 px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                <span className="flex items-center gap-1">
                  {t("columns.createdAt", "Created Date")}
                  {getSortIcon("createdAt")}
                </span>
              </th>
            </tr>
          </thead>

          <tbody className="bg-white divide-y divide-gray-200">
            {paginatedFilteredMemoTypes.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-6 py-12 text-center text-gray-500"
                >
                  <div className="flex flex-col items-center">
                    <svg
                      className="w-12 h-12 text-gray-300 mb-4"
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
                    <p className="text-lg font-medium">
                      {t("noData", "No memo types found")}
                    </p>
                    <p className="text-sm text-gray-400">
                      {t(
                        "noDataDescription",
                        "Try adjusting your search criteria"
                      )}
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              paginatedFilteredMemoTypes.map((memoType) => {
                // Get approval line data for this memo type by matching approvalLineId
                const matchedApprovalLine = memoType.approvalLineId
                  ? approvalLines.find(line => line.id === memoType.approvalLineId)
                  : null;

                return (
                  <tr
                    key={memoType.id}
                    className="hover:bg-gray-50 cursor-pointer transition-colors focus:bg-gray-100"
                    onClick={() => onRowClick(memoType)}
                    onKeyDown={(e) => handleKeyDown(e, memoType)}
                    tabIndex={0}
                    role="button"
                    aria-label={t("rowAriaLabel", "View details for {{name}}", {
                      name: memoType.name,
                    })}
                  >
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-gray-900 line-clamp-2" title={memoType.name}>
                        {memoType.name}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900 truncate" title={memoType.abbreviation || "-"}>
                        {memoType.abbreviation || "-"}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900 truncate" title={memoType.businessUnit?.name || "-"}>
                        {memoType.businessUnit?.name || "-"}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900 truncate" title={memoType.department?.name || "-"}>
                        {memoType.department?.name || "-"}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-xs text-gray-900">
                        {memoType.approvalLevels && memoType.approvalLevels.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {memoType.approvalLevels.map((level: any, levelIdx: number) => {
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
                                        Level {level.level + 1}
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
                        ) : memoType.approvalLine ? (
                          // Fallback: show approval line name if no detailed data
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                            {memoType.approvalLine.name}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">No approval line</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900">
                        {fmtAD.format(parseDbDate(memoType.createdAt))}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {paginatedFilteredMemoTypes.length > 0 && (
        <div className="bg-white px-6 py-3 border-t border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <span className="text-sm text-gray-700">
                {t("pagination.showing", "Showing")} {startIndex}{" "}
                {t("pagination.to", "to")} {endIndex} {t("pagination.of", "of")}{" "}
                {totalFilteredCount} {t("pagination.results", "results")}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <select
                value={tableState.pageSize}
                onChange={(e) => onPageSizeChange(Number(e.target.value))}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
                aria-label={t("pagination.pageSizeAriaLabel", "Items per page")}
              >
                <option value={30}>30</option>
                <option value={40}>40</option>
                <option value={50}>50</option>
                <option value={0}>All</option> {/* 0 = All */}
              </select>
              <div className="flex space-x-1">
                {Array.from({ length: totalPages }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => onPageChange(i + 1)}
                    className={`px-3 py-1 rounded text-sm font-medium ${tableState.currentPage === i + 1
                      ? "bg-[#183e33] text-white"
                      : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50"
                      }`}
                    aria-label={t(
                      "pagination.pageAriaLabel",
                      "Go to page {{page}}",
                      { page: i + 1 }
                    )}
                    aria-current={
                      tableState.currentPage === i + 1 ? "page" : undefined
                    }
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MemoTypeTable;
