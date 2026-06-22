// src/pages/ApprovalLine.tsx
import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import AsyncSelect from "react-select/async";
import { Listbox } from "@headlessui/react";
import {
  Plus,
  X,
  Trash2,
  Pencil,
  Check,
  User,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import AdminLogModal from "../../components/AdminLogModal";

interface Team {
  id: number;
  name: string;
  businessUnit?: {
    id: number;
    name: string;
  };
}
interface UserOption {
  value: number;
  label: string;
  isSigReq?: boolean;
}

interface LevelForm {
  name: string;
  users: UserOption[];
}

interface ApprovalLine {
  id: number;
  name: string;
  businessUnitId?: number;
  businessUnit?: {
    id: number;
    name: string;
  };
  teamId?: number;
  team?: {
    id: number;
    name: string;
    businessUnit?: {
      id: number;
      name: string;
    };
  };
  levels: {
    role: string;
    users: { id: number; name: string; isSigReq?: boolean }[];
  }[];
}

export default function ApprovalLinePage() {
  const { t } = useTranslation("approval");

  const [teamId, setTeamId] = useState<number | null>(null);
  const [approvalLines, setApprovalLines] = useState<ApprovalLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [teams, setTeams] = useState<Team[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [formTeamId, setFormTeamId] = useState<number | null>(null);
  const [newLine, setNewLine] = useState<{ name: string; levels: LevelForm[] }>(
    { name: "", levels: [] }
  );
  const [editing, setEditing] = useState<ApprovalLine | null>(null);
  const [expandedLine, setExpandedLine] = useState<number | null>(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [searchTerm, setSearchTerm] = useState("");
  const [showLogModal, setShowLogModal] = useState(false);

  // Dynamic Business Unit Filter
  const [dynamicBUFilterId, setDynamicBUFilterId] = useState<number | "all">("all");

  // Page size options
  const pageSizeOptions = [5, 10, 20, 50, 0]; // 0 means "All"

  // Compute unique business units from the approval lines data (for dynamic dropdown)
  const availableBusinessUnits = React.useMemo(() => {
    const buMap = new Map<number, { id: number; name: string }>();
    approvalLines.forEach((line) => {
      if (line.businessUnit?.id && line.businessUnit?.name) {
        buMap.set(line.businessUnit.id, {
          id: line.businessUnit.id,
          name: line.businessUnit.name,
        });
      }
    });
    return Array.from(buMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'th-TH'));
  }, [approvalLines]);

  /* ------------- helpers ------------- */
  const addLevel = () =>
    setNewLine((p) => ({
      ...p,
      levels: [...p.levels, { name: "", users: [] }],
    }));

  const removeLevel = (idx: number) =>
    setNewLine((p) => ({ ...p, levels: p.levels.filter((_, i) => i !== idx) }));

  type Me = {
    id: number;
    role?: string;
    roles?: string[];
    team?: { id: number };
  };

const checkAdmin = (me: Me): boolean => {
  const primary = (me.role ?? "").toUpperCase();
  const has = (role: string) =>
    primary === role || (me.roles?.some((r) => r.toUpperCase() === role) ?? false);

  return has("ADMIN") || has("DCC");
};

  useEffect(() => {
    axios
      .get<Me>("/api/me", { withCredentials: true })
      .then(({ data: me }) => {
        // 2) เรียก helper เดิมแทน
        const admin = checkAdmin(me);
        setIsAdmin(admin);
        if (admin) {
          // ถ้า admin ให้โหลด list ทีม
          axios
            .get<Team[]>("/api/teams", { withCredentials: true })
            .then(({ data }) => {
              setTeams(data);
              if (data.length) setTeamId(data[0].id);
            });
        } else {
          // ถ้าไม่ใช่ admin ให้ใช้ทีมของตัวเอง
          setTeamId(me.team?.id ?? null);
        }
      })
      .catch(() => toast.error("Failed to load user info"));
  }, []);

  // 3) fetch approvalLines ตาม teamId & isAdmin
  useEffect(() => {
    if (teamId == null) return;
    setLoading(true);
    const url = isAdmin
      ? "/api/approval-lines"
      : `/api/teams/${teamId}/approval-lines`;
    axios
      .get<ApprovalLine[]>(url, {
        withCredentials: true,
        params: isAdmin ? { teamId } : undefined,
      })
      .then(({ data }) => setApprovalLines(data))
      .catch(() => toast.error("Failed to load approval lines"))
      .finally(() => setLoading(false));
  }, [teamId, isAdmin]);

  /* ------------- create / update ------------- */
  const buildPayload = () => ({
    name: newLine.name,
    teamId: formTeamId ?? teamId,
    levels: newLine.levels.map((lv) => ({
      role: lv.name || undefined,
      users: lv.users.map((u) => ({ id: u.value, isSigReq: !!u.isSigReq })),
    })),
  });

  const resetForm = () => {
    setNewLine({ name: "", levels: [] });
    setEditing(null);
    setFormTeamId(teamId ?? null);
    setCurrentPage(1); // Reset pagination when form is reset
  };

  // ดึง id ที่ถูกเลือกไปแล้วใน level อื่น ๆ เพื่อ exclude ตอนค้นหา
  const getExcludedIds = (lvIdx: number) =>
    newLine.levels.flatMap((lv, i) =>
      i === lvIdx ? [] : lv.users.map((u) => u.value)
    );

  // loader สำหรับ AsyncSelect ของแต่ละ level
  const makeLoadOptions = (lvIdx: number) => async (inputValue: string) => {
    try {
      const exclude = getExcludedIds(lvIdx);
      const { data } = await axios.get("/api/users/search", {
        withCredentials: true,
        params: {
          q: inputValue || "",
          limit: 20,
          exclude: exclude.join(","), // รองรับหลายค่า เช่น "1,2,3"
        },
      });

      return (
        data as Array<{
          id: number;
          name: string;
          lastname?: string | null;   // 👈 ใช้ด้วย
          nickname?: string | null;
          email: string;
        }>
      ).map((u) => {
        const fullName = [u.name, u.lastname].filter(Boolean).join(" ");
        return {
          value: u.id,
          label: u.nickname ? `${fullName} (${u.nickname})` : fullName,
          isSigReq: true, // 👈 เริ่มต้นเป็น true (require signature)
        };
      });
    } catch {
      return [];
    }
  };

  const beforeSaveValidate = () => {
    const all = newLine.levels.flatMap((lv) => lv.users);
    const count = new Map<number, { c: number; label: string }>();
    all.forEach((u) => {
      const x = count.get(u.value);
      count.set(u.value, { c: (x?.c || 0) + 1, label: u.label });
    });
    const dups = [...count.entries()]
      .filter(([, v]) => v.c > 1)
      .map(([, v]) => v.label);
    if (dups.length) {
      const names = Array.from(new Set(dups)).join(", ");
      toast.error(`มีผู้อนุมัติซ้ำหลายระดับ: ${names}`);
      return false;
    }
    return true;
  };

  const save = async () => {
    if (!beforeSaveValidate()) return;
    if (!teamId) return toast.error("Please select a team before saving");
    if (!newLine.name.trim())
      return toast.error("Please enter a name for the approval line");
    if (newLine.levels.length === 0)
      return toast.error("Please add at least one level");
    try {
      if (editing) {
        const { data } = await axios.put<ApprovalLine>(
          `/api/approval-lines/${editing.id}`,
          buildPayload(),
          { withCredentials: true }
        );
        setApprovalLines((p) => p.map((l) => (l.id === data.id ? data : l)));
        if (
          data.teamId !== undefined &&
          teamId !== null &&
          data.teamId !== teamId
        ) {
          setApprovalLines((p) => p.filter((l) => l.id !== data.id));
          toast.success("Approval line updated & moved to another team");
        } else {
          setApprovalLines((p) => p.map((l) => (l.id === data.id ? data : l)));
          toast.success("Approval line updated");
        }
      } else {
        const { data } = await axios.post<ApprovalLine>(
          "/api/approval-lines",
          buildPayload(),
          { withCredentials: true }
        );
        setApprovalLines((p) => [...p, data]);
        toast.success("Approval line created");
      }
      resetForm();
    } catch (e) {
      toast.error(editing ? "Update failed" : "Creation failed");
    }
  };

  /* ------------- delete ------------- */
  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this approval line?")) return;
    try {
      await axios.delete(`/api/approval-lines/${id}`, {
        withCredentials: true,
      });
      setApprovalLines((p) => p.filter((l) => l.id !== id));
      toast.success("Approval line deleted");
    } catch (e) {
      toast.error("Deletion failed");
    }
  };

  const openEdit = (line: ApprovalLine) => {
    setEditing(line);
    setFormTeamId(line.teamId ?? teamId ?? null);
    setNewLine({
      name: line.name,
      levels: line.levels.map((lv) => ({
        name: lv.role,
        users: lv.users.map((u) => ({
          value: u.id,
          label: u.name,
          isSigReq: u.isSigReq,
        })),
      })),
    });
  };

  const toggleExpand = (id: number) => {
    setExpandedLine(expandedLine === id ? null : id);
  };

  // Filter and pagination logic
  const filteredApprovalLines = approvalLines.filter(line => {
    // Search term filter
    const matchesSearch = line.name.toLowerCase().includes(searchTerm.toLowerCase());
    
    // Dynamic BU filter - filter by approval line's business unit directly
    const matchesBUFilter = dynamicBUFilterId === "all" || line.businessUnitId === dynamicBUFilterId;
    
    return matchesSearch && matchesBUFilter;
  });

  const totalPages = pageSize === 0 ? 1 : Math.ceil(filteredApprovalLines.length / pageSize);
  const paginatedApprovalLines = pageSize === 0 
    ? filteredApprovalLines 
    : filteredApprovalLines.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // Reset to first page when search term changes
  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    setCurrentPage(1);
  };

  // Reset to first page when page size changes
  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    setCurrentPage(1);
  };

  // Generate page numbers for pagination
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

  if (loading)
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-emerald-500"></div>
      </div>
    );

  return (
    <div className="max-w-7xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-800">{t("title")}</h1>
          <p className="text-gray-500 mt-1">{t("subtitle")}</p>
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          {/* Search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search approval lines..."
              value={searchTerm}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full sm:w-64 pl-10 pr-10 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
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
            {searchTerm && (
              <button
                onClick={() => handleSearchChange("")}
                className="absolute right-3 top-2.5 h-5 w-5 text-gray-400 hover:text-gray-600"
              >
                <X size={16} />
              </button>
            )}
          </div>

          {/* Dynamic Business Unit Filter Dropdown */}
          {availableBusinessUnits.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600 whitespace-nowrap">
                {t("businessUnitFilter.label", "Business Unit:")}
              </span>
              <select
                value={dynamicBUFilterId}
                onChange={(e) => {
                  const val = e.target.value;
                  setDynamicBUFilterId(val === "all" ? "all" : Number(val));
                  setCurrentPage(1);
                }}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white min-w-[160px]"
              >
                <option value="all">{t("businessUnitFilter.all", "All Business Units")}</option>
                {availableBusinessUnits.map((bu) => (
                  <option key={bu.id} value={bu.id}>
                    {bu.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          
          {/* Page Size Selector */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600 whitespace-nowrap">Show:</span>
            <Listbox value={pageSize} onChange={handlePageSizeChange}>
              <div className="relative">
                <Listbox.Button className="relative w-20 cursor-pointer rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-8 text-left focus:outline-none focus:ring-2 focus:ring-emerald-500">
                  <span className="block truncate text-sm">
                    {pageSize === 0 ? "All" : pageSize}
                  </span>
                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                    <ChevronDown className="h-4 w-4 text-gray-400" />
                  </span>
                </Listbox.Button>
                <Listbox.Options className="absolute z-10 mt-1 max-h-60 w-20 overflow-auto rounded-md bg-white py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
                  {pageSizeOptions.map((size) => (
                    <Listbox.Option
                      key={size}
                      value={size}
                      className={({ active }) =>
                        `relative cursor-pointer select-none py-2 pl-3 pr-8 text-sm ${
                          active ? 'bg-emerald-100 text-emerald-900' : 'text-gray-900'
                        }`
                      }
                    >
                      {({ selected }) => (
                        <>
                          <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                            {size === 0 ? "All" : size}
                          </span>
                          {selected && (
                            <span className="absolute inset-y-0 right-0 flex items-center pr-2 text-emerald-600">
                              <Check className="h-4 w-4" />
                            </span>
                          )}
                        </>
                      )}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </div>
            </Listbox>
          </div>
          
          <div className="bg-gradient-to-r from-emerald-400 to-emerald-600 p-0.5 rounded-lg">
            <div className="bg-white rounded-lg px-4 py-2 text-emerald-600 font-medium">
              {pageSize === 0 
                ? `${filteredApprovalLines.length} Lines` 
                : `Page ${currentPage} of ${totalPages} (${filteredApprovalLines.length} total)`
              }
            </div>
          </div>
          <button
            onClick={() => setShowLogModal(true)}
            className="bg-gray-600 text-white px-4 py-2 rounded-lg hover:bg-gray-700"
          >
            {t("viewLog")}
          </button>
        </div>
      </div>

      {/* Team Selection for Admin */}
      {isAdmin && (
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select Team
          </label>
          <Listbox value={teamId} onChange={setTeamId}>
            <Listbox.Button className="w-full rounded-lg border px-4 py-2 text-left">
              {teams.find((t) => t.id === teamId)?.name || "Choose a team"}
            </Listbox.Button>
            <Listbox.Options className="mt-1 border rounded-lg max-h-60 overflow-auto">
              {teams.map((t) => (
                <Listbox.Option
                  key={t.id}
                  value={t.id}
                  className="cursor-pointer px-4 py-2 hover:bg-gray-100"
                >
                  {t.name}
                </Listbox.Option>
              ))}
            </Listbox.Options>
          </Listbox>
        </div>
      )}

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Column - Approval Lines List */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-800 overflow-hidden">
          <div className="px-6 py-5 border-b border-gray-800">
            <h2 className="text-lg font-semibold text-gray-800">
              {t("list.title")}
            </h2>
          </div>

          <div className="divide-y divide-gray-100">
            {paginatedApprovalLines.length === 0 && !loading && (
              <div className="py-16 text-center">
                <div className="mx-auto w-16 h-16 flex items-center justify-center bg-emerald-50 rounded-full mb-4">
                  <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center">
                    <User className="text-emerald-500" size={20} />
                  </div>
                </div>
                <h3 className="text-gray-600 font-medium">
                  {searchTerm ? "No matching approval lines found" : t("list.emptyTitle")}
                </h3>
                <p className="text-gray-500 mt-1 max-w-md mx-auto">
                  {searchTerm 
                    ? `No approval lines match "${searchTerm}". Try adjusting your search.`
                    : t("list.emptyDesc")
                  }
                </p>
              </div>
            )}

            {paginatedApprovalLines.map((l) => (
              <div
                key={l.id}
                className="py-5 px-6 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-3">
                      <div className="bg-emerald-50 w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0">
                        <div className="w-5 h-5 bg-emerald-100 rounded-full flex items-center justify-center">
                          <Check className="text-emerald-600" size={12} />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h2 className="text-lg font-semibold text-gray-800 line-clamp-2">
                          {l.name}
                        </h2>
                      </div>
                    </div>

                    <button
                      onClick={() => toggleExpand(l.id)}
                      className="mt-3 flex items-center text-sm text-emerald-600 font-medium"
                    >
                      {expandedLine === l.id ? (
                        <>
                          <span>{t("list.hideLevels")}</span>
                          <ChevronUp className="ml-1" size={16} />
                        </>
                      ) : (
                        <>
                          <span>
                            Show {l.levels.length} level
                            {l.levels.length !== 1 ? "s" : ""}
                          </span>
                          <ChevronDown className="ml-1" size={16} />
                        </>
                      )}
                    </button>

                    {expandedLine === l.id && (
                      <ol className="mt-4 pl-3 space-y-3">
                        {l.levels.map((lv, i1) => (
                          <li key={i1} className="flex">
                            <div className="mr-3 mt-1 flex-shrink-0">
                              <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center">
                                <span className="text-white text-xs font-bold">
                                  {i1 + 1}
                                </span>
                              </div>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-gray-800 mb-1">
                                {lv.role || `Level ${i1 + 1}`}
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {lv.users.map((u) => (
                                  <div
                                    key={u.id}
                                    className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium
                                      ${
                                        u.isSigReq
                                          ? "bg-emerald-50 text-green-700 border border-emerald-200"
                                          : "bg-gray-100 text-gray-700"
                                      }`}
                                    title={
                                      u.isSigReq
                                        ? "Requires signature"
                                        : "No signature required"
                                    }
                                  >
                                    <User className="mr-1.5" size={12} />
                                    <span className="truncate max-w-[100px]">
                                      {u.name}
                                    </span>
                                    {u.isSigReq && (
                                      <svg
                                        className="ml-1.5 flex-shrink-0"
                                        width="12"
                                        height="12"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                      >
                                        <path d="M20 6L9 17l-5-5" />
                                      </svg>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={() => openEdit(l)}
                      className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 transition-colors"
                      title={t("list.edit")}
                    >
                      <Pencil size={18} />
                    </button>
                    <button
                      onClick={() => handleDelete(l.id)}
                      className="rounded-lg p-2 text-red-500 hover:bg-red-50 transition-colors"
                      title={t("list.delete")}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination Controls */}
          {filteredApprovalLines.length > 0 && (
            <div className="px-6 py-4 border-t border-gray-100">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                {/* Results info */}
                <div className="text-sm text-gray-600">
                  {pageSize === 0 ? (
                    `Showing all ${filteredApprovalLines.length} results`
                  ) : (
                    `Showing ${Math.min((currentPage - 1) * pageSize + 1, filteredApprovalLines.length)} to ${Math.min(currentPage * pageSize, filteredApprovalLines.length)} of ${filteredApprovalLines.length} results`
                  )}
                  {searchTerm && (
                    <span className="text-emerald-600 ml-1">
                      (filtered from {approvalLines.length} total)
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
                              ? 'bg-emerald-500 text-white'
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

        {/* Right Column - Form */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-800 p-6 h-fit">
          <div className="mb-6">
            <h2 className="text-xl font-bold text-gray-800">
              {editing ? t("form.editTitle") : t("form.createTitle")}
            </h2>
            <p className="text-gray-500 mt-1">
              {editing ? t("form.editDesc") : t("form.createDesc")}
            </p>
          </div>

          {isAdmin && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t("form.teamthis")}
              </label>
              <Listbox value={formTeamId ?? teamId} onChange={setFormTeamId}>
                <Listbox.Button className="w-full rounded-lg border px-4 py-2 text-left">
                  {teams.find((t) => t.id === (formTeamId ?? teamId))?.name ||
                    "Choose a team"}
                </Listbox.Button>
                <Listbox.Options className="mt-1 border rounded-lg max-h-60 overflow-auto">
                  {teams.map((t) => (
                    <Listbox.Option
                      key={t.id}
                      value={t.id}
                      className="cursor-pointer px-4 py-2 hover:bg-gray-100"
                    >
                      {t.name}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </Listbox>
            </div>
          )}

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t("form.nameLabel")}
            </label>
            <input
              type="text"
              value={newLine.name}
              placeholder="e.g. Expense Approval, Vacation Request"
              onChange={(e) =>
                setNewLine((p) => ({ ...p, name: e.target.value }))
              }
              className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 transition-all"
            />
          </div>

          <div className="space-y-4 mb-6">
            {newLine.levels.map((lv, idx) => (
              <div
                key={idx}
                className="rounded-xl border border-gray-200 bg-gray-50 p-5"
              >
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-medium text-gray-800">Level {idx + 1}</h3>
                  <button
                    onClick={() => removeLevel(idx)}
                    className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-200 transition-colors"
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t("form.approversLabel")}
                  </label>
                  <AsyncSelect<UserOption, true>
                    isMulti
                    cacheOptions
                    defaultOptions
                    loadOptions={makeLoadOptions(idx)}
                    value={lv.users}
                    onChange={(opts) =>
                      setNewLine((prev) => {
                        const levels = [...prev.levels];
                        levels[idx].users = (opts ?? []) as UserOption[];
                        return { ...prev, levels };
                      })
                    }
                    placeholder="Select approvers..."
                    className="text-gray-700"
                    styles={{
                      control: (base) => ({
                        ...base,
                        minHeight: "48px",
                        borderRadius: "0.5rem",
                        borderColor: "#d1d5db",
                        "&:hover": {
                          borderColor: "#9ca3af",
                        },
                      }),
                      multiValue: (base) => ({
                        ...base,
                        backgroundColor: "#ecfdf5",
                        borderRadius: "0.375rem",
                      }),
                      multiValueLabel: (base) => ({
                        ...base,
                        color: "#047857",
                        fontWeight: "500",
                      }),
                    }}
                  />
                </div>

                {lv.users.length > 0 && (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t("form.signatureLabel")}
                    </label>
                    <ul className="space-y-2">
                      {lv.users.map((u, i) => (
                        <li
                          key={i}
                          className="flex items-center justify-between bg-white rounded-lg border border-gray-200 px-4 py-3"
                        >
                          <div className="flex items-center min-w-0">
                            <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center mr-3 flex-shrink-0">
                              <User className="text-emerald-600" size={16} />
                            </div>
                            <span className="font-medium text-gray-700 truncate">
                              {u.label}
                            </span>
                          </div>

                          <div className="flex items-center ml-4 flex-shrink-0">
                            <span className="text-sm text-gray-500 mr-3">
                              {u.isSigReq ? "Signature required" : "No signature"}
                            </span>
                            <button
                              onClick={() =>
                                setNewLine((prev) => {
                                  const levels = prev.levels.map((lv, lvIdx) =>
                                    lvIdx !== idx
                                      ? lv
                                      : {
                                          ...lv,
                                          users: lv.users.map((uu, uIdx) =>
                                            uIdx !== i
                                              ? uu
                                              : { ...uu, isSigReq: !uu.isSigReq }
                                          ),
                                        }
                                  );
                                  return { ...prev, levels };
                                })
                              }
                              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                u.isSigReq ? "bg-emerald-500" : "bg-gray-300"
                              }`}
                            >
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                  u.isSigReq ? "translate-x-6" : "translate-x-1"
                                }`}
                              />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>

          <button
            onClick={addLevel}
            className="mb-6 w-full flex items-center justify-center gap-2 rounded-lg bg-white border border-gray-300 py-3 text-gray-700 font-medium hover:bg-gray-50 transition-colors"
          >
            <Plus size={16} /> {t("form.addLevel")}
          </button>

          <div className="flex gap-3 pt-4 border-t border-gray-200">
            {editing && (
              <button
                onClick={resetForm}
                className="flex-1 rounded-lg border border-gray-300 py-3 text-gray-700 font-medium hover:bg-gray-50 transition-colors"
              >
                {t("form.cancel")}
              </button>
            )}
            <button
              onClick={save}
              className="flex-1 rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-600 py-3 font-semibold text-white hover:from-emerald-600 hover:to-emerald-700 transition-all shadow-sm hover:shadow-md"
            >
              {editing ? "Save Changes" : "Create Approval Line"}
            </button>
          </div>
        </div>
      </div>

      {/* Admin Log Modal */}
      <AdminLogModal
        isOpen={showLogModal}
        onClose={() => setShowLogModal(false)}
        module="APPROVAL_LINE"
        title="Approval Line Management Log"
      />
    </div>
  );
}