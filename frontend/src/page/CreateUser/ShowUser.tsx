import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import {
  BiSolidChevronUp,
  BiSolidChevronDown,
  BiChevronDown,
} from "react-icons/bi";
// @ts-ignore - Adding ts-ignore to prevent missing module error for @headlessui/react
import { Listbox } from "@headlessui/react";
import toast from "react-hot-toast";
import { api, BASE_URL } from "../../lib/api";
import { toSecureUploadUrl } from "../../lib/files";
import { FaEye, FaEyeSlash } from "react-icons/fa6";
import { BiDownload } from "react-icons/bi";
import { saveAs } from "file-saver";
import AdminLogModal from "../../components/AdminLogModal";

/* ---------- Types ---------- */
interface User {
  id: number;
  name: string;
  lastname?: string | null;
  nickname?: string | null;
  email: string;
  password: string;
  role: string;
  businessUnitId: number | null;
  departmentId: number | null;

  profileImage: string | null;
  profileImageUrl?: string | null;
  profileImagePath?: string | null;

  businessUnit?: { id: number; name: string };
  department?: { id: number; name: string; description?: string };
  deletedAt?: string | null;
  businessUnitAccess?: Array<{
    id: number;
    businessUnitId: number;
    businessUnit: { id: number; name: string; abbreviation?: string | null };
  }>;
}

const initialFormState = {
  name: "",
  lastname: "",
  nickname: "",
  email: "",
  password: "",
  role: "",
  businessUnitId: "" as number | "",
  departmentId: "" as number | "",
  profileImage: null as string | null,
  additionalBusinessUnitIds: [] as number[],
  dccManagementBusinessUnitIds: [] as number[],
};

// เพิ่มค่า 0 = All
const PAGE_SIZE_OPTIONS = [
  ...Array.from({ length: 6 }, (_, i) => 50 + i * 10),
  0, // <= All
];

// ---- role helpers ----
function normalizeRole(raw?: string | null) {
  let s = (raw ?? "").trim();

  // ตัด prefix รูปแบบที่พบได้ทั่วไป: "Role.", "roles.", "ROLE_", "role-", "roles_"
  s = s.replace(/^roles?[._-\s]*/i, ""); // ตัด role./roles./role-/roles-...
  s = s.replace(/^ROLE[_-\s]*/i, ""); // ตัด ROLE_, ROLE-, ...

  s = s.trim();
  const low = s.toLowerCase();

  // map ชื่อที่พบบ่อยให้เป็นเซ็ตมาตรฐาน
  if (["administrator", "admins", "admin"].includes(low)) return "admin";
  if (["mgr", "manager"].includes(low)) return "manager";
  if (["dcc"].includes(low)) return "dcc";
  if (["user", "member", "staff", "employee"].includes(low)) return "user";

  return low; // ถ้าไม่เข้าเคสข้างบน ให้คืนเป็น lower-case
}

function prettyRole(r: string) {
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : "-";
}
const EMAIL_ASCII_LOWER = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const HAS_NON_ASCII = /[^\x00-\x7F]/;
const HAS_UPPER = /[A-Z]/;

function sanitizeEmail(raw: string) {
  let v = raw.replace(/\s+/g, ""); // ตัดช่องว่าง
  const hints: string[] = [];
  if (HAS_NON_ASCII.test(v)) {
    v = v.replace(HAS_NON_ASCII, "");
    hints.push("ลบอักขระที่ไม่ใช่อังกฤษ/ตัวเลขออกแล้ว");
  }
  if (HAS_UPPER.test(v)) {
    v = v.toLowerCase();
    hints.push("แปลงเป็นตัวพิมพ์เล็กแล้ว");
  }
  return { value: v, hint: hints.join(" • ") || null };
}

const ShowUsers: React.FC = () => {
  const [sortAsc, setSortAsc] = useState(true);
  const [users, setUsers] = useState<User[]>([]);
  const [editedUserIds, setEditedUserIds] = useState<Set<number>>(new Set());
  const [archivedUsers, setArchivedUsers] = useState<User[]>([]);
  const [activeTab, setActiveTab] = useState<"active" | "archived">("active");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailTaken, setEmailTaken] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newUserForm, setNewUserForm] =
    useState<typeof initialFormState>(initialFormState);
  const [showPwd, setShowPwd] = useState(false);

  type IdName = { id: number; name: string };
  const [businessUnits, setBusinessUnits] = useState<IdName[]>([]);
  const [departments, setDepartments] = useState<IdName[]>([]);

  // Excel-style column filters - Multi-select
  type ColumnKey = "role" | "department" | "businessUnit";
  const [roleFilterIds, setRoleFilterIds] = useState<string[]>([]);
  const [businessUnitFilterIds, setBusinessUnitFilterIds] = useState<string[]>([]);
  const [departmentFilterIds, setDepartmentFilterIds] = useState<string[]>([]);
  const [openFilterDropdown, setOpenFilterDropdown] = useState<ColumnKey | null>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);
  const roleDropdownRef = useRef<HTMLDivElement>(null);
  const buDropdownRef = useRef<HTMLDivElement>(null);
  const deptDropdownRef = useRef<HTMLDivElement>(null);

  // Reset department filter when BU filter changes
  useEffect(() => {
    if (businessUnitFilterIds.length > 0) {
      setDepartmentFilterIds([]);
    }
  }, [businessUnitFilterIds]);

  const [editUserId, setEditUserId] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const { t } = useTranslation("users");
  const [showLogModal, setShowLogModal] = useState(false);
  const [selectedUserForLog, setSelectedUserForLog] = useState<number | null>(null);
  const [showForceResetModal, setShowForceResetModal] = useState(false);
  const [userToForceReset, setUserToForceReset] = useState<{ id: number; name: string } | null>(null);
  const [isFirstLoginToggle, setIsFirstLoginToggle] = useState(false);

  type MissingMap = Partial<Record<keyof typeof initialFormState, boolean>>;
  const [missingKeys, setMissingKeys] = useState<MissingMap>({});

  function getAvatarUrl(u: User): string | null {
    let raw: string | null =
      (u.profileImageUrl as any) ??
      (u.profileImagePath as any) ??
      (u.profileImage as any) ??
      null;

    if (!raw) return null;
    raw = raw.replace(/\\/g, "/");

    if (raw.startsWith("data:image/")) return raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith("/uploads/")) return toSecureUploadUrl(raw)!;

    const path = raw.startsWith("profiles/") ? raw : `profiles/${raw}`;
    return toSecureUploadUrl(`/uploads/${path}`);
  }
  function makePageWindow(current: number, total: number, sibling = 1) {
    const totalNumbers = sibling * 2 + 5; // first,last,current,2*siblings + 2 ellipses
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

  const REQUIRED_FIELDS_BASE: Array<{
    key: keyof typeof initialFormState;
    label: string;
  }> = [
    { key: "name", label: t("form.name") },
    { key: "email", label: t("form.email") },
    { key: "role", label: t("form.role") },
    { key: "businessUnitId", label: t("form.businessUnit") },
    { key: "departmentId", label: t("form.department") },
  ];

  const validateForm = () => {
    // Password is only required when creating a new user (not editing)
    const requiredFields = editUserId
      ? REQUIRED_FIELDS_BASE
      : [...REQUIRED_FIELDS_BASE, { key: "password" as keyof typeof initialFormState, label: t("form.password") }];

    const missing = requiredFields.filter((f) => {
      const v = newUserForm[f.key] as unknown;
      if (typeof v === "string") return v.trim() === "";
      return v === "" || v === 0 || v == null;
    });

    if (missing.length > 0) {
      setMissingKeys(
        missing.reduce<MissingMap>(
          (acc, cur) => ({ ...acc, [cur.key]: true }),
          {}
        )
      );
      toast.error(
        `${t("errors.missing") || "กรุณากรอก"}: ${missing
          .map((m) => m.label)
          .join(", ")}`
      );
      return false;
    }
    setMissingKeys({});
    return true;
  };

  /* ---------- Derived ---------- */
  // Get current list based on active tab
  const currentUserList = activeTab === "active" ? users : archivedUsers;

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

  // Close role dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (roleDropdownRef.current && !roleDropdownRef.current.contains(event.target as Node)) {
        if (openFilterDropdown === "role") setOpenFilterDropdown(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openFilterDropdown]);

  // Close BU dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (buDropdownRef.current && !buDropdownRef.current.contains(event.target as Node)) {
        if (openFilterDropdown === "businessUnit") setOpenFilterDropdown(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openFilterDropdown]);

  // Close Dept dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (deptDropdownRef.current && !deptDropdownRef.current.contains(event.target as Node)) {
        if (openFilterDropdown === "department") setOpenFilterDropdown(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openFilterDropdown]);

  const clearAllFilters = () => {
    setRoleFilterIds([]);
    setBusinessUnitFilterIds([]);
    setDepartmentFilterIds([]);
    setSearchTerm("");
  };

  const hasActiveFilters = roleFilterIds.length > 0 || businessUnitFilterIds.length > 0 || departmentFilterIds.length > 0 || searchTerm !== "";

  // ค้นหาครอบคลุมทุกคอลัมน์ (id, ชื่อ, อีเมล, role, department, businessUnit)
  const filteredUsers = useMemo(() => {
    let result = currentUserList;

    // Apply multi-select filters
    if (roleFilterIds.length > 0 || businessUnitFilterIds.length > 0 || departmentFilterIds.length > 0) {
      result = result.filter((u) => {
        const matchesRoleFilter =
          roleFilterIds.length === 0 ||
          roleFilterIds.includes(normalizeRole(u.role));
        
        const matchesDepartmentFilter =
          departmentFilterIds.length === 0 ||
          departmentFilterIds.includes(u.department?.name || "");
        
        const matchesBusinessUnitFilter =
          businessUnitFilterIds.length === 0 ||
          businessUnitFilterIds.includes(u.businessUnit?.name || "");

        return matchesRoleFilter && matchesDepartmentFilter && matchesBusinessUnitFilter;
      });
    }

    // Apply search term
    const q = searchTerm.trim().toLowerCase();
    if (q) {
      result = result.filter((u) => {
        const hay = [
          u.id,
          u.name,
          u.lastname ?? "",
          u.nickname ?? "",
          u.email,
          normalizeRole(u.role),
          u.department?.name ?? "",
          u.businessUnit?.name ?? "",
        ]
          .map((v) => String(v).toLowerCase())
          .join(" ");
        return hay.includes(q);
      });
    }

    return result;
  }, [currentUserList, searchTerm, roleFilterIds, businessUnitFilterIds, departmentFilterIds]);

  const editedOrderMap = useMemo(() => new Map(
    Array.from(editedUserIds).reverse().map((id, index) => [id, index])
  ), [editedUserIds]);

  const sortedUsers = useMemo(
    () =>
      [...filteredUsers].sort((a, b) => {
        // Float edited users to top first
        const indexA = editedOrderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const indexB = editedOrderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (indexA !== indexB) {
          return indexA - indexB;
        }

        return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      }),
    [filteredUsers, sortAsc, editedOrderMap]
  );

  // pageSize = 0 หมายถึง All
  const [pageSize, setPageSize] = useState(50);
  const pageSizeBeforeSearchRef = useRef<number>(50);

  // ✅ ถ้ามีคำค้น ให้ถือว่า All อัตโนมัติ
  const isSearching = searchTerm.trim().length > 0; // ใช้เพื่อโชว์ข้อความใน dropdown
  const isAll = pageSize === 0;
  const indexOfLastUser = isAll ? sortedUsers.length : currentPage * pageSize;
  const indexOfFirstUser = isAll ? 0 : indexOfLastUser - pageSize;
  const currentUsers = isAll
    ? sortedUsers
    : sortedUsers.slice(indexOfFirstUser, indexOfLastUser);
  const totalPages = isAll
    ? 1
    : Math.max(1, Math.ceil(sortedUsers.length / pageSize));
  const pagesToShow = useMemo(
    () => makePageWindow(currentPage, totalPages, 1),
    [currentPage, totalPages]
  );

  /* ⬇️ เพิ่มสอง useEffect ใต้บรรทัดนี้ */
  useEffect(() => {
    // พิมพ์ค้นหาเมื่อไหร่ ให้เด้งกลับหน้า 1
    setCurrentPage(1);
  }, [searchTerm]);

  useEffect(() => {
    // ถ้าเปลี่ยนผลลัพธ์/ขนาดหน้า แล้ว currentPage หลุดช่วง ให้บีบกลับมาหน้าสุดท้ายที่มีจริง
    if (isAll) return;
    const lastPage = Math.max(1, Math.ceil(sortedUsers.length / pageSize));
    if (currentPage > lastPage) setCurrentPage(lastPage);
  }, [sortedUsers.length, pageSize, isAll, currentPage]);
  /* ⬆️ จบส่วนที่ต้องเพิ่ม */

  const handleFormChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;

    if (name === "email") {
      const { value: cleaned, hint } = sanitizeEmail(String(value));
      setNewUserForm((prev) => ({ ...prev, email: cleaned }));

      setEmailHint(hint);

      // ตรวจรูปแบบ (ถ้ามีค่า)
      if (cleaned && !EMAIL_ASCII_LOWER.test(cleaned)) {
        setEmailError(
          "รูปแบบอีเมลไม่ถูกต้อง (ใช้ a-z, 0-9 และ . _ % + - เท่านั้น)"
        );
      } else {
        setEmailError(null);
      }
      // อัปเดต missingKeys ด้วย (จะทำให้กรอบแดงทันทีเมื่อไม่ผ่าน)
      setMissingKeys((prev) => ({ ...prev, email: !!cleaned && !!emailError }));
      return;
    }

    // ค่าอื่น ๆ เหมือนเดิม
    setNewUserForm((prev) => ({
      ...prev,
      [name]: name.includes("Id") ? (value === "" ? "" : Number(value)) : value,
    }));
  };

  useEffect(() => {
    const controller = new AbortController();
    const email = newUserForm.email.trim();

    // เคลียร์สถานะถ้าไม่มีค่า
    if (!email) {
      setEmailTaken(false);
      setEmailBusy(false);
      return;
    }

    // ถ้า format ไม่ผ่าน → ไม่ต้องเช็คซ้ำ (ลด API calls)
    if (!EMAIL_ASCII_LOWER.test(email)) {
      setEmailTaken(false);
      return;
    }

    const tmo = setTimeout(async () => {
      try {
        setEmailBusy(true);
        const params = new URLSearchParams({
          email,
          ...(editUserId ? { excludeId: String(editUserId) } : {}),
        });
        const { data } = await api.get(
          `/api/users/check-email?${params.toString()}`,
          { signal: controller.signal as any }
        );
        setEmailTaken(!!data.exists);
        setMissingKeys((prev) => ({ ...prev, email: !!data.exists }));
      } catch {
        /* ignore */
      } finally {
        setEmailBusy(false);
      }
    }, 400);

    return () => {
      clearTimeout(tmo);
      controller.abort();
    };
  }, [newUserForm.email, editUserId]);

  const roleCount = useMemo(() => {
    return sortedUsers.reduce((acc, u) => {
      const r = normalizeRole(u.role);
      acc[r] = (acc[r] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }, [sortedUsers]);

  // Dynamic filter options based on current table data
  const availableRoles = useMemo(() => {
    const roles = new Set<string>();
    currentUserList.forEach((u) => {
      roles.add(normalizeRole(u.role));
    });
    return Array.from(roles).sort();
  }, [currentUserList]);

  const availableBUs = useMemo(() => {
    const bus = new Map<number, string>();
    currentUserList.forEach((u) => {
      if (u.businessUnit?.id && u.businessUnit?.name) {
        bus.set(u.businessUnit.id, u.businessUnit.name);
      }
    });
    return Array.from(bus.values()).sort((a, b) => a.localeCompare(b, "th-TH"));
  }, [currentUserList]);

  const availableDepts = useMemo(() => {
    const depts = new Map<number, string>();
    currentUserList.forEach((u) => {
      // Filter by selected BUs if any are selected
      const matchesBU =
        businessUnitFilterIds.length === 0 ||
        businessUnitFilterIds.includes(u.businessUnit?.name || "");

      if (matchesBU && u.department?.id && u.department?.name) {
        depts.set(u.department.id, u.department.name);
      }
    });
    return Array.from(depts.values()).sort((a, b) => a.localeCompare(b, "th-TH"));
  }, [currentUserList, businessUnitFilterIds]);

  /* ---------- Load initial ---------- */
  useEffect(() => {
    const fetchAllData = async () => {
      try {
        const [usersRes, archivedRes, buRes, deptRes] = await Promise.all([
          api.get("/api/users"),
          api.get("/api/users/archived"),
          api.get("/api/business-units"),
          api.get("/api/departments"),
        ]);

        setUsers(Array.isArray(usersRes.data) ? usersRes.data : []);
        setArchivedUsers(Array.isArray(archivedRes.data) ? archivedRes.data : []);

        const buArr: IdName[] = (Array.isArray(buRes.data) ? buRes.data : [])
          .filter((b: any) => b?.id && b?.name)
          .map((b: any) => ({ id: b.id, name: b.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setBusinessUnits(buArr);

        const deptArr: IdName[] = (
          Array.isArray(deptRes.data) ? deptRes.data : []
        )
          .filter((d: any) => d?.id && d?.name)
          .map((d: any) => ({ id: d.id, name: d.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setDepartments(deptArr);
      } catch (err) {
        console.error("❌ Error loading initial data:", err);
        setUsers([]);
        setArchivedUsers([]);
        setBusinessUnits([]);
        setDepartments([]);
      } finally {
        setLoading(false);
      }
    };

    fetchAllData();
  }, []);

  /* ---------- Email duplicate check ---------- */
  useEffect(() => {
    const controller = new AbortController();
    if (!newUserForm.email.trim()) {
      setEmailTaken(false);
      return;
    }
    const tmo = setTimeout(async () => {
      try {
        setEmailBusy(true);
        const params = new URLSearchParams({
          email: newUserForm.email,
          ...(editUserId ? { excludeId: String(editUserId) } : {}),
        });
        const { data } = await api.get(
          `/api/users/check-email?${params.toString()}`,
          { signal: controller.signal as any }
        );
        setEmailTaken(!!data.exists);
        setMissingKeys((prev: MissingMap) => ({
          ...prev,
          email: !!data.exists,
        }));
      } catch {
        /* ignore */
      } finally {
        setEmailBusy(false);
      }
    }, 400);

    return () => {
      clearTimeout(tmo);
      controller.abort();
    };
  }, [newUserForm.email, editUserId]);

  useEffect(() => {
    const q = searchTerm.trim();
    if (q) {
      // กำลังค้นหา → บังคับ All
      if (pageSize !== 0) {
        pageSizeBeforeSearchRef.current = pageSize; // จำค่าก่อนค้นหา
        setPageSize(0);
      }
      setCurrentPage(1);
    } else {
      // เคลียร์คำค้น → คืน pageSize เดิม
      if (pageSize === 0) {
        setPageSize(pageSizeBeforeSearchRef.current || 50);
        setCurrentPage(1);
      }
    }
    // ไม่ใส่ pageSize ใน deps เพื่อกัน loop
    // ไม่ใส่ pageSize ใน deps เพื่อกัน loop
  }, [searchTerm]);

  const exportToExcel = async () => {
    // 1. Determine data source and status label
    const isArchived = activeTab === "archived";
    const dataToExport = isArchived ? archivedUsers : users;
    const statusVal = isArchived ? "Archived" : "Active";

    if (!dataToExport || dataToExport.length === 0) {
      toast.error(t("errors.noDataExport") || "ไม่พบข้อมูลสำหรับดาวน์โหลด");
      return;
    }

    // 2. Prepare data for Excel
    // Header row
    const headers = [
      "ID",
      "Name",
      "Lastname",
      "Nickname",
      "Email",
      "Role",
      "Department",
      "Business Unit",
    ];

    if (isArchived) {
      headers.push("Archived Date");
    }
    headers.push("Status");

    // Data rows
    const rows = dataToExport.map((u) => {
      const r = normalizeRole(u.role);
      const roleLabel = t(`roles.${r}`, { defaultValue: prettyRole(r) });

      const rowData = [
        u.id,
        u.name || "",
        u.lastname || "",
        u.nickname || "",
        u.email || "",
        roleLabel || "",
        u.department?.name || "",
        u.businessUnit?.name || "",
      ];

      if (isArchived) {
        rowData.push(
          u.deletedAt ? new Date(u.deletedAt).toLocaleDateString() : ""
        );
      }
      rowData.push(statusVal);

      return rowData;
    });

    // Combine headers and rows
    const worksheetData = [headers, ...rows];

    // 3. Create workbook and worksheet
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`${statusVal} Users`);
    worksheet.addRows(worksheetData);

    worksheet.getRow(1).font = { bold: true };
    worksheet.columns.forEach((column, index) => {
      const maxLength = worksheetData.reduce((max, row) => {
        const cellValue = row[index];
        return Math.max(max, String(cellValue ?? "").length);
      }, headers[index]?.length ?? 10);
      column.width = Math.min(Math.max(maxLength + 2, 12), 40);
    });

    // 4. Generate Excel file
    const filename = `users_${activeTab}_${new Date()
      .toISOString()
      .slice(0, 10)}.xlsx`;
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    saveAs(blob, filename);

    // 5. Log admin action
    api
      .post("/api/admin-logs", {
        actionType: "Export Data",
        module: "USER",
        targetName: `${statusVal} User List (Excel)`,
        details: {
          tab: activeTab,
          count: dataToExport.length,
          filename: filename,
        },
      })
      .catch((err) => console.error("Failed to log export action:", err));
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  /* ---------- Render ---------- */
  return (
    <div className="p-6 w-full">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <h1 className="text-2xl font-bold text-[#183e33]">{t("title")}</h1>

        <div className="relative w-full md:w-1/2 lg:w-1/3">
          <input
            type="text"
            placeholder={t("searchPlaceholder")}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 [border-radius:15px] focus:outline-none focus:ring-2 focus:ring-[#183e33]"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <svg
            className="absolute left-3 top-2.5 h-5 w-5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            ></path>
          </svg>
        </div>

        <hr className="border-t border-gray-300" />

        <div className="flex items-center gap-3">
          <PageSizeSelect
            pageSize={pageSize}
            setPageSize={(n) => {
              setPageSize(n);
              setCurrentPage(1);
            }}
            isSearching={isSearching}
          />

          {activeTab === "active" && (
            <button
              onClick={() => {
                setNewUserForm(initialFormState);
                setSelectedImage(null);
                setImagePreviewUrl(null);
                setEditUserId(null);
                setIsModalOpen(true);
              }}
              className="bg-[#183e33] text-white px-4 py-2 [border-radius:15px] hover:bg-[#141716] cursor-pointer"
            >
              + {t("createNew")}
            </button>
          )}

          <button
            onClick={() => setShowLogModal(true)}
            className="bg-gray-600 text-white px-4 py-2 [border-radius:15px] hover:bg-gray-700 cursor-pointer"
          >
            {t("viewLog")}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => {
              setActiveTab("active");
              setCurrentPage(1);
              setSearchTerm("");
            }}
            className={`${
              activeTab === "active"
                ? "border-[#183e33] text-[#183e33]"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors`}
          >
            {t("tabs.active")} ({users.length})
          </button>
          <button
            onClick={() => {
              setActiveTab("archived");
              setCurrentPage(1);
              setSearchTerm("");
            }}
            className={`${
              activeTab === "archived"
                ? "border-[#183e33] text-[#183e33]"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors`}
          >
            {t("tabs.archived")} ({archivedUsers.length})
          </button>
        </nav>
      </div>

      {/* Stats and CSV Download Row */}
      <div className="flex justify-between items-center mb-4">
        <div className="space-x-4 text-sm text-gray-600">
          <span>
            Admin: <b className="text-gray-900">{roleCount["admin"] || 0}</b>
          </span>
          <span>
            Manager: <b className="text-gray-900">{roleCount["manager"] || 0}</b>
          </span>
          <span>
            User: <b className="text-gray-900">{roleCount["user"] || 0}</b>
          </span>
          <span>
            SuperUser: <b className="text-gray-900">{roleCount["superuser"] || 0}</b>
          </span>
          <span>
            DCC: <b className="text-gray-900">{roleCount["dcc"] || 0}</b>
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Clear All Filters Button */}
          {hasActiveFilters && (
            <button
              onClick={clearAllFilters}
              className="bg-red-100 text-red-700 px-3 py-2 [border-radius:15px] hover:bg-red-200 cursor-pointer flex items-center gap-2 text-sm border border-red-300"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Clear Filters
            </button>
          )}

          {/* Download CSV Button */}
          <button
            onClick={exportToExcel}
            className="bg-green-600 text-white px-4 py-2 [border-radius:15px] hover:bg-green-700 cursor-pointer flex items-center gap-2 shadow-sm transition-all transform hover:-translate-y-0.5"
          >
            <BiDownload className="w-5 h-5" />
            <span className="hidden sm:inline">{t("downloadExcel")}</span>
          </button>
        </div>
      </div>

      <div className="bg-white shadow-xl rounded-2xl overflow-hidden -mx-6 sm:mx-0">
        <div className="overflow-x-auto w-full">
          {sortedUsers.length > 0 && (
            <div className="mt-4 text-sm text-gray-600 space-y-1"></div>
          )}
          <table className="w-full table-fixed divide-y divide-[#8A8787]">
            <thead className="bg-gradient-to-r from-white text-[#000000] font-extrabold">
              <tr>
                <th className="w-1/4 px-3 py-3 text-left text-xs font-medium uppercase tracking-wider">
                  <span className="inline-flex items-center">
                    {t("col.name")}
                    <button
                      onClick={() => {
                        setSortAsc((prev) => !prev);
                        setCurrentPage(1);
                      }}
                      className="ml-1 w-4 h-4 flex items-center justify-center text-gray-600 hover:text-[#183e33]"
                      title={sortAsc ? "Z-A" : "A-Z"}
                    >
                      {sortAsc ? (
                        <BiSolidChevronUp size={14} />
                      ) : (
                        <BiSolidChevronDown size={14} />
                      )}
                    </button>
                  </span>
                </th>
                <th className="w-1/5 px-3 py-3 text-left text-xs font-medium uppercase tracking-wider">
                  {t("col.email")}
                </th>
                
                {/* Role Column with Filter */}
                <th className="w-1/8 px-2 py-3 text-left text-xs font-medium uppercase tracking-wider relative">
                  <div className="flex items-center justify-normal">
                    <span className="flex items-center gap-1">
                      {t("col.role")}
                      {roleFilterIds.length > 0 && (
                        <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                      )}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenFilterDropdown(openFilterDropdown === "role" ? null : "role");
                      }}
                      className="p-1 hover:bg-gray-200 rounded transition-colors"
                    >
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                  {openFilterDropdown === "role" && (
                    <div
                      ref={roleDropdownRef}
                      className="absolute top-full left-0 mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="p-2">
                        <label className="block text-xs text-gray-500 mb-1">Filter by Role:</label>
                        <div className="max-h-48 overflow-y-auto space-y-1">
                          {availableRoles.map((role) => (
                            <label
                              key={role}
                              className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 rounded cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={roleFilterIds.includes(role)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setRoleFilterIds([...roleFilterIds, role]);
                                  } else {
                                    setRoleFilterIds(roleFilterIds.filter((id) => id !== role));
                                  }
                                  setCurrentPage(1);
                                }}
                                className="w-4 h-4 text-[#183e33] border-gray-300 rounded focus:ring-[#183e33] pointer-events-none"
                              />
                              <span className="text-sm text-gray-700 capitalize">{role}</span>
                            </label>
                          ))}
                        </div>
                        {roleFilterIds.length > 0 && (
                          <button
                            onClick={() => {
                              setRoleFilterIds([]);
                              setCurrentPage(1);
                            }}
                            className="mt-2 w-full flex items-center justify-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded border border-red-200"
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
                
                {/* Business Unit Column with Filter - MOVED BEFORE DEPARTMENT */}
                <th className="w-1/6 px-2 py-3 text-left text-xs font-medium uppercase tracking-wider relative">
                  <div className="flex items-center justify-normal">
                    <span className="flex items-center gap-1">
                      {t("col.businessUnit")}
                      {businessUnitFilterIds.length > 0 && (
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
                      ref={buDropdownRef}
                      className="absolute top-full left-0 mt-1 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="p-2">
                        <label className="block text-xs text-gray-500 mb-1">Filter by Business Unit:</label>
                        <div className="max-h-64 overflow-y-auto space-y-1">
                          {availableBUs.map((buName) => (
                            <label
                              key={buName}
                              className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 rounded cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={businessUnitFilterIds.includes(buName)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setBusinessUnitFilterIds([...businessUnitFilterIds, buName]);
                                  } else {
                                    setBusinessUnitFilterIds(businessUnitFilterIds.filter((name) => name !== buName));
                                  }
                                  setCurrentPage(1);
                                }}
                                className="w-4 h-4 text-[#183e33] border-gray-300 rounded focus:ring-[#183e33] pointer-events-none"
                              />
                              <span className="text-sm text-gray-700">{buName}</span>
                            </label>
                          ))}
                        </div>
                        {businessUnitFilterIds.length > 0 && (
                          <button
                            onClick={() => {
                              setBusinessUnitFilterIds([]);
                              setCurrentPage(1);
                            }}
                            className="mt-2 w-full flex items-center justify-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded border border-red-200"
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
                
                {/* Department Column with Filter - FILTERED BY SELECTED BU */}
                <th className="w-1/6 px-2 py-3 text-left text-xs font-medium uppercase tracking-wider relative">
                  <div className="flex items-center justify-normal">
                    <span className="flex items-center gap-1">
                      {t("col.department")}
                      {departmentFilterIds.length > 0 && (
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
                      ref={deptDropdownRef}
                      className="absolute top-full left-0 mt-1 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="p-2">
                        <label className="block text-xs text-gray-500 mb-1">
                          {businessUnitFilterIds.length > 0
                            ? `Filter by Department (${businessUnitFilterIds.length} BU${businessUnitFilterIds.length > 1 ? 's' : ''} selected):`
                            : "Filter by Department:"}
                        </label>
                        {(() => {
                          // Filter departments based on selected BUs
                          const availableDeptsList = availableDepts;
                          
                          return availableDeptsList.length === 0 ? (
                            <div className="text-center py-3 px-2 bg-gray-50 rounded border border-gray-200">
                              <p className="text-xs text-gray-500 italic">
                                {businessUnitFilterIds.length > 0
                                  ? "No departments in selected BU(s)"
                                  : "Select a Business Unit first"}
                              </p>
                            </div>
                          ) : (
                            <>
                              <div className="max-h-64 overflow-y-auto space-y-1">
                                {availableDepts.map((deptName) => (
                                  <label
                                    key={deptName}
                                    className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 rounded cursor-pointer"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={departmentFilterIds.includes(deptName)}
                                      onChange={(e) => {
                                        if (e.target.checked) {
                                          setDepartmentFilterIds([...departmentFilterIds, deptName]);
                                        } else {
                                          setDepartmentFilterIds(departmentFilterIds.filter((name) => name !== deptName));
                                        }
                                        setCurrentPage(1);
                                      }}
                                      className="w-4 h-4 text-[#183e33] border-gray-300 rounded focus:ring-[#183e33] pointer-events-none"
                                    />
                                    <span className="text-sm text-gray-700">{deptName}</span>
                                  </label>
                                ))}
                              </div>
                              {departmentFilterIds.length > 0 && (
                                <button
                                  onClick={() => {
                                    setDepartmentFilterIds([]);
                                    setCurrentPage(1);
                                  }}
                                  className="mt-2 w-full flex items-center justify-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded border border-red-200"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                  Clear Filter
                                </button>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </th>
                
                {activeTab === "archived" && (
                  <th className="w-1/8 px-2 py-3 text-left text-xs font-medium uppercase tracking-wider">
                    {t("col.archivedAt")}
                  </th>
                )}
                <th className="w-1/8 px-2 py-3 text-center text-xs font-medium uppercase tracking-wider">
                  {t("col.actions")}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {currentUsers.length > 0 ? (
                currentUsers.map((user) => (
                  <tr
                    key={user.id}
                    className={`transition-colors ${
                      editedUserIds.has(user.id) ? "bg-green-50 hover:bg-green-100" : "hover:bg-gray-50"
                    }`}
                  >
                    <td className="px-3 py-3">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-8 w-8 rounded-full overflow-hidden border">
                          {(() => {
                            const url = getAvatarUrl(user);
                            return url ? (
                              <img
                                src={url}
                                alt={user.name}
                                className="h-full w-full object-cover"
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).src =
                                    "/img/default-avatar.png";
                                }}
                              />
                            ) : (
                              <div className="h-full w-full bg-blue-100 flex items-center justify-center">
                                <span className="text-blue-600 font-medium text-xs">
                                  {user.name.charAt(0).toUpperCase()}
                                </span>
                              </div>
                            );
                          })()}
                        </div>

                        <div className="ml-2 min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-900 truncate">
                            {[user.name, user.lastname]
                              .filter(Boolean)
                              .join(" ")}{" "}
                            {user.nickname ? (
                              <span className="text-gray-500 text-xs">
                                ({user.nickname})
                              </span>
                            ) : null}
                          </div>
                          <div className="text-xs text-gray-500">
                            ID: {user.id}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-3">
                      <div className="text-sm text-gray-900 truncate" title={user.email}>
                        {user.email}
                      </div>
                    </td>
                    <td className="px-2 py-3">
                      {(() => {
                        const r = normalizeRole(user.role); // 🟢
                        const cls =
                          r === "admin"
                            ? "bg-purple-100 text-purple-800"
                            : r === "manager"
                            ? "bg-green-100 text-green-800"
                            : r === "dcc"
                            ? "bg-amber-100 text-amber-800"
                            : r === "superuser"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-blue-100 text-blue-800";

                        // แปลตาม i18n ถ้ามี key => roles.admin / roles.manager / ...
                        const label = t(`roles.${r}`, {
                          defaultValue: prettyRole(r),
                        });

                        return (
                          <span
                            className={`px-1.5 py-0.5 inline-flex text-xs leading-4 font-semibold rounded-full ${cls}`}
                          >
                            {label}
                          </span>
                        );
                      })()}
                    </td>

                    <td className="px-2 py-3">
                      <div className="text-sm text-gray-900 truncate" title={user.businessUnit?.name || "-"}>
                        {user.businessUnit?.name || "-"}
                      </div>
                    </td>

                    <td className="px-2 py-3">
                      <div className="text-sm text-gray-900 truncate" title={user.department?.name || "-"}>
                        {user.department?.name || "-"}
                      </div>
                    </td>

                    {activeTab === "archived" && (
                      <td className="px-2 py-3">
                        <div className="text-sm text-gray-500 truncate">
                          {user.deletedAt
                            ? new Date(user.deletedAt).toLocaleDateString()
                            : "-"}
                        </div>
                      </td>
                    )}

                    <td className="px-2 py-3 text-center">
                      <div className="flex justify-center space-x-2">
                        {activeTab === "active" ? (
                          <>
                            <button
                              onClick={async () => {
                                try {
                                  const res = await api.get(`/api/users/${user.id}`);
                                  const userData = res.data;

                                  setSelectedImage(null);
                                  
                                  // Extract additional business unit IDs from businessUnitAccess
                                  // The API returns businessUnitAccess as an array of { id, businessUnitId, businessUnit: {...} }
                                  const primaryBuId = userData.businessUnit?.id ?? userData.businessUnitId;
                                  const additionalBUIds = (userData.businessUnitAccess || [])
                                    .map((access: any) => Number(access.businessUnitId))
                                    .filter((id: number) => !isNaN(id) && id !== primaryBuId);

                                  // Fetch DCC management access if user has DCC role
                                  let dccMgmtBUIds: number[] = [];
                                  const userRole = normalizeRole(userData.role ?? "");
                                  if (userRole === "dcc") {
                                    try {
                                      const dccRes = await api.get(`/api/users/${user.id}/dcc-management-access`);
                                      // API returns array of { businessUnitId, businessUnit: {...} }
                                      const accessData = dccRes.data || [];
                                      dccMgmtBUIds = accessData.map((access: any) => Number(access.businessUnitId)).filter((id: number) => !isNaN(id));
                                    } catch (err) {
                                      console.error("Failed to load DCC management access:", err);
                                    }
                                  }

                                  setNewUserForm({
                                    name: userData.name ?? "",
                                    lastname: userData.lastname ?? "",
                                    nickname: userData.nickname ?? "",
                                    email: userData.email ?? "",
                                    password: "",
                                    role: userRole,
                                    businessUnitId: userData.businessUnit?.id ?? userData.businessUnitId ?? "",
                                    departmentId: userData.department?.id ?? userData.departmentId ?? "",
                                    profileImage: userData.profileImage ?? null,
                                    additionalBusinessUnitIds: additionalBUIds,
                                    dccManagementBusinessUnitIds: dccMgmtBUIds,
                                  });

                                  setIsFirstLoginToggle(userData.isFirstLogin ?? false);
                                  setImagePreviewUrl(getAvatarUrl(userData as User));
                                  setIsModalOpen(true);
                                  setEditUserId(user.id);
                                } catch (err) {
                                  console.error("Failed to load user data:", err);
                                }
                              }}
                              className="text-blue-600 hover:text-blue-900 cursor-pointer text-xs px-2 py-1 rounded hover:bg-blue-50"
                              title={t("edit")}
                            >
                              Edit
                            </button>

                            <button
                              onClick={() => {
                                setSelectedUserForLog(user.id);
                                setShowLogModal(true);
                              }}
                              className="text-gray-600 hover:text-gray-900 cursor-pointer text-xs px-2 py-1 rounded hover:bg-gray-50"
                              title="View Log"
                            >
                              Log
                            </button>

                            <button
                              onClick={async () => {
                                if (
                                  confirm(t("confirmDelete", { name: user.name }))
                                ) {
                                  try {
                                    await api.delete(`/api/users/${user.id}`);
                                    const updated = users.filter(
                                      (u) => u.id !== user.id
                                    );
                                    setUsers(updated);
                                    toast.success(t("success.userArchived"));
                                  } catch (err) {
                                    if (axios.isAxiosError(err)) {
                                      console.error(
                                        "Failed to archive user:",
                                        err.response?.data || err.message
                                      );
                                      toast.error(t("errors.generic"));
                                    } else {
                                      console.error("Unknown error:", err);
                                      toast.error(t("errors.generic"));
                                    }
                                  }
                                }
                              }}
                              className="text-amber-600 hover:text-amber-900 cursor-pointer text-xs px-2 py-1 rounded hover:bg-amber-50"
                              title={t("delete")}
                            >
                              {t("delete")}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => {
                                setSelectedUserForLog(user.id);
                                setShowLogModal(true);
                              }}
                              className="text-gray-600 hover:text-gray-900 cursor-pointer text-xs px-2 py-1 rounded hover:bg-gray-50"
                              title="View Log"
                            >
                              Log
                            </button>

                            <button
                              onClick={async () => {
                                if (
                                  confirm(t("confirmRestore", { name: user.name }))
                                ) {
                                  try {
                                    await api.post(`/api/users/${user.id}/restore`);
                                    const updated = archivedUsers.filter(
                                      (u) => u.id !== user.id
                                    );
                                    setArchivedUsers(updated);
                                    // Refresh active users list
                                    const usersRes = await api.get("/api/users");
                                    setUsers(Array.isArray(usersRes.data) ? usersRes.data : []);
                                    toast.success(t("success.userRestored"));
                                  } catch (err) {
                                    if (axios.isAxiosError(err)) {
                                      console.error(
                                        "Failed to restore user:",
                                        err.response?.data || err.message
                                      );
                                      toast.error(t("errors.generic"));
                                    } else {
                                      console.error("Unknown error:", err);
                                      toast.error(t("errors.generic"));
                                    }
                                  }
                                }
                              }}
                              className="text-green-600 hover:text-green-900 cursor-pointer text-xs px-2 py-1 rounded hover:bg-green-50"
                              title={t("restore")}
                            >
                              {t("restore")}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={activeTab === "archived" ? 7 : 6}
                    className="px-6 py-4 text-center text-gray-500"
                  >
                    {searchTerm ? t("noMatch") : t("noData")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        {filteredUsers.length > 0 && (
          <div className="mt-4 text-sm text-gray-600">
            Showing {sortedUsers.length} of {currentUserList.length} {activeTab === "active" ? "active" : "archived"} users
          </div>
        )}
      </div>

      {/* pagination */}
      {!isAll && totalPages > 1 && (
        <div className="flex justify-center flex-wrap gap-2 mt-4">
          <button
            className="px-3 py-1 rounded border text-sm font-medium bg-white text-green-900 border-gray-300 disabled:opacity-40"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
          >
            Prev
          </button>

          {pagesToShow.map((p, idx) =>
            p === "..." ? (
              <span
                key={`dots-${idx}`}
                className="px-2 text-gray-500 select-none"
              >
                …
              </span>
            ) : (
              <button
                key={p}
                className={`px-3 py-1 rounded border text-sm font-medium ${
                  currentPage === p
                    ? "bg-[#183e33] text-white"
                    : "bg-white text-green-900 border-gray-300 hover:bg-gray-100"
                }`}
                onClick={() => setCurrentPage(p as number)}
              >
                {p}
              </button>
            )
          )}

          <button
            className="px-3 py-1 rounded border text-sm font-medium bg-white text-green-900 border-gray-300 disabled:opacity-40"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
          >
            Next
          </button>
        </div>
      )}

      {/* modal create/edit users */}
      {isModalOpen && (
        <div className="fixed inset-0 flex items-center justify-center z-50 bg-black/30 overflow-y-auto py-4">
          <div className="bg-white border border-[#183e33] rounded-xl shadow-2xl p-8 w-full max-w-2xl relative animate-fade-in drop-shadow-lg my-auto mx-4 max-h-[calc(100vh-2rem)] overflow-y-auto">
            <button
              className="absolute top-3 right-3 text-green-500 hover:text-red-500 text-xl font-bold cursor-pointer z-10"
              onClick={() => {
                setIsModalOpen(false);
                setNewUserForm(initialFormState);
                setSelectedImage(null);
                setImagePreviewUrl(null);
                setEditUserId(null);
                setIsFirstLoginToggle(false);
              }}
            >
              ✕
            </button>

            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-green-700">
                {editUserId ? t("modal.editTitle") : t("modal.createTitle")}
              </h2>
              
              {/* First-Time Login Toggle - Minimal design */}
              {editUserId && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">
                    {t("forcePasswordReset.button")}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const userName = [newUserForm.name, newUserForm.lastname].filter(Boolean).join(" ");
                      setUserToForceReset({ id: editUserId, name: userName });
                      setShowForceResetModal(true);
                    }}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 ${
                      isFirstLoginToggle ? 'bg-amber-500' : 'bg-gray-300'
                    }`}
                    role="switch"
                    aria-checked={isFirstLoginToggle}
                    title={isFirstLoginToggle ? "First-time login enabled" : "First-time login disabled"}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        isFirstLoginToggle ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              )}
            </div>

            <form className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("form.name")}
                </label>
                <input
                  type="text"
                  name="name"
                  placeholder={t("form.namePlaceholder")}
                  value={newUserForm.name}
                  onChange={handleFormChange}
                  className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2
                    ${
                      missingKeys.name
                        ? "border-red-500 focus:ring-red-300"
                        : "border-[#183e33] focus:ring-green-500"
                    }`}
                />
              </div>

              {/* Lastname */}
              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("form.lastname")}
                </label>
                <input
                  type="text"
                  name="lastname"
                  placeholder={t("form.lastnamePlaceholder")}
                  value={newUserForm.lastname}
                  onChange={handleFormChange}
                  className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 border-[#183e33] focus:ring-green-500"
                />
              </div>

              {/* Nickname */}
              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("form.nickname")}
                </label>
                <input
                  type="text"
                  name="nickname"
                  placeholder={t("form.nicknameplaceholder")}
                  value={newUserForm.nickname}
                  onChange={handleFormChange}
                  className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 border-[#183e33] focus:ring-green-500"
                />
              </div>

              {/* Email */}
              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("form.email")}
                </label>
                <div className="relative">
                  <input
                    type="email"
                    name="email"
                    placeholder={t("form.emailPlaceholder")}
                    value={newUserForm.email}
                    onChange={handleFormChange}
                    onBlur={(e) => {
                      const { value: cleaned, hint } = sanitizeEmail(
                        e.target.value.trim()
                      );
                      if (cleaned !== newUserForm.email) {
                        setNewUserForm((prev) => ({ ...prev, email: cleaned }));
                        setEmailHint(hint); // ถ้าอยากใช้ i18n hint ก็ map จาก code -> t("email.hintLowercased") / t("email.hintRemovedNonAscii")
                      }
                      setEmailError(
                        cleaned && !EMAIL_ASCII_LOWER.test(cleaned)
                          ? t("errors.invalidEmailAsciiLower")
                          : null
                      );
                    }}
                    autoComplete="email"
                    inputMode="email"
                    lang="en"
                    pattern="[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}"
                    title={t("email.patternTitle")}
                    className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2
    ${
      emailError || emailTaken || missingKeys.email
        ? "border-red-500 focus:ring-red-300"
        : "border-[#183e33] focus:ring-green-500"
    }`}
                  />

                  {emailBusy && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin"></div>
                    </div>
                  )}
                </div>
                {/* ✅ Hint/Errors */}
                {emailHint && !emailError && !emailTaken && (
                  <p className="text-amber-600 text-xs mt-1">{emailHint}</p>
                )}
                {emailError && (
                  <p className="text-red-500 text-xs mt-1">{emailError}</p>
                )}
                {emailTaken && !emailError && (
                  <p className="text-red-500 text-xs mt-1">
                    {t("errors.emailTaken") || "Email นี้ถูกใช้งานแล้ว"}
                  </p>
                )}
              </div>

              {/* Password */}
              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("form.password")}
                </label>

                <div className="relative">
                  <input
                    type={showPwd ? "text" : "password"}
                    name="password"
                    placeholder="••••••••"
                    value={newUserForm.password}
                    onChange={handleFormChange}
                    autoComplete="new-password"
                    className={`w-full px-3 py-2 pr-10 border rounded-md focus:outline-none focus:ring-2
        ${
          missingKeys.password
            ? "border-red-500 focus:ring-red-300"
            : "border-[#183e33] focus:ring-green-500"
        }`}
                  />

                  <button
                    type="button"
                    onClick={() => setShowPwd((v) => !v)}
                    onMouseDown={(e) => e.preventDefault()} // กันการเสียโฟกัส input
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-[#183e33] focus:outline-none"
                    aria-pressed={showPwd}
                    aria-label={
                      showPwd
                        ? t("form.hidePassword", {
                            defaultValue: "Hide password",
                          })
                        : t("form.showPassword", {
                            defaultValue: "Show password",
                          })
                    }
                    title={
                      showPwd
                        ? t("form.hidePassword", {
                            defaultValue: "Hide password",
                          })
                        : t("form.showPassword", {
                            defaultValue: "Show password",
                          })
                    }
                  >
                    {showPwd ? <FaEyeSlash /> : <FaEye />}
                  </button>
                </div>
              </div>

              {/* Role */}
              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("form.role")}
                </label>
                <select
                  name="role"
                  value={newUserForm.role}
                  onChange={handleFormChange}
                  className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 text-gray-700
                    ${
                      missingKeys.role
                        ? "border-red-500 focus:ring-red-300"
                        : "border-[#183e33] focus:ring-green-500"
                    }`}
                >
                  <option value="">{t("form.rolePlaceholder")}</option>
                  <option value="user">User</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                  <option value="superuser">Super User</option>
                  <option value="dcc">DCC</option>

                </select>
              </div>

              {/* Business Unit */}
              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("form.businessUnit")}
                </label>
                <select
                  name="businessUnitId"
                  value={newUserForm.businessUnitId}
                  onChange={handleFormChange}
                  className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 text-gray-700
      ${
        missingKeys.businessUnitId
          ? "border-red-500 focus:ring-red-300"
          : "border-[#183e33] focus:ring-green-500"
      }`}
                >
                  <option value="">{t("form.businessUnitPlaceholder")}</option>
                  {businessUnits.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Department (ไม่กรองตาม BU) */}
              <div>
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("form.department")}
                </label>
                <select
                  name="departmentId"
                  value={newUserForm.departmentId}
                  onChange={handleFormChange}
                  className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 text-gray-700
      ${
        missingKeys.departmentId
          ? "border-red-500 focus:ring-red-300"
          : "border-[#183e33] focus:ring-green-500"
      }`}
                >
                  <option value="">{t("form.departmentPlaceholder")}</option>
                  {departments.map((dept) => (
                    <option key={dept.id} value={dept.id}>
                      {dept.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Additional Business Units */}
              <div className="md:col-span-2">
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-semibold text-green-700">
                    {t("form.additionalBusinessUnits")}
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const availableBUIds = businessUnits
                          .filter((unit) => unit.id !== Number(newUserForm.businessUnitId))
                          .map((unit) => unit.id);
                        setNewUserForm((prev) => ({
                          ...prev,
                          additionalBusinessUnitIds: availableBUIds,
                        }));
                      }}
                      className="text-xs px-2 py-1 text-green-700 hover:bg-green-50 rounded border border-green-300"
                    >
                      {t("form.checkAll")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNewUserForm((prev) => ({
                          ...prev,
                          additionalBusinessUnitIds: [],
                        }));
                      }}
                      className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-50 rounded border border-gray-300"
                    >
                      {t("form.uncheckAll")}
                    </button>
                  </div>
                </div>
                <p className="text-xs text-gray-500 mb-2">
                  {t("form.additionalBusinessUnitsHelp")}
                </p>
                <div className="border border-[#183e33] rounded-md p-3 max-h-40 overflow-y-auto">
                  {businessUnits.length === 0 ? (
                    <p className="text-sm text-gray-500">No business units available</p>
                  ) : (
                    <div className="space-y-2">
                      {businessUnits
                        .filter((unit) => unit.id !== Number(newUserForm.businessUnitId))
                        .sort((a, b) => {
                          const aChecked = newUserForm.additionalBusinessUnitIds.includes(Number(a.id));
                          const bChecked = newUserForm.additionalBusinessUnitIds.includes(Number(b.id));
                          if (aChecked && !bChecked) return -1;
                          if (!aChecked && bChecked) return 1;
                          return a.name.localeCompare(b.name);
                        })
                        .map((unit) => (
                          <label
                            key={unit.id}
                            className="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 p-1 rounded"
                          >
                            <input
                              type="checkbox"
                              checked={newUserForm.additionalBusinessUnitIds.includes(Number(unit.id))}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setNewUserForm((prev) => ({
                                  ...prev,
                                  additionalBusinessUnitIds: checked
                                    ? [...prev.additionalBusinessUnitIds, unit.id]
                                    : prev.additionalBusinessUnitIds.filter((id) => id !== unit.id),
                                }));
                              }}
                              className="w-4 h-4 text-[#183e33] border-gray-300 rounded focus:ring-[#183e33]"
                            />
                            <span className="text-sm text-gray-700">{unit.name}</span>
                          </label>
                        ))}
                    </div>
                  )}
                </div>
                {newUserForm.additionalBusinessUnitIds.length > 0 && (
                  <p className="text-xs text-green-600 mt-1">
                    {newUserForm.additionalBusinessUnitIds.length} additional business unit(s) selected
                  </p>
                )}
              </div>

              {/* DCC Management Business Units - Only shown when role is DCC */}
              {newUserForm.role === "dcc" && (
                <div className="md:col-span-2">
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-semibold text-amber-700">
                      {t("form.dccManagementBusinessUnits")}
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const availableBUIds = businessUnits
                            .filter((unit) => unit.id !== Number(newUserForm.businessUnitId))
                            .map((unit) => unit.id);
                          setNewUserForm((prev) => ({
                            ...prev,
                            dccManagementBusinessUnitIds: availableBUIds,
                          }));
                        }}
                        className="text-xs px-2 py-1 text-amber-700 hover:bg-amber-50 rounded border border-amber-300"
                      >
                        {t("form.checkAll")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setNewUserForm((prev) => ({
                            ...prev,
                            dccManagementBusinessUnitIds: [],
                          }));
                        }}
                        className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-50 rounded border border-gray-300"
                      >
                        {t("form.uncheckAll")}
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">
                    {t("form.dccManagementBusinessUnitsHelp")}
                  </p>
                  <div className="border border-amber-500 rounded-md p-3 max-h-40 overflow-y-auto bg-amber-50">
                    {businessUnits.length === 0 ? (
                      <p className="text-sm text-gray-500">{t("form.noBusinessUnitsAvailable")}</p>
                    ) : (
                      <div className="space-y-2">
                        {businessUnits
                          .filter((unit) => unit.id !== Number(newUserForm.businessUnitId))
                          .sort((a, b) => {
                            const aChecked = newUserForm.dccManagementBusinessUnitIds.includes(Number(a.id));
                            const bChecked = newUserForm.dccManagementBusinessUnitIds.includes(Number(b.id));
                            if (aChecked && !bChecked) return -1;
                            if (!aChecked && bChecked) return 1;
                            return a.name.localeCompare(b.name);
                          })
                          .map((unit) => (
                            <label
                              key={unit.id}
                              className="flex items-center space-x-2 cursor-pointer hover:bg-amber-100 p-1 rounded"
                            >
                              <input
                                type="checkbox"
                                checked={newUserForm.dccManagementBusinessUnitIds.includes(Number(unit.id))}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setNewUserForm((prev) => ({
                                    ...prev,
                                    dccManagementBusinessUnitIds: checked
                                      ? [...prev.dccManagementBusinessUnitIds, unit.id]
                                      : prev.dccManagementBusinessUnitIds.filter((id) => id !== unit.id),
                                  }));
                                }}
                                className="w-4 h-4 text-amber-600 border-gray-300 rounded focus:ring-amber-500"
                              />
                              <span className="text-sm text-gray-700">{unit.name}</span>
                            </label>
                          ))}
                      </div>
                    )}
                  </div>
                  {newUserForm.dccManagementBusinessUnitIds.length > 0 && (
                    <p className="text-xs text-amber-600 mt-1">
                      {newUserForm.dccManagementBusinessUnitIds.length} {t("form.dccManagementBusinessUnitsSelected")}
                    </p>
                  )}
                </div>
              )}

              {/* Profile Image Upload */}
              <div className="md:col-span-2">
                <label className="block text-sm font-semibold text-green-700 mb-1">
                  {t("form.avatar")}
                </label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setSelectedImage(file);
                      setImagePreviewUrl(URL.createObjectURL(file));
                    }
                  }}
                  className="block w-full text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:font-semibold file:bg-green-100 file:text-[#183e33] hover:file:bg-[#183e33]"
                />

                <div className="mt-4 flex justify-center">
                  {imagePreviewUrl ? (
                    <img
                      src={imagePreviewUrl}
                      alt="Preview"
                      className="h-32 w-32 rounded-full object-cover border"
                    />
                  ) : newUserForm.profileImage ? (
                    <img
                      src={`data:image/jpeg;base64,${newUserForm.profileImage}`}
                      alt="Current"
                      className="h-32 w-32 rounded-full object-cover border"
                    />
                  ) : (
                    <div className="h-32 w-32 rounded-full bg-gray-100 border flex items-center justify-center text-gray-400">
                      No Image
                    </div>
                  )}
                </div>
              </div>

              {/* Submit */}
              <div className="col-span-1 md:col-span-2 mt-4">
                <button
                  type="button"
                  onClick={async () => {
                    if (!validateForm()) return;
                    const email = newUserForm.email.trim();
                    if (!email.includes("@")) {
                      toast.error(
                        t("errors.invalidEmail") || "Invalid email format"
                      );
                      setMissingKeys((prev: MissingMap) => ({
                        ...prev,
                        email: true,
                      }));
                      return;
                    }
                    if (emailTaken) {
                      toast.error(
                        t("errors.emailTaken") || "Email already exists"
                      );
                      setMissingKeys((prev: MissingMap) => ({
                        ...prev,
                        email: true,
                      }));
                      return;
                    }

                    try {
                      const formData = new FormData();
                      Object.entries(newUserForm).forEach(([key, value]) => {
                        if (
                          value !== null &&
                          value !== undefined &&
                          key !== "profileImage" &&
                          key !== "additionalBusinessUnitIds" &&
                          key !== "dccManagementBusinessUnitIds"
                        ) {
                          formData.append(key, String(value));
                        }
                      });

                      let userRes;
                      if (editUserId) {
                        userRes = await api.put(
                          `/api/users/${editUserId}`,
                          formData
                        );
                        toast.success(
                          t("success.userUpdated") ||
                            "User updated successfully"
                        );
                      } else {
                        userRes = await api.post(`/api/users`, formData);
                        toast.success(
                          t("success.userCreated") ||
                            "User created successfully"
                        );
                      }
                      const savedUser: User = userRes.data;

                      // Float to top
                      if (savedUser && savedUser.id) {
                        setEditedUserIds((prev) => {
                          const newSet = new Set(prev);
                          newSet.delete(savedUser.id);
                          newSet.add(savedUser.id);
                          return newSet;
                        });
                      }

                      // upload image (optional)
                      let finalUser: User = savedUser;
                      if (selectedImage) {
                        const fd = new FormData();
                        fd.append("image", selectedImage);
                        const imgRes = await api.put(
                          `/api/users/${savedUser.id}/profile-image`,
                          fd
                        );
                        finalUser = imgRes.data;
                      }

                      // Update business unit access
                      if (newUserForm.additionalBusinessUnitIds.length > 0) {
                        await api.put(
                          `/api/users/${savedUser.id}/business-unit-access`,
                          { businessUnitIds: newUserForm.additionalBusinessUnitIds }
                        );
                      } else {
                        // Clear all additional access if none selected
                        await api.put(
                          `/api/users/${savedUser.id}/business-unit-access`,
                          { businessUnitIds: [] }
                        );
                      }

                      // Update DCC management access (only for DCC role)
                      if (newUserForm.role === "dcc") {
                        try {
                          await api.put(
                            `/api/users/${savedUser.id}/dcc-management-access`,
                            { businessUnitIds: newUserForm.dccManagementBusinessUnitIds }
                          );
                        } catch (dccErr) {
                          console.error("Failed to update DCC management access:", dccErr);
                          // Don't fail the whole operation, just log the error
                        }
                      } else {
                        // Clear DCC management access if role is not DCC
                        try {
                          await api.put(
                            `/api/users/${savedUser.id}/dcc-management-access`,
                            { businessUnitIds: [] }
                          );
                        } catch {
                          // Ignore errors when clearing - user might not have had DCC access
                        }
                      }

                      const updatedUsers = editUserId
                        ? users.map((u) =>
                            u.id === finalUser.id ? finalUser : u
                          )
                        : [...users, finalUser];
                      setUsers(updatedUsers);

                      setIsModalOpen(false);
                      setNewUserForm(initialFormState);
                      setSelectedImage(null);
                      setImagePreviewUrl(null);
                      setEditUserId(null);
                      setIsFirstLoginToggle(false);
                    } catch (error) {
                      console.error("Error submitting form:", error);
                      if (axios.isAxiosError(error)) {
                        const msg =
                          error.response?.data?.error ||
                          error.response?.data?.message ||
                          error.message ||
                          t("errors.generic") ||
                          "An error occurred";
                        toast.error(msg);
                      } else {
                        toast.error(t("errors.generic") || "An error occurred");
                      }
                    }
                  }}
                  className="w-full bg-[#183e33] hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-md transition duration-300 cursor-pointer"
                >
                  {editUserId ? t("modal.saveEdit") : t("modal.saveCreate")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin Log Modal */}
      <AdminLogModal
        isOpen={showLogModal}
        onClose={() => {
          setShowLogModal(false);
          setSelectedUserForLog(null);
        }}
        module="USER"
        title="User Management Log"
        targetId={selectedUserForLog}
      />

      {/* First-Time Login Toggle Confirmation Modal */}
      {showForceResetModal && userToForceReset && (
        <div className="fixed inset-0 flex items-center justify-center z-50 bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-bold text-amber-700 mb-4">
              {isFirstLoginToggle 
                ? t("forcePasswordReset.disableTitle") 
                : t("forcePasswordReset.confirmTitle")}
            </h3>
            <p className="text-gray-700 mb-6">
              {isFirstLoginToggle
                ? t("forcePasswordReset.disableMessage", { name: userToForceReset.name })
                : t("forcePasswordReset.confirmMessage", { name: userToForceReset.name })}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowForceResetModal(false);
                  setUserToForceReset(null);
                }}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md transition cursor-pointer"
              >
                {t("forcePasswordReset.cancel")}
              </button>
              <button
                onClick={async () => {
                  try {
                    if (isFirstLoginToggle) {
                      // Disable first-time login (set to false)
                      await api.post(`/api/users/${userToForceReset.id}/clear-first-login`);
                      toast.success(t("success.firstLoginCleared"));
                      setIsFirstLoginToggle(false);
                    } else {
                      // Enable first-time login (set to true)
                      await api.post(`/api/users/${userToForceReset.id}/force-password-reset`);
                      toast.success(t("success.passwordResetForced"));
                      setIsFirstLoginToggle(true);
                    }
                    setShowForceResetModal(false);
                    setUserToForceReset(null);
                  } catch (error) {
                    console.error("Error toggling first-time login:", error);
                    if (axios.isAxiosError(error)) {
                      const msg = error.response?.data?.error || error.message || t("errors.generic");
                      toast.error(msg);
                    } else {
                      toast.error(t("errors.generic"));
                    }
                  }
                }}
                className={`px-4 py-2 text-white rounded-md transition cursor-pointer ${
                  isFirstLoginToggle 
                    ? 'bg-gray-600 hover:bg-gray-700' 
                    : 'bg-amber-600 hover:bg-amber-700'
                }`}
              >
                {isFirstLoginToggle 
                  ? t("forcePasswordReset.disable") 
                  : t("forcePasswordReset.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* ───────── rows-per-page dropdown ───────── */
function PageSizeSelect({
  pageSize,
  setPageSize,
  isSearching,
}: {
  pageSize: number;
  setPageSize: (n: number) => void;
  isSearching: boolean;
}) {
  return (
    <Listbox value={pageSize} onChange={setPageSize}>
      <div className="relative w-24">
        <Listbox.Button className="w-full border border-gray-400 rounded-xl px-2 py-1 flex justify-between items-center">
          {isSearching || pageSize === 0 ? "All" : pageSize} <BiChevronDown />
        </Listbox.Button>

        <Listbox.Options className="absolute mt-1 w-full bg-white shadow-lg rounded-xl overflow-auto z-10">
          {PAGE_SIZE_OPTIONS.map((n) => (
            <Listbox.Option
              key={n}
              value={n}
              className={({ active, selected }) =>
                `cursor-pointer select-none px-2 py-1 ${
                  active ? "bg-[#183e33] text-white" : "text-gray-700"
                } ${selected ? "font-semibold" : ""}`
              }
            >
              {n === 0 ? "All" : n}
            </Listbox.Option>
          ))}
        </Listbox.Options>
      </div>
    </Listbox>
  );
}

export default ShowUsers;
