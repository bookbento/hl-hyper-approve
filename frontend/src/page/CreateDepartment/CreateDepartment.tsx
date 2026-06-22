import React, { useEffect, useState } from "react";
// ❌ ลบ axios ออก ไม่ต้องใช้แล้ว
// import axios from "axios";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPenToSquare, faTrash } from "@fortawesome/free-solid-svg-icons";
import { useTranslation } from "react-i18next";
import { Listbox } from "@headlessui/react";
import { BiChevronDown, BiSolidChevronUp, BiSolidChevronDown } from "react-icons/bi";
import toast from "react-hot-toast";

// ✅ ใช้ axios instance ที่ตั้งค่า withCredentials ไว้แล้ว
import { api } from "../../lib/api"; // ← ปรับ path ตามโปรเจกต์ของคุณ
import AdminLogModal from "../../components/AdminLogModal";

/* ───────── types ───────── */
interface BusinessUnit {
  id: number;
  name: string;
}

interface Department {
  id: number;
  name: string;
  abbreviation: string;
  businessUnitId?: number | null;
  businessUnit?: { id: number; name: string } | null;
}

/* ───────── constants ───────── */
const API = "/api/departments";
const PAGE_SIZE_OPTIONS = Array.from({ length: 10 }, (_, i) => (i + 1) * 10);

/* ───────── component ───────── */
const CreateDepartment: React.FC = () => {
  /* state */
  const { t } = useTranslation("createDepartment");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [archivedDepartments, setArchivedDepartments] = useState<Department[]>([]);
  const [activeTab, setActiveTab] = useState<"active" | "archived">("active");
  const [searchTerm, setSearchTerm] = useState("");
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [form, setForm] = useState({
    id: 0,
    name: "",
    abbreviation: "",
    businessUnitId: null as number | null,
  });

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [sortAsc, setSortAsc] = useState(true); // A-Z / Z-A
  const [loading, setLoading] = useState(true);
  const REQUIRED_FIELDS: Array<{ key: keyof typeof form; label: string }> = [
    { key: "name", label: t("form.name") },
    { key: "abbreviation", label: t("form.abbreviation") },
  ];

  const [missingKeys, setMissingKeys] = useState<Record<string, boolean>>({});
  const [businessUnits, setBusinessUnits] = useState<BusinessUnit[]>([]);
  const [showLogModal, setShowLogModal] = useState(false);

  useEffect(() => {
    api
      .get("/api/business-units")
      .then(({ data }) => setBusinessUnits(data))
      .catch((err) => {
        console.error("❌ Failed to fetch BUs:", err);
        toast.error(t("errors.fetchBU") || "โหลด Business Units ไม่สำเร็จ");
      });
  }, [t]);

  const validateRequiredOnly = () => {
    const missingItems = REQUIRED_FIELDS.filter((f) => !String(form[f.key]).trim());
    if (missingItems.length > 0) {
      setMissingKeys(missingItems.reduce((acc, cur) => ({ ...acc, [cur.key]: true }), {}));
      toast.error(
        `${t("errors.missing") || "กรุณากรอก"}: ${missingItems.map((m) => m.label).join(", ")}`
      );
      return false;
    }
    setMissingKeys({});
    return true;
  };

  /* fetch */
  const fetchDepartments = async () => {
    try {
      const [activeRes, archivedRes] = await Promise.all([
        api.get(API),
        api.get(`${API}/archived`),
      ]);
      setDepartments(activeRes.data);
      setArchivedDepartments(archivedRes.data);
    } catch (err: any) {
      console.error("❌ Failed to fetch departments:", err);
      if (err?.response?.status === 401) {
        toast.error(t("errors.unauthorized") || "กรุณาเข้าสู่ระบบใหม่");
      } else {
        toast.error(t("errors.fetchDept") || "โหลดข้อมูลแผนกไม่สำเร็จ");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDepartments();
  }, []);

  /* helpers */
  const currentDepartmentList = activeTab === "active" ? departments : archivedDepartments;

  const filtered = currentDepartmentList.filter((d) =>
    (d.name + d.abbreviation).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) =>
    sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
  );

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));

  /* modal handlers */
  const openModal = (mode: "create" | "edit", dept?: Department) => {
    if (mode === "edit" && dept) {
      setForm({
        id: dept.id,
        name: dept.name,
        abbreviation: dept.abbreviation,
        businessUnitId: dept.businessUnitId ?? dept.businessUnit?.id ?? null,
      });
    } else {
      setForm({ id: 0, name: "", abbreviation: "", businessUnitId: null });
    }
    setModalMode(mode);
  };
  const closeModal = () => setModalMode(null);

  /* form change */
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  /* submit */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateRequiredOnly()) return;
    try {
      const payload = {
        name: form.name,
        abbreviation: form.abbreviation,
        businessUnitId: form.businessUnitId,
      };

      if (modalMode === "create") {
        await api.post(API, payload);
        toast.success(t("toast.created") || "สร้างแผนกสำเร็จ");
      } else if (modalMode === "edit") {
        await api.put(`${API}/${form.id}`, payload);
        toast.success(t("toast.updated") || "อัปเดตแผนกสำเร็จ");
      }
      await fetchDepartments();
      closeModal();
    } catch (err: any) {
      console.error("❌ Failed to submit department:", err);
      if (err?.response?.status === 401) {
        toast.error(t("errors.unauthorized") || "ไม่ได้รับอนุญาต (401)");
      } else if (err?.response?.data?.error) {
        toast.error(err.response.data.error);
      } else {
        toast.error(t("errors.submitDept") || "บันทึกแผนกไม่สำเร็จ");
      }
    }
  };

  /* delete (archive) */
  const handleDelete = async (id: number) => {
    if (!window.confirm(t("confirm.delete") || "เก็บบันทึก (Archive) แผนกนี้หรือไม่?")) return;
    try {
      await api.delete(`${API}/${id}`);
      toast.success(t("toast.deleted") || "เก็บบันทึกแผนกสำเร็จ");
      fetchDepartments();
    } catch (err: any) {
      console.error("❌ Failed to delete department:", err);
      if (err?.response?.status === 401) {
        toast.error(t("errors.unauthorized") || "ไม่ได้รับอนุญาต (401)");
      } else {
        toast.error(t("errors.deleteDept") || "เก็บบันทึกแผนกไม่สำเร็จ");
      }
    }
  };

  /* restore */
  const handleRestore = async (id: number) => {
    if (!window.confirm("ต้องการกู้คืน (Restore) แผนกนี้หรือไม่?")) return;
    try {
      await api.put(`${API}/restore/${id}`);
      toast.success("กู้คืนแผนกสำเร็จ");
      fetchDepartments();
    } catch (err: any) {
      console.error("❌ Failed to restore department:", err);
      if (err?.response?.status === 401) {
        toast.error(t("errors.unauthorized") || "ไม่ได้รับอนุญาต (401)");
      } else {
        toast.error("กู้คืนแผนกไม่สำเร็จ");
      }
    }
  };

  /* UI */
  if (loading) return <p className="text-center mt-10 text-gray-500">Loading...</p>;

  return (
    <div className="p-6 w-full min-h-screen text-[#183e33]">
      {/* ─── Header + Search + Create ─── */}
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <div className="relative w-full md:w-1/2 lg:w-1/3">
            <input
              placeholder={t("searchPlaceholder")}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-[15px] focus:outline-none focus:ring-2 focus:ring-[#183e33]"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1); // reset page on search
              }}
            />
            <svg
              className="absolute left-3 top-2.5 h-5 w-5 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        <hr className="border-t border-gray-300" />

<div className="flex items-center justify-between">
  {/* Left */}
  <PageSizeSelect
    pageSize={pageSize}
    setPageSize={(n) => {
      setPageSize(n);
      setCurrentPage(1); // reset page on pageSize change
    }}
  />

  {/* Right */}
  <div className="flex items-center gap-3">
    {activeTab === "active" && (
      <button
        onClick={() => openModal("create")}
        className="bg-[#183e33] text-white px-4 py-2 rounded-[15px] hover:bg-[#141716]"
      >
        {t("button.create")}
      </button>
    )}

    <button
      onClick={() => setShowLogModal(true)}
      className="bg-gray-600 text-white px-4 py-2 rounded-[15px] hover:bg-gray-700"
    >
      {t("viewLog")}
    </button>
  </div>
</div>

      </div>

      {/* ─── Tabs ─── */}
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
            Active ({departments.length})
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
            Archived ({archivedDepartments.length})
          </button>
        </nav>
      </div>

      {/* ─── Table ─── */}
      <div className="bg-white shadow-xl rounded-2xl overflow-hidden -mx-6 sm:mx-0">
        <div className="overflow-x-auto w-full">
          <table className="min-w-full w-full table-auto divide-y divide-[#8A8787]">
            <thead className="bg-gradient-to-r from-white font-extrabold text-left">
              <tr>
                <th className="px-6 py-3 uppercase tracking-wider">{t("table.id")}</th>
                <th className="px-6 py-3 uppercase tracking-wider">
                  <span className="inline-flex items-center">
                    {t("table.name")}
                    <button
                      onClick={() => {
                        setSortAsc((a) => !a);
                        setCurrentPage(1); // reset page on sort
                      }}
                      title={sortAsc ? "Z-A" : "A-Z"}
                      className="ml-1 inline-flex items-center justify-center w-5 h-5 text-gray-500 hover:text-[#183e33]"
                    >
                      {sortAsc ? <BiSolidChevronUp size={16} /> : <BiSolidChevronDown size={16} />}
                    </button>
                  </span>
                </th>
                <th className="px-6 py-3 uppercase tracking-wider">{t("table.abbreviation")}</th>
                <th className="px-6 py-3 uppercase tracking-wider">{t("table.actions")}</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200 text-sm">
              {sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((d) => (
                <tr key={d.id} className="hover:bg-gray-50 transition">
                  <td className="px-6 py-4 whitespace-nowrap">{d.id}</td>
                  <td className="px-6 py-4 whitespace-nowrap">{d.name}</td>
                  <td className="px-6 py-4 whitespace-nowrap">{d.abbreviation}</td>
                  <td className="px-6 py-4 whitespace-nowrap space-x-2">
                    {activeTab === "active" ? (
                      <>
                        <button onClick={() => openModal("edit", d)} className="px-2 py-1 hover:bg-gray-200 rounded">
                          <FontAwesomeIcon icon={faPenToSquare} style={{ color: "#183e33", fontSize: 20 }} />
                        </button>
                        <button onClick={() => handleDelete(d.id)} className="px-2 py-1 hover:bg-gray-200 rounded" title="Archive">
                          <FontAwesomeIcon icon={faTrash} style={{ color: "#183e33", fontSize: 20 }} />
                        </button>
                      </>
                    ) : (
                      <button 
                        onClick={() => handleRestore(d.id)} 
                        className="px-4 py-1.5 bg-[#183e33] text-white rounded-[10px] hover:bg-[#141716] text-sm font-medium"
                      >
                        Restore
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Pagination ─── */}
      <div className="flex justify-center items-center mt-4 space-x-2">
        {Array.from({ length: totalPages }, (_, i) => (
          <button
            key={i}
            className={`px-3 py-1 rounded border text-sm font-medium ${
              currentPage === i + 1 ? "bg-[#183e33] text-white" : "bg-white text-green-900 border-gray-300 hover:bg-gray-100"
            }`}
            onClick={() => setCurrentPage(i + 1)}
          >
            {i + 1}
          </button>
        ))}
      </div>

      {/* ─── Modal ─── */}
      {modalMode && (
        <div className="fixed inset-0 flex items-start justify-center z-50 pt-20">
          <div className="bg-white p-6 rounded-xl border border-green-300 text-green-900 shadow-lg w-full max-w-md">
            <h2 className="text-xl font-bold mb-4 text-green-700">
              {modalMode === "create" ? t("modal.create") : t("modal.edit")}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block mb-1 font-medium">{t("form.name")}</label>
                <input
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  className={`w-full border p-2 rounded focus:outline-none focus:ring-2 ${
                    missingKeys.name ? "border-red-500 focus:ring-red-300" : "border-green-300 focus:ring-green-500"
                  }`}
                  placeholder={t("form.placeholder.name")}
                />
              </div>

              {/* === เลือก Business Unit === */}
              <div>
                <label className="block mb-1 font-medium">{t("form.businessUnit")}</label>
                <select
                  value={form.businessUnitId === null ? "" : String(form.businessUnitId)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm((prev) => ({
                      ...prev,
                      businessUnitId: v === "" ? null : Number(v),
                    }));
                  }}
                  className="w-full border p-2 rounded focus:outline-none focus:ring-2 border-green-300 focus:ring-green-500"
                >
                  <option value="">{t("form.none")}</option>
                  {businessUnits.map((bu) => (
                    <option key={bu.id} value={bu.id}>
                      {bu.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">{t("form.buHint")}</p>
              </div>

              <div>
                <label className="block mb-1 font-medium">{t("form.abbreviation")}</label>
                <textarea
                  name="abbreviation"
                  value={form.abbreviation}
                  onChange={handleChange}
                  className={`w-full border p-2 rounded focus:outline-none focus:ring-2 ${
                    missingKeys.abbreviation ? "border-red-500 focus:ring-red-300" : "border-green-300 focus:ring-green-500"
                  }`}
                  placeholder={t("form.placeholder.abbreviation")}
                />
              </div>

              <div className="flex justify-end gap-2">
                <button type="button" onClick={closeModal} className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300">
                  {t("modal.cancel")}
                </button>
                <button type="submit" className="px-4 py-2 bg-[#183e33] text-white rounded hover:bg-green-700">
                  {t("modal.submit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin Log Modal */}
      <AdminLogModal
        isOpen={showLogModal}
        onClose={() => setShowLogModal(false)}
        module="DEPARTMENT"
        title="Department Management Log"
      />
    </div>
  );
};

/* ───────── rows-per-page dropdown ───────── */
function PageSizeSelect({
  pageSize,
  setPageSize,
}: {
  pageSize: number;
  setPageSize: (n: number) => void;
}) {
  return (
    <Listbox value={pageSize} onChange={setPageSize}>
      <div className="relative w-24">
        <Listbox.Button className="w-full border border-gray-400 rounded-xl px-2 py-1 flex justify-between items-center">
          {pageSize} <BiChevronDown />
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
              {n}
            </Listbox.Option>
          ))}
        </Listbox.Options>
      </div>
    </Listbox>
  );
}

export default CreateDepartment;
