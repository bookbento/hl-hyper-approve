// src/page/ApproverAdmin/ApproverAdminPage.tsx
import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import AsyncSelect from "react-select/async";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { FiFilter } from "react-icons/fi";
import AdminLogModal from "../../components/AdminLogModal";

/* ---------- types ---------- */

type UserOption = {
  value: number;
  label: string;
};

type ReplaceResult = {
  ok?: boolean;
  templatePivotsChanged: number;
  templatePivotsDeletedAsDup: number;
  memoApproversChanged: number;
  ccMembersChanged: number;
  fromUser?: { id: number; name: string };
  toUser?: { id: number; name: string };
  error?: string;
};

type ReplacePayload = {
  fromUserId: number;
  toUserId: number;
  affectTemplates: boolean;
  affectRunningMemos: boolean;
  affectCcGroups: boolean;
  dryRun: boolean;
  lineOfApprovalIds?: number[];
};

// slot ของแต่ละ level ใน line
type LineSlot = {
  level: number;
  userId: number | null;
  userName: string | null;
  /** true = คือ user ที่เราเลือกในช่อง "จากผู้อนุมัติ (เดิม)" */
  isTarget: boolean;
  slotType?: string | null;
};

interface ApproverLine {
  pivotId: number;
  lineOfApprovalId: number;
  lineName: string | null;
  level: number;
  businessUnitName?: string | null;
  departmentName?: string | null;
  memoTypeName?: string | null;
  memoTypeAbbr?: string | null;
  /** รายชื่อทุกคนทุก level ใน line นี้ (ฝั่ง backendเติมให้) */
  slots?: LineSlot[];
}
type SortBy = "line" | "memoType" | "approver" | null;
type SortDir = "asc" | "desc" | null;

const ApproverAdminPage: React.FC = () => {
  const { t } = useTranslation("approverAdmin");

  const [fromUser, setFromUser] = useState<UserOption | null>(null);
  const [toUser, setToUser] = useState<UserOption | null>(null);

  const [fromUserLines, setFromUserLines] = useState<ApproverLine[]>([]);
  const [loadingLines, setLoadingLines] = useState(false);
  const [allLines, setAllLines] = useState<ApproverLine[]>([]);

  // ✅ เก็บ line ที่ “เลือกจะเปลี่ยน”
  const [selectedLineIds, setSelectedLineIds] = useState<number[]>([]);

  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ReplaceResult | null>(null);

  const [showLogModal, setShowLogModal] = useState(false);

  // 🔍 filter per column

  // 🔍 filter per column
  const [lineFilter, setLineFilter] = useState("");
  const [memoTypeFilter, setMemoTypeFilter] = useState("");
  const [approverFilter, setApproverFilter] = useState("");

  // 🔽 sort state (ใช้ทีละคอลัมน์)
  const [sortBy, setSortBy] = useState<SortBy>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

const [activeFilter, setActiveFilter] = useState<SortBy>(null);

// page size + โหมด All
const [pageSize, setPageSize] = useState(10);
const [isAllPages, setIsAllPages] = useState(false);
const [currentPage, setCurrentPage] = useState(1);

  const groupedLines = useMemo(() => {
    const source = fromUser ? fromUserLines : allLines;

    type Grouped = {
      lineOfApprovalId: number;
      lineName: string | null;
      memoTypeName?: string | null;
      memoTypeAbbr?: string | null;
      businessUnitName?: string | null;
      departmentName?: string | null;
      slots: LineSlot[];
    };

    const map = new Map<number, Grouped>();

    for (const l of source) {
      if (l.lineOfApprovalId == null) continue;

      if (!map.has(l.lineOfApprovalId)) {
        map.set(l.lineOfApprovalId, {
          lineOfApprovalId: l.lineOfApprovalId,
          lineName: l.lineName,
          memoTypeName: l.memoTypeName,
          memoTypeAbbr: l.memoTypeAbbr,
          businessUnitName: l.businessUnitName ?? null,
          departmentName: l.departmentName ?? null,
          slots: (l.slots ?? []).slice(),
        });
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      const nameA = a.lineName || `Line #${a.lineOfApprovalId}`;
      const nameB = b.lineName || `Line #${b.lineOfApprovalId}`;
      return nameA.localeCompare(nameB);
    });
  }, [fromUser, fromUserLines, allLines]);

  // ✅ เอาไว้ฟิลเตอร์เหมือน Excel ต่อหัวคอลัมน์
  const filteredLines = useMemo(() => {
    const lineSearch = lineFilter.trim().toLowerCase();
    const memoSearch = memoTypeFilter.trim().toLowerCase();
    const approverSearch = approverFilter.trim().toLowerCase();

    // 1) filter ตาม text
    let result = groupedLines.filter((line) => {
      // filter by Line (ชื่อ / ID / BU/Dept)
      if (lineSearch) {
        const label = (
          line.lineName || `Line #${line.lineOfApprovalId}`
        ).toLowerCase();
        const bu = (line.businessUnitName || "").toLowerCase();
        const dept = (line.departmentName || "").toLowerCase();
        const idStr = String(line.lineOfApprovalId || "").toLowerCase();

        if (
          !(
            label.includes(lineSearch) ||
            bu.includes(lineSearch) ||
            dept.includes(lineSearch) ||
            idStr.includes(lineSearch)
          )
        ) {
          return false;
        }
      }

      // filter by Memo Type
      if (memoSearch) {
        const abbr = (line.memoTypeAbbr || "").toLowerCase();
        const mtName = (line.memoTypeName || "").toLowerCase();
        if (!abbr.includes(memoSearch) && !mtName.includes(memoSearch)) {
          return false;
        }
      }

      // filter by Approver (ค้นจากชื่อทุกคนใน line)
      if (approverSearch) {
        const hasMatch =
          line.slots?.some((s) =>
            (s.userName || "").toLowerCase().includes(approverSearch)
          ) ?? false;
        if (!hasMatch) return false;
      }

      return true;
    });

    // 2) sort (A→Z / Z→A) ตามคอลัมน์ที่เลือก
    if (sortBy && sortDir) {
      const getKey = (line: {
        lineOfApprovalId: number;
        lineName: string | null;
        memoTypeAbbr?: string | null;
        memoTypeName?: string | null;
        slots: LineSlot[];
        businessUnitName?: string | null;
        departmentName?: string | null;
      }) => {
        if (sortBy === "line") {
          return (line.lineName || `Line #${line.lineOfApprovalId}`)
            .toString()
            .toLowerCase();
        }
        if (sortBy === "memoType") {
          return (line.memoTypeAbbr || line.memoTypeName || "")!
            .toString()
            .toLowerCase();
        }
        if (sortBy === "approver") {
          const names =
            line.slots
              ?.map((s) => s.userName || "")
              .filter(Boolean)
              .join(" | ") || "";
          return names.toLowerCase();
        }
        return "";
      };

      result = [...result].sort((a, b) => {
        const aKey = getKey(a);
        const bKey = getKey(b);
        if (aKey < bKey) return sortDir === "asc" ? -1 : 1;
        if (aKey > bKey) return sortDir === "asc" ? 1 : -1;
        return 0;
      });
    }

    return result;
  }, [
    groupedLines,
    lineFilter,
    memoTypeFilter,
    approverFilter,
    sortBy,
    sortDir,
  ]);

  
// จำนวนหน้า
const totalPages = useMemo(() => {
  if (filteredLines.length === 0) return 1;
  if (isAllPages) return 1; // โหมด All = หน้าเดียว
  return Math.ceil(filteredLines.length / pageSize);
}, [filteredLines.length, pageSize, isAllPages]);

// list ที่เอาไป render เฉพาะหน้าปัจจุบัน
const paginatedLines = useMemo(() => {
  if (isAllPages) {
    // แสดงทุกแถวตาม filter
    return filteredLines;
  }
  const start = (currentPage - 1) * pageSize;
  return filteredLines.slice(start, start + pageSize);
}, [filteredLines, currentPage, pageSize, isAllPages]);


useEffect(() => {
  setCurrentPage(1);
}, [pageSize, filteredLines.length, isAllPages]);
  /* ---------- user search ---------- */
  const loadUserOptions = async (inputValue: string) => {
    try {
      const { data } = await axios.get<
        Array<{
          id: number;
          name: string;
          lastname?: string | null;
          nickname?: string | null;
        }>
      >("/api/users/search", {
        withCredentials: true,
        params: { q: inputValue || "", limit: 20 },
      });

      return data.map((u) => {
        const fullName = [u.name, u.lastname].filter(Boolean).join(" ");
        const label = u.nickname
          ? `${fullName} (${u.nickname})`
          : fullName || `ID ${u.id}`;
        return { value: u.id, label };
      });
    } catch (err) {
      console.error("search users error:", err);
      return [];
    }
  };

  /* ---------- โหลด line ที่ user นี้อยู่ (ฝั่ง fromUser) ---------- */
  const fetchFromUserLines = async (userId: number) => {
    setLoadingLines(true);
    setFromUserLines([]);
    setSelectedLineIds([]); // เคลียร์ selection เดิมก่อน

    try {
      const { data } = await axios.get<ApproverLine[]>(
        `/api/approvers/${userId}/lines`,
        { withCredentials: true }
      );

      const lines = data || [];
      setFromUserLines(lines);

      // ✅ default: เลือกทุก line ไว้ก่อน
      const selectableIds = lines
        .map((l) => l.lineOfApprovalId)
        .filter((id): id is number => typeof id === "number");
      setSelectedLineIds(Array.from(new Set(selectableIds)));
    } catch (err: any) {
      console.error("fetchFromUserLines error:", err?.response || err);
      toast.error(
        err?.response?.data?.error ||
          t(
            "toast.loadLinesFailed",
            "โหลดรายการ line ที่ผู้อนุมัติคนนี้อยู่ไม่สำเร็จ"
          )
      );
    } finally {
      setLoadingLines(false);
    }
  };

  const fetchAllLines = async () => {
    setLoadingLines(true);
    try {
      const { data } = await axios.get<ApproverLine[]>("/api/approver-lines", {
        withCredentials: true,
      });
      setAllLines(data || []);
    } catch (err: any) {
      console.error("fetchAllLines error:", err?.response || err);
      toast.error(
        err?.response?.data?.error ||
          t("toast.loadAllLinesFailed", "โหลดรายการ Line ทั้งหมดไม่สำเร็จ")
      );
    } finally {
      setLoadingLines(false);
    }
  };

  useEffect(() => {
    fetchAllLines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

useEffect(() => {
  if (!fromUser) {
    // ยังไม่เลือก user → กลับสู่โหมดปกติ
    setFromUserLines([]);
    setSelectedLineIds([]);
    setIsAllPages(false);   // กลับมาใช้ pagination ปกติ
    setCurrentPage(1);
    return;
  }

  const userId = fromUser.value;

  // mark isTarget + filter เฉพาะ line ที่มี user นี้
  const linesWithTarget = allLines
    .map((line) => {
      const slots = (line.slots ?? []).map((s) => ({
        ...s,
        isTarget: s.userId === userId && s.slotType === "FIXED_USER",
      }));
      return { ...line, slots };
    })
    .filter((line) =>
      (line.slots ?? []).some(
        (s) => s.userId === userId && s.slotType === "FIXED_USER"
      )
    );

  setFromUserLines(linesWithTarget);

  // default เลือกทุก line ของ user นี้
  const selectableIds = linesWithTarget
    .map((l) => l.lineOfApprovalId)
    .filter((id): id is number => typeof id === "number");
  setSelectedLineIds(Array.from(new Set(selectableIds)));

  // 🔥 เมื่อเลือก user แล้ว → ดู "All" ของคนนั้นเลย
  setIsAllPages(true);
  setCurrentPage(1);
}, [fromUser, allLines]);


  useEffect(() => {
    setLineFilter("");
    setMemoTypeFilter("");
    setApproverFilter("");
  }, [fromUser]);
  /* ---------- helper: จัดการ checkbox line ---------- */
  const toggleLine = (lineId: number) => {
    setSelectedLineIds((prev) =>
      prev.includes(lineId)
        ? prev.filter((id) => id !== lineId)
        : [...prev, lineId]
    );
  };
  const clearColumnFilter = (col: SortBy) => {
    if (col === "line") setLineFilter("");
    if (col === "memoType") setMemoTypeFilter("");
    if (col === "approver") setApproverFilter("");

    if (sortBy === col) {
      setSortBy(null);
      setSortDir(null);
    }
  };

  const selectAllLines = () => {
    const allIds = fromUserLines
      .map((l) => l.lineOfApprovalId)
      .filter((id): id is number => typeof id === "number");
    setSelectedLineIds(Array.from(new Set(allIds)));
  };

  const clearAllLines = () => {
    setSelectedLineIds([]);
  };

  // 🚿 ปุ่ม Clear All ใหญ่
const handleClearAll = () => {
  setFromUser(null);
  setToUser(null);
  setFromUserLines([]);
  setSelectedLineIds([]);

  setLineFilter("");
  setMemoTypeFilter("");
  setApproverFilter("");

  setSortBy(null);
  setSortDir(null);
  setActiveFilter(null);

  setIsAllPages(false);   // reset โหมด All
  setCurrentPage(1);

  setResult(null);
};


  /* ---------- ยืนยันเปลี่ยนผู้อนุมัติ ---------- */
  const handleApply = async () => {
    if (!fromUser || !toUser) {
      toast.error(
        t(
          "toast.selectUsersFirst",
          "กรุณาเลือกผู้อนุมัติเดิม (จาก) และผู้อนุมัติใหม่ (เป็น)"
        )
      );
      return;
    }
    if (fromUser.value === toUser.value) {
      toast.error(
        t("toast.sameUser", "ไม่สามารถเลือกคนเดิมเป็นทั้งจากและเป็นได้")
      );
      return;
    }

    if (!fromUserLines.length) {
      toast.error(
        t(
          "toast.noLinesForFromUser",
          "ผู้ใช้เดิมยังไม่ได้เป็นผู้อนุมัติใน line ใดเลย"
        )
      );
      return;
    }

    if (selectedLineIds.length === 0) {
      toast.error(
        t(
          "toast.noLineSelected",
          "กรุณาเลือกอย่างน้อยหนึ่ง line ที่ต้องการเปลี่ยน"
        )
      );
      return;
    }

    if (
      !window.confirm(
        t(
          "confirm.applySelected",
          "คุณแน่ใจหรือไม่ว่าต้องการแทนที่ผู้อนุมัติในทุก line ที่เลือกเป็นคนใหม่?"
        )
      )
    ) {
      return;
    }

    const uniqueLineIds = Array.from(new Set(selectedLineIds));

    const payload: ReplacePayload = {
      fromUserId: fromUser.value,
      toUserId: toUser.value,
      affectTemplates: true,
      affectRunningMemos: true, // ตอนนี้หลังบ้านยัง no-op แต่ใส่ไว้เผื่ออนาคต
      affectCcGroups: false,
      dryRun: false,
      lineOfApprovalIds: uniqueLineIds, // ✅ ส่งเฉพาะ line ที่เลือก
    };

    setApplying(true);
    setResult(null);

    try {
      const { data } = await axios.post<ReplaceResult>(
        "/api/approvers/replace",
        payload,
        { withCredentials: true }
      );
      setResult(data);
      toast.success(
        t("toast.applyOk", "เปลี่ยนผู้อนุมัติเรียบร้อย ตรวจสอบผลลัพธ์ด้านล่าง")
      );
    } catch (err: any) {
      console.error("apply replaceApprover error:", err?.response || err);
      toast.error(
        err?.response?.data?.error ||
          t("toast.applyFail", "เปลี่ยนผู้อนุมัติไม่สำเร็จ")
      );
    } finally {
      setApplying(false);
    }
  };

  /* ---------- UI ---------- */

  return (
    <div className="p-6 w-full">
      {/* header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-3">
        <h1 className="text-2xl font-bold text-[#183e33]">
          {t("title", "จัดการผู้มีอำนาจอนุมัติ")}
        </h1>
        <button
          onClick={() => setShowLogModal(true)}
          className="bg-gray-600 text-white px-4 py-2 rounded-[15px] hover:bg-gray-700"
        >
          {t("viewLog")}
        </button>
      </div>

      {/* 🔘 ปุ่ม Clear All ใหญ่ ระหว่าง header กับ card */}
      <div className="flex justify-end mb-3">
        <button
          type="button"
          onClick={handleClearAll}
          className="inline-flex items-center rounded-full bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-200 hover:text-slate-900"
        >
          {t("filter.clearAllBig", "Clear all filters, sort, and selections")}
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-xl border border-emerald-900/10 p-6 space-y-6">
        {/* 1) เลือกผู้อนุมัติจาก / เป็น */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* From user */}
          <div>
            <label className="block text-sm font-semibold text-emerald-800 mb-1">
              {t("fromUser.label", "เปลี่ยนจากผู้อนุมัติ (เดิม)")}
            </label>
            <AsyncSelect<UserOption, false>
              cacheOptions
              defaultOptions
              loadOptions={loadUserOptions}
              value={fromUser}
              onChange={(opt) => setFromUser(opt)}
              placeholder={t("fromUser.placeholder", "ค้นหาชื่อ / อีเมล")}
            />
          </div>

          {/* To user */}
          <div>
            <label className="block text-sm font-semibold text-emerald-800 mb-1">
              {t("toUser.label", "แทนที่ด้วย (คนใหม่)")}
            </label>
            <AsyncSelect<UserOption, false>
              cacheOptions
              defaultOptions
              loadOptions={loadUserOptions}
              value={toUser}
              onChange={(opt) => setToUser(opt)}
              placeholder={t("toUser.placeholder", "ค้นหาชื่อ / อีเมล")}
            />
          </div>
        </div>

        {/* 2) ตาราง line เต็มการ์ด */}
        <div className="mt-4">
          {/* header เหมือน Recent Transactions */}
{/* header เหมือน Recent Transactions */}
<div className="flex items-start justify-between mb-3">
  <div>
    <h2 className="text-base font-semibold text-slate-900">
      {fromUser
        ? t("fromUser.linesTitle", "รายการ Line ของผู้มีอำนาจคนนี้")
        : t("allLines.title", "รายการ Line ผู้มีอำนาจอนุมัติทั้งหมด")}
    </h2>
    <p className="text-xs text-slate-500">
      {fromUser
        ? t(
            "fromUser.linesSubtitle",
            "แต่ละแถวคือ 1 line แสดงทุก level และทุกคนใน line นั้น — badge สีเขียวคือคนที่กำลังจะถูกแทนที่"
          )
        : t(
            "allLines.subtitle",
            "เลือกผู้มีอำนาจอนุมัติด้านบนเพื่อกรองเฉพาะ Line ที่มีคน ๆ นั้นอยู่"
          )}
    </p>
  </div>

  {/* ฝั่งขวา: ปุ่มเลือกทั้งหมด + pagination */}
  <div className="flex flex-col items-end gap-1">
    {/* ปุ่มเลือกทั้งหมด/ล้างทั้งหมด (เฉพาะตอนมี fromUser) */}
    {fromUser && fromUserLines.length > 0 && (
      <div className="flex gap-2">
        <button
          type="button"
          onClick={selectAllLines}
          className="text-[11px] text-emerald-700 hover:underline"
        >
          {t("fromUser.selectAll", "เลือกทั้งหมด")}
        </button>
        <button
          type="button"
          onClick={clearAllLines}
          className="text-[11px] text-gray-500 hover:underline"
        >
          {t("fromUser.clearAll", "ล้างทั้งหมด")}
        </button>
      </div>
    )}

    {/* Pagination */}
    <div className="flex items-center gap-2 text-[11px] text-slate-600">
      <span>
        Page {currentPage} / {totalPages}
      </span>

      {/* ปุ่มย้อนหน้า */}
      <button
        type="button"
        onClick={() =>
          setCurrentPage((p) => (p > 1 ? p - 1 : p))
        }
        disabled={currentPage === 1}
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 disabled:opacity-40"
      >
        &lt;
      </button>

      {/* เลือกจำนวนที่แสดงผลต่อหน้า */}
<select
  value={isAllPages ? "ALL" : String(pageSize)}
  onChange={(e) => {
    const value = e.target.value;
    if (value === "ALL") {
      setIsAllPages(true);
      setCurrentPage(1);
    } else {
      setIsAllPages(false);
      setPageSize(Number(value));
    }
  }}
  className="h-7 rounded-lg border border-slate-400 bg-white px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-emerald-500"
>
  <option value="10">10</option>
  <option value="20">20</option>
  <option value="50">50</option>
  <option value="100">100</option>
  <option value="ALL">
    {t("pagination.all", "All")}
  </option>
</select>


      {/* ปุ่มหน้าถัดไป */}
      <button
        type="button"
        onClick={() =>
          setCurrentPage((p) =>
            p < totalPages ? p + 1 : p
          )
        }
        disabled={currentPage === totalPages || filteredLines.length === 0}
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 disabled:opacity-40"
      >
        &gt;
      </button>
    </div>
  </div>
</div>


          {loadingLines && (
            <p className="text-[11px] text-gray-500">
              {t("fromUser.loadingLines", "กำลังโหลด line ที่เกี่ยวข้อง…")}
            </p>
          )}

          {/* เคส: เลือก fromUser แล้ว แต่ไม่มี line ของคนนี้เลย */}
          {!loadingLines && fromUser && fromUserLines.length === 0 && (
            <p className="text-[11px] text-gray-500">
              {t(
                "fromUser.noLines",
                "ผู้ใช้คนนี้ยังไม่ได้ถูกตั้งเป็นผู้มีอำนาจอนุมัติใน line ไหนเลย"
              )}
            </p>
          )}

          {/* แสดงตาราง: ใช้ groupedLines ซึ่งจะเป็น 
              - ทุก line (ตอนยังไม่เลือก fromUser)
              - หรือเฉพาะ line ของ fromUser (หลัง filter) */}
          {!loadingLines && groupedLines.length > 0 && (
            <div className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50/70 overflow-hidden">
              <div className="w-full overflow-x-auto">
                <table className="w-full min-w-full text-xs table-fixed">
                  <thead>
                    <tr className="bg-slate-50 text-[11px] text-slate-500">
                      <th className="px-4 py-2 text-left w-10"></th>

                      {/* Line column header + filter button */}
                      <th className="relative px-4 py-2 text-left font-semibold w-1/4">
                        <div className="flex items-center gap-1">
                          <span>{t("table.line", "Line")}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setActiveFilter((prev) =>
                                prev === "line" ? null : "line"
                              )
                            }
                            className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-emerald-500 bg-white text-emerald-600 hover:bg-emerald-50"
                          >
                            <FiFilter className="h-3 w-3" />
                          </button>
                        </div>

                        {activeFilter === "line" && (
                          <div className="absolute left-0 top-full  mt-1 w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                            <div className="flex items-start justify-between mb-2">
                              <div>
                                <div className="text-[11px] font-semibold text-slate-700">
                                  {t("filter.sortTitle", "Sort")}
                                </div>
                                <div className="mt-1 flex gap-2">
                                  {/* A → Z */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (
                                        sortBy === "line" &&
                                        sortDir === "asc"
                                      ) {
                                        setSortBy(null);
                                        setSortDir(null);
                                      } else {
                                        setSortBy("line");
                                        setSortDir("asc");
                                      }
                                    }}
                                    className={
                                      "flex-1 rounded-lg border px-2 py-1 text-[11px] " +
                                      (sortBy === "line" && sortDir === "asc"
                                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                        : "border-slate-200 bg-white text-slate-600")
                                    }
                                  >
                                    A → Z
                                  </button>
                                  {/* Z → A */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (
                                        sortBy === "line" &&
                                        sortDir === "desc"
                                      ) {
                                        setSortBy(null);
                                        setSortDir(null);
                                      } else {
                                        setSortBy("line");
                                        setSortDir("desc");
                                      }
                                    }}
                                    className={
                                      "flex-1 rounded-lg border px-2 py-1 text-[11px] " +
                                      (sortBy === "line" && sortDir === "desc"
                                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                        : "border-slate-200 bg-white text-slate-600")
                                    }
                                  >
                                    Z → A
                                  </button>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  clearColumnFilter("line");
                                  setActiveFilter(null);
                                }}
                                className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                              >
                                ×
                              </button>
                            </div>

                            <div className="mt-2">
                              <div className="text-[11px] font-semibold text-slate-700">
                                {t("filter.filtersTitle", "Filters")}
                              </div>
                              <input
                                type="text"
                                value={lineFilter}
                                onChange={(e) => setLineFilter(e.target.value)}
                                placeholder={t(
                                  "filter.line",
                                  "Type to search Line / ID / BU / Dept"
                                )}
                                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                              />
                            </div>

                            <div className="mt-2 flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => clearColumnFilter("line")}
                                className="rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                              >
                                {t("filter.clear", "Clear")}
                              </button>

                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => setActiveFilter(null)}
                                  className="rounded-md border border-slate-200 px-3 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                                >
                                  {t("filter.close", "Close")}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setActiveFilter(null)}
                                  className="rounded-md bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700"
                                >
                                  {t("filter.apply", "Apply")}
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </th>

                      {/* Memo Type header */}
                      <th className="relative px-4 py-2 text-left font-semibold w-1/4">
                        <div className="flex items-center gap-1">
                          <span>{t("table.memoType", "Memo Type")}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setActiveFilter((prev) =>
                                prev === "memoType" ? null : "memoType"
                              )
                            }
                            className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-emerald-500 bg-white text-emerald-600 hover:bg-emerald-50"
                          >
                            <FiFilter className="h-3 w-3" />
                          </button>
                        </div>

                        {activeFilter === "memoType" && (
                          <div className="absolute left-0 top-full  mt-1 w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                            <div className="flex items-start justify-between mb-2">
                              <div>
                                <div className="text-[11px] font-semibold text-slate-700">
                                  {t("filter.sortTitle", "Sort")}
                                </div>
                                <div className="mt-1 flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (
                                        sortBy === "memoType" &&
                                        sortDir === "asc"
                                      ) {
                                        setSortBy(null);
                                        setSortDir(null);
                                      } else {
                                        setSortBy("memoType");
                                        setSortDir("asc");
                                      }
                                    }}
                                    className={
                                      "flex-1 rounded-lg border px-2 py-1 text-[11px] " +
                                      (sortBy === "memoType" &&
                                      sortDir === "asc"
                                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                        : "border-slate-200 bg-white text-slate-600")
                                    }
                                  >
                                    A → Z
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (
                                        sortBy === "memoType" &&
                                        sortDir === "desc"
                                      ) {
                                        setSortBy(null);
                                        setSortDir(null);
                                      } else {
                                        setSortBy("memoType");
                                        setSortDir("desc");
                                      }
                                    }}
                                    className={
                                      "flex-1 rounded-lg border px-2 py-1 text-[11px] " +
                                      (sortBy === "memoType" &&
                                      sortDir === "desc"
                                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                        : "border-slate-200 bg-white text-slate-600")
                                    }
                                  >
                                    Z → A
                                  </button>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  clearColumnFilter("memoType");
                                  setActiveFilter(null);
                                }}
                                className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                              >
                                ×
                              </button>
                            </div>

                            <div className="mt-2">
                              <div className="text-[11px] font-semibold text-slate-700">
                                {t("filter.filtersTitle", "Filters")}
                              </div>
                              <input
                                type="text"
                                value={memoTypeFilter}
                                onChange={(e) =>
                                  setMemoTypeFilter(e.target.value)
                                }
                                placeholder={t(
                                  "filter.memoType",
                                  "Type to search Memo Type"
                                )}
                                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                              />
                            </div>

                            <div className="mt-3 flex justify-between">
                              <button
                                type="button"
                                onClick={() => setActiveFilter(null)}
                                className="rounded-md border border-slate-200 px-3 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                              >
                                {t("filter.close", "Close")}
                              </button>
                              <button
                                type="button"
                                onClick={() => setActiveFilter(null)}
                                className="rounded-md bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700"
                              >
                                {t("filter.apply", "Apply")}
                              </button>
                            </div>
                          </div>
                        )}
                      </th>

                      {/* Levels / Approvers header */}
                      <th className="relative px-4 py-2 text-left font-semibold w-1/2">
                        <div className="flex items-center gap-1">
                          <span>{t("table.levels", "Levels / Approvers")}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setActiveFilter((prev) =>
                                prev === "approver" ? null : "approver"
                              )
                            }
                            className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-emerald-500 bg-white text-emerald-600 hover:bg-emerald-50"
                          >
                            <FiFilter className="h-3 w-3" />
                          </button>
                        </div>

                        {activeFilter === "approver" && (
                          <div className="absolute left-0 top-full  mt-1 w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
                            <div className="flex items-start justify-between mb-2">
                              <div>
                                <div className="text-[11px] font-semibold text-slate-700">
                                  {t("filter.sortTitle", "Sort")}
                                </div>
                                <div className="mt-1 flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (
                                        sortBy === "approver" &&
                                        sortDir === "asc"
                                      ) {
                                        setSortBy(null);
                                        setSortDir(null);
                                      } else {
                                        setSortBy("approver");
                                        setSortDir("asc");
                                      }
                                    }}
                                    className={
                                      "flex-1 rounded-lg border px-2 py-1 text-[11px] " +
                                      (sortBy === "approver" &&
                                      sortDir === "asc"
                                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                        : "border-slate-200 bg-white text-slate-600")
                                    }
                                  >
                                    A → Z
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (
                                        sortBy === "approver" &&
                                        sortDir === "desc"
                                      ) {
                                        setSortBy(null);
                                        setSortDir(null);
                                      } else {
                                        setSortBy("approver");
                                        setSortDir("desc");
                                      }
                                    }}
                                    className={
                                      "flex-1 rounded-lg border px-2 py-1 text-[11px] " +
                                      (sortBy === "approver" &&
                                      sortDir === "desc"
                                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                        : "border-slate-200 bg-white text-slate-600")
                                    }
                                  >
                                    Z → A
                                  </button>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  clearColumnFilter("approver");
                                  setActiveFilter(null);
                                }}
                                className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                              >
                                ×
                              </button>
                            </div>

                            <div className="mt-2">
                              <div className="text-[11px] font-semibold text-slate-700">
                                {t("filter.filtersTitle", "Filters")}
                              </div>
                              <input
                                type="text"
                                value={approverFilter}
                                onChange={(e) =>
                                  setApproverFilter(e.target.value)
                                }
                                placeholder={t(
                                  "filter.approver",
                                  "Type to search approver name"
                                )}
                                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                              />
                            </div>

                            <div className="mt-3 flex justify-between">
                              <button
                                type="button"
                                onClick={() => setActiveFilter(null)}
                                className="rounded-md border border-slate-200 px-3 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                              >
                                {t("filter.close", "Close")}
                              </button>
                              <button
                                type="button"
                                onClick={() => setActiveFilter(null)}
                                className="rounded-md bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700"
                              >
                                {t("filter.apply", "Apply")}
                              </button>
                            </div>
                          </div>
                        )}
                      </th>
                    </tr>
                  </thead>

<tbody className="divide-y divide-slate-100">
  {filteredLines.length === 0 ? (
    <tr>
      <td
        colSpan={4}
        className="px-4 py-4 text-center text-[11px] text-slate-400"
      >
        {t(
          "table.noFilteredResult",
          "ไม่พบ Line ตามเงื่อนไขการกรอง"
        )}
      </td>
    </tr>
  ) : (
    paginatedLines.map((line, idx) => {
      const lineLabel =
        line.lineName && line.lineName.trim().length > 0
          ? line.lineName
          : `Line #${line.lineOfApprovalId}`;

      const isChecked = selectedLineIds.includes(
        line.lineOfApprovalId
      );

      const hasTarget =
        line.slots?.some((s) => s.isTarget) ?? false;

      const rowBg =
        idx % 2 === 0
          ? hasTarget
            ? "bg-emerald-50/70"
            : "bg-white"
          : hasTarget
          ? "bg-emerald-50/90"
          : "bg-slate-50/80";

      // เรียง slot ตาม level
      const sortedSlots = (line.slots ?? [])
        .slice()
        .sort((a, b) => a.level - b.level);

      return (
        <tr key={line.lineOfApprovalId} className={rowBg}>
          {/* checkbox ต่อ 1 line */}
          <td className="px-4 py-2 align-middle w-10">
            <input
              type="checkbox"
              className="rounded border-gray-300"
              checked={isChecked}
              onChange={() =>
                toggleLine(line.lineOfApprovalId)
              }
              disabled={!fromUser}
            />
          </td>

          {/* Line name */}
          <td className="px-4 py-2 align-middle w-1/4">
            <div className="flex flex-col">
              <span className="font-semibold text-gray-800">
                {lineLabel}
              </span>
              <span className="text-[11px] text-gray-400">
                ID: {line.lineOfApprovalId}
              </span>
              {(line.businessUnitName ||
                line.departmentName) && (
                <span className="mt-0.5 text-[11px] text-gray-500">
                  {line.businessUnitName && (
                    <span>BU: {line.businessUnitName}</span>
                  )}
                  {line.businessUnitName &&
                    line.departmentName &&
                    " · "}
                  {line.departmentName && (
                    <span>Dept: {line.departmentName}</span>
                  )}
                </span>
              )}
            </div>
          </td>

          {/* Memo Type */}
          <td className="px-4 py-2 align-middle w-1/4">
            {line.memoTypeAbbr || line.memoTypeName ? (
              <span className="inline-flex items-center  text-[11px] font-medium  text-slate-700">
                {line.memoTypeAbbr && (
                  <span className="mr-1">
                    {line.memoTypeAbbr}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-gray-400">-</span>
            )}
          </td>

          {/* Levels + approvers ทั้งหมดใน line นี้ */}
          <td className="px-4 py-2 align-middle w-1/2">
            {sortedSlots.length === 0 ? (
              <span className="text-[11px] text-slate-400">
                {t(
                  "table.noSlots",
                  "ยังไม่ได้กำหนดผู้อนุมัติ"
                )}
              </span>
            ) : (
              <div className="max-w-full overflow-x-auto">
                <div className="flex flex-nowrap gap-1 py-0.5">
                  {sortedSlots.map((slot) => {
                    const isFlexible =
                      slot.slotType === "FLEXIBLE_SLOT";

                    return (
                      <span
                        key={`${slot.level}-${
                          slot.userId ?? `slot-${slot.level}`
                        }`}
                        className={
                          "shrink-0 whitespace-nowrap inline-flex items-center rounded-full px-3 py-[3px] text-[11px] font-semibold " +
                          (slot.isTarget
                            ? "bg-emerald-600 text-white"
                            : "bg-slate-200 text-slate-700")
                        }
                      >
                        L{slot.level + 1}
                        {slot.userName && (
                          <span className="ml-1 font-normal">
                            · {slot.userName}
                          </span>
                        )}
                        {!slot.userName && isFlexible && (
                          <span className="ml-1 font-normal text-[10px] opacity-80">
                            ·{" "}
                            {t(
                              "table.flexibleSlot",
                              "FLEXIBLE_SLOT"
                            )}
                          </span>
                        )}
                        {!slot.userName && !isFlexible && (
                          <span className="ml-1 font-normal text-[10px] opacity-70">
                            · {t("table.emptySlot", "ว่าง")}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </td>
        </tr>
      );
    })
  )}
</tbody>


                </table>
              </div>

              <div className="px-4 py-2 text-center text-[11px] text-slate-400 border-t border-slate-100">
                {fromUser
                  ? t(
                      "fromUser.tableFooter",
                      "แต่ละแถวคือ 1 line แสดงทุก level / ผู้อนุมัติใน line นั้น — badge สีเขียวคือคนที่กำลังจะถูกแทนที่"
                    )
                  : t(
                      "allLines.tableFooter",
                      "แสดงทุก line ผู้มีอำนาจอนุมัติในระบบ — เลือกผู้อนุมัติด้านบนเพื่อกรองเฉพาะของคนนั้น"
                    )}
              </div>
            </div>
          )}

          {/* ถ้าไม่มี fromUser ไม่ต้องโชว์ warning เรื่องยังไม่เลือก line */}
          {fromUser &&
            fromUserLines.length > 0 &&
            selectedLineIds.length === 0 && (
              <p className="mt-2 text-[11px] text-amber-700">
                {t(
                  "fromUser.noLineSelectedWarning",
                  "คุณยังไม่ได้เลือก line ใดเลย หากต้องการเปลี่ยนผู้มีอำนาจอนุมัติ กรุณาเลือกอย่างน้อยหนึ่ง line"
                )}
              </p>
            )}
        </div>

        {/* ปุ่มยืนยัน */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleApply}
            disabled={applying}
            className="px-4 py-2 rounded-[14px] bg-[#183e33] text-white text-sm font-semibold hover:bg-[#141716] disabled:opacity-40"
          >
            {applying
              ? t("btn.applyBusy", "กำลังเปลี่ยนจริง…")
              : t("btn.applySimple", "ยืนยันเปลี่ยนผู้อนุมัติ")}
          </button>
        </div>

        {/* ผลลัพธ์ (optional) */}
        {result && (
          <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="font-semibold text-emerald-800 mb-2">
              {t("result.titleApply", "ผลการเปลี่ยนจริง")}
            </div>

            {result.error && (
              <p className="text-sm text-red-600 mb-2">{result.error}</p>
            )}

            {result.fromUser && result.toUser && (
              <p className="text-sm text-gray-700 mb-3">
                {t("result.summary", "จาก")}{" "}
                <span className="font-semibold">
                  {result.fromUser.name} (ID {result.fromUser.id})
                </span>{" "}
                {t("result.to", "→ เป็น")}{" "}
                <span className="font-semibold">
                  {result.toUser.name} (ID {result.toUser.id})
                </span>
              </p>
            )}

            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg bg-white border border-gray-200 px-3 py-2">
                <div className="text-gray-500">
                  {t("result.templatePivots", "จุดใน Template / Line pivots")}
                </div>
                <div className="mt-1 text-lg font-semibold text-emerald-800">
                  {result.templatePivotsChanged}
                  {result.templatePivotsDeletedAsDup > 0 && (
                    <span className="ml-1 text-xs text-gray-500">
                      {t("result.deletedDup", {
                        defaultValue: "(ลบซ้ำ {{n}} จุด)",
                        n: result.templatePivotsDeletedAsDup,
                      })}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {!result.error &&
              result.templatePivotsChanged === 0 &&
              result.templatePivotsDeletedAsDup === 0 &&
              result.ccMembersChanged === 0 &&
              result.memoApproversChanged === 0 && (
                <p className="mt-3 text-xs text-gray-500">
                  {t(
                    "result.noImpact",
                    "ไม่มีรายการที่เข้าเงื่อนไขในระบบตามที่เลือก"
                  )}
                </p>
              )}
          </div>
        )}
      </div>
      <AdminLogModal
        isOpen={showLogModal}
        onClose={() => setShowLogModal(false)}
        module="LOA"
        title="Approver Management Log"
      />
    </div>
  );
};

/* -------- helper components -------- */

export default ApproverAdminPage;
