import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { saveAs } from "file-saver";

interface AdminLogEntry {
  id: number;
  actorId: number;
  actionType: string;
  module: string;
  targetId: number | null;
  targetName: string | null;
  details: Record<string, any> | null;
  createdAt: string;
  createdAtFormatted: string;
  actor: {
    id: number;
    name: string;
    lastname: string | null;
    email: string;
  };
}

interface AdminLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  module: string;
  title?: string;
  targetId?: number | null;
}

const AdminLogModal: React.FC<AdminLogModalProps> = ({
  isOpen,
  onClose,
  module,
  title,
  targetId,
}) => {
  const { t } = useTranslation("adminLog");
  
  const [logs, setLogs] = useState<AdminLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [canDownloadExcel, setCanDownloadExcel] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);

  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [actionType, setActionType] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 500);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (isOpen) {
      setPage(1);
      fetchLogs();
    }
  }, [isOpen, module, debouncedSearch, actionType, startDate, endDate, targetId]);

  useEffect(() => {
    let alive = true;

    if (!isOpen) {
      setCanDownloadExcel(false);
      return () => {
        alive = false;
      };
    }

    api
      .get("/api/me")
      .then((response) => {
        if (!alive) return;
        const me = response.data?.user ?? response.data;
        const role = String(me?.role ?? "").toLowerCase();
        const roles = Array.isArray(me?.roles) ? me.roles : [];
        const hasAdminRole =
          role === "admin" ||
          roles.some((r: string) => String(r ?? "").toLowerCase() === "admin");
        setCanDownloadExcel(hasAdminRole);
      })
      .catch(() => {
        if (alive) setCanDownloadExcel(false);
      });

    return () => {
      alive = false;
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      fetchLogs();
    }
  }, [page]);

  const buildLogParams = (
    pageNumber: number,
    limit: number,
    searchValue = debouncedSearch
  ) => {
    const params: Record<string, any> = {
      module,
      page: pageNumber,
      limit,
      search: searchValue,
      actionType,
      startDate,
      endDate,
    };

    if (targetId !== null && targetId !== undefined) {
      params.targetId = targetId;
    }

    return params;
  };

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const response = await api.get("/api/admin-logs", {
        params: buildLogParams(page, 15),
      });
      setLogs(response.data.logs);
      setTotalPages(response.data.pagination.totalPages);
      setTotal(response.data.pagination.total);
    } catch (error) {
      console.error("Failed to fetch admin logs:", error);
    } finally {
      setLoading(false);
    }
  };

  const clearFilters = () => {
    setSearch("");
    setStartDate("");
    setEndDate("");
    setActionType("");
    setPage(1);
  };

  const getActionBadgeColor = (actionType: string) => {
    if (actionType.includes("CREATE")) return "bg-green-100 text-green-800 border border-green-300";
    if (actionType.includes("UPDATE") || actionType.includes("RENAME"))
      return "bg-blue-100 text-blue-800 border border-blue-300";
    if (actionType.includes("DELETE")) return "bg-red-100 text-red-800 border border-red-300";
    return "bg-gray-100 text-gray-800 border border-gray-300";
  };

  // Format field names to be more readable
  // e.g. "additionalBusinessUnitAccess" -> "Additional Business Unit Access"
  // e.g. "dccManagementBusinessUnits" -> "DCC Management Business Units"
  const formatFieldName = (fieldName: string): string => {
    // Special cases for known field names
    const specialNames: Record<string, string> = {
      additionalBusinessUnitAccess: "Additional Business Unit Access",
      dccManagementBusinessUnits: "DCC Management Business Units",
      businessUnitId: "Business Unit",
      businessUnitName: "Business Unit",
      departmentId: "Department",
      departmentName: "Department",
    };

    if (specialNames[fieldName]) {
      return specialNames[fieldName];
    }

    // Convert camelCase to Title Case with spaces
    return fieldName
      .replace(/([A-Z])/g, " $1") // Add space before capital letters
      .replace(/^./, (str) => str.toUpperCase()) // Capitalize first letter
      .trim();
  };

  const formatDetails = (details: Record<string, any> | null) => {
    if (!details) return "-";
    return Object.entries(details)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return `${key}: [${value.length} items]`;
        }
        if (typeof value === "object" && value !== null) {
          return `${key}: ${JSON.stringify(value)}`;
        }
        return `${key}: ${value}`;
      })
      .join(", ");
  };

  const getActorName = (log: AdminLogEntry) =>
    [log.actor?.name, log.actor?.lastname].filter(Boolean).join(" ") || "-";

  const handleDownloadExcel = async () => {
    if (exporting || !canDownloadExcel) return;

    setExporting(true);
    try {
      const pageSize = 100;
      const firstResponse = await api.get("/api/admin-logs", {
        params: buildLogParams(1, pageSize, search.trim()),
      });
      const firstLogs: AdminLogEntry[] = firstResponse.data.logs ?? [];
      const exportTotalPages = Number(
        firstResponse.data.pagination?.totalPages ?? 1
      );
      const allLogs = [...firstLogs];

      for (let nextPage = 2; nextPage <= exportTotalPages; nextPage += 1) {
        const response = await api.get("/api/admin-logs", {
          params: buildLogParams(nextPage, pageSize, search.trim()),
        });
        allLogs.push(...((response.data.logs ?? []) as AdminLogEntry[]));
      }

      if (allLogs.length === 0) {
        console.warn("No admin logs available for export");
        return;
      }

      const headers = [
        "ID",
        "Time",
        "Actor",
        "Actor Email",
        "Action",
        "Module",
        "Target ID",
        "Target Name",
        "Details",
      ];
      const rows = allLogs.map((log) => [
        log.id,
        log.createdAtFormatted || new Date(log.createdAt).toLocaleString(),
        getActorName(log),
        log.actor?.email || "",
        log.actionType || "",
        log.module || "",
        log.targetId ?? "",
        log.targetName || "",
        formatDetails(log.details),
      ]);
      const worksheetData = [headers, ...rows];

      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(`${module} Logs`);
      worksheet.addRows(worksheetData);
      worksheet.getRow(1).font = { bold: true };
      worksheet.columns.forEach((column, index) => {
        const maxLength = worksheetData.reduce((max, row) => {
          const cellValue = row[index];
          return Math.max(max, String(cellValue ?? "").length);
        }, headers[index]?.length ?? 10);
        column.width = Math.min(Math.max(maxLength + 2, 12), 80);
      });

      const safeModule = module.toLowerCase().replace(/[^a-z0-9_-]+/gi, "-");
      const filename = `admin_logs_${safeModule}_${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      saveAs(blob, filename);
    } catch (error) {
      console.error("Failed to export admin logs:", error);
    } finally {
      setExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        {/* Backdrop */}
        <div
          className="fixed inset-0 transition-opacity"
          onClick={onClose}
        />

        {/* Modal */}
        <div className="relative w-full max-w-5xl rounded-2xl bg-white shadow-2xl border border-gray-200">
          {/* Header */}
          <div className="flex items-center justify-between bg-[#183e33] rounded-t-2xl px-6 py-4">
            <h2 className="text-xl font-semibold text-white">
              {title || t("title")} 
              <span className="ml-2 text-sm font-normal opacity-80">{t("totalItems", { count: total })}</span>
            </h2>
            <button
              onClick={onClose}
              className="rounded-full p-2 text-white hover:bg-white/20 transition-colors"
            >
              <svg
                className="h-5 w-5"
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

          {/* Filters */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-200 flex flex-wrap gap-4 items-end">
            {/* Search */}
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">{t("filters.searchLabel")}</label>
              <input
                type="text"
                placeholder={t("filters.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#183e33] focus:border-transparent"
              />
            </div>

            {/* Action Type */}
            <div className="w-[200px]">
              <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">{t("filters.actionTypeLabel")}</label>
              <select
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#183e33] focus:border-transparent bg-white transition-shadow"
              >
                <option value="">{t("filters.allActions")}</option>
                {(() => {
                   const commonActions = ["CREATE", "UPDATE", "DELETE"];
                   const modulePrefix = module === "BUSINESS_UNIT" ? "BU" : module;
                   // Specific known actions mapping
                   const specificActions: Record<string, string[]> = {
                     USER: ["USER_CREATE", "USER_UPDATE", "USER_DELETE", "USER_PASSWORD_CHANGE"],
                     DEPARTMENT: ["DEPARTMENT_CREATE", "DEPARTMENT_UPDATE", "DEPARTMENT_DELETE"],
                     BUSINESS_UNIT: ["BU_CREATE", "BU_UPDATE", "BU_DELETE"],
                     LOA: ["LOA_createLine", "LOA_updateLine", "LOA_deleteLine", "LOA_UPDATE_LEVEL", "LOA_UPDATE_LEVEL_APPROVER"],
                     CC_GROUP: ["CC_CREATE", "CC_UPDATE", "CC_DELETE", "CC_UPDATE_MEMBERS", "CC_RENAME"],
                     MEMO_TYPE: ["MEMO_TYPE_CREATE", "MEMO_TYPE_UPDATE", "MEMO_TYPE_DELETE", "MEMO_TYPE_LOA_UPDATE"]
                   };

                   const options = specificActions[module] || commonActions.map(a => `${module}_${a}`);
                   
                   return options.map(action => (
                     <option key={action} value={action}>
                       {action.replace(/_/g, " ")}
                     </option>
                   ));
                })()}
              </select>
            </div>

            {/* Start Date */}
            <div className="w-[150px]">
              <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">{t("filters.startDateLabel")}</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#183e33] focus:border-transparent"
              />
            </div>

            {/* End Date */}
            <div className="w-[150px]">
              <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">{t("filters.endDateLabel")}</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#183e33] focus:border-transparent"
              />
            </div>

            {canDownloadExcel && (
              <div>
                <button
                  onClick={handleDownloadExcel}
                  disabled={exporting || total === 0}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors h-[38px] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  title={t("export.downloadExcel")}
                >
                  <Download className="h-4 w-4" />
                  <span>
                    {exporting ? t("export.downloading") : t("export.downloadExcel")}
                  </span>
                </button>
              </div>
            )}

            {/* Clear Button */}
            <div>
               <button
                onClick={clearFilters}
                className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-100 transition-colors h-[38px]"
                title={t("filters.reset")}
              >
                {t("filters.reset")}
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="max-h-[55vh] overflow-y-auto p-4">
            {loading ? (
              <div className="flex justify-center py-12">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#183e33] border-t-transparent" />
              </div>
            ) : logs.length === 0 ? (
              <div className="py-12 text-center text-gray-500">
                <div className="text-4xl mb-2">📭</div>
                {t("status.noLogs")}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-xs uppercase text-gray-700 border-b">
                    <tr>
                      <th className="px-4 py-3 font-semibold">{t("table.time")}</th>
                      <th className="px-4 py-3 font-semibold">{t("table.actor")}</th>
                      <th className="px-4 py-3 font-semibold">{t("table.action")}</th>
                      <th className="px-4 py-3 font-semibold">{t("table.target")}</th>
                      <th className="px-4 py-3 font-semibold">{t("table.details")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {logs.map((log) => (
                      <React.Fragment key={log.id}>
                        <tr className="hover:bg-gray-50 transition-colors">
                          <td className="whitespace-nowrap px-4 py-3 text-gray-600 text-xs">
                            {log.createdAtFormatted}
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-[#183e33]">
                              {log.actor.name} {log.actor.lastname || ""}
                            </div>
                            <div className="text-xs text-gray-400">
                              {log.actor.email}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getActionBadgeColor(
                                log.actionType
                              )}`}
                            >
                              {log.actionType}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-700">
                            <div className="font-medium">{log.targetName || "-"}</div>
                            {log.targetId && (
                              <div className="text-xs text-gray-400">
                                ID: {log.targetId}
                              </div>
                            )}
                          </td>
                          <td className="max-w-[200px] px-4 py-3 text-gray-500">
                            {log.details && Object.keys(log.details).length > 0 ? (
                              <button
                                onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
                                className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer flex items-center gap-1"
                              >
                                {expandedLogId === log.id ? t("table.hide") : t("table.viewMore")}
                                <span className="text-xs">{expandedLogId === log.id ? "▲" : "▼"}</span>
                              </button>
                            ) : (
                              <span className="text-xs text-gray-400">-</span>
                            )}
                          </td>
                        </tr>
{/* Expanded Details Row */}
{expandedLogId === log.id && log.details && (
  <tr className="bg-gray-50">
    <td colSpan={5} className="px-6 py-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
        {Object.entries(log.details).map(([key, value], idx) => {
          // ── Case 1: "changes" Field (Clean Grid Style) ──
          if (key === "changes" && typeof value === "object" && value !== null) {
            return (
              <React.Fragment key={key}>
                <div className="col-span-1 md:col-span-2 mb-2 mt-2 pb-2 border-b border-gray-100">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">
                    {t("table.changesLog")}
                  </span>
                </div>
                
                {Object.entries(value as Record<string, any>).map(([field, delta]) => {
                  const oldVal = delta?.old;
                  const newVal = delta?.new;
                  
                  // Helper to format value
                  const formatVal = (v: any) => {
                    if (v === null || v === undefined) return <span className="text-gray-400 italic">{t("table.null")}</span>;
                    if (typeof v === "boolean") return v ? "true" : "false";
                    if (typeof v === "object") return JSON.stringify(v);
                    return String(v);
                  };

                  return (
                    <div
                      key={field}
                      className="col-span-1 md:col-span-2 grid grid-cols-[140px_1fr] gap-4 items-baseline pb-2 border-b border-dashed border-gray-200 last:border-b-0"
                    >
                      {/* label */}
                      <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">
                        {formatFieldName(field)}
                      </div>

                      {/* value with arrow */}
                      <div className="text-sm text-gray-700 font-medium break-words flex items-center flex-wrap gap-2">
                         <span className="text-gray-500 line-through opacity-75">
                           {formatVal(oldVal)}
                         </span>
                         <span className="text-gray-400">➜</span>
                         <span className="text-[#183e33] font-semibold">
                           {formatVal(newVal)}
                         </span>
                      </div>
                    </div>
                  );
                })}
              </React.Fragment>
            );
          }

          // ── Case 2: Normal Field ──
          return (
            <div
              key={key}
              className="grid grid-cols-[140px_1fr] gap-4 items-baseline pb-2 border-b border-dashed border-gray-200 last:border-b-0"
            >
              {/* label */}
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">
                {formatFieldName(key)}
              </div>

              {/* value */}
              <div className="text-sm text-gray-700 font-medium break-words">
                {Array.isArray(value) ? (
                  value.length > 0 ? (
                    value.map((v, i) => (
                      <span
                        key={i}
                        className="block mb-1 text-gray-600"
                      >
                        • {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                      </span>
                    ))
                  ) : (
                    <span className="text-gray-400">-</span>
                  )
                ) : typeof value === 'object' && value !== null ? (
                  <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap bg-gray-50 p-2 rounded border border-gray-100 mt-1">
                    {JSON.stringify(value, null, 2)}
                  </pre>
                ) : (
                  String(value)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </td>
  </tr>
)}

                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Pagination & Footer */}
          <div className="flex items-center justify-between border-t bg-gray-50 rounded-b-2xl px-6 py-4">
            <div className="text-sm text-gray-600">
              {total > 0 ? t("pagination.page", { current: page, total: totalPages }) : ""}
            </div>
            <div className="flex items-center gap-3">
              {totalPages > 1 && (
                <>
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ← {t("pagination.prev")}
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {t("pagination.next")} →
                  </button>
                </>
              )}
              <button
                onClick={onClose}
                className="rounded-lg bg-[#183e33] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#0f2820] transition-colors"
              >
                {t("pagination.close")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminLogModal;
