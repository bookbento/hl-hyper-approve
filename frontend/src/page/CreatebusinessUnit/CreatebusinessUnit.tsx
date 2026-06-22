import React, { useEffect, useState } from "react";
import axios from "axios";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPenToSquare, faTrash } from "@fortawesome/free-solid-svg-icons";
import { useTranslation } from "react-i18next";
import { Listbox } from "@headlessui/react";
import { BiChevronDown } from "react-icons/bi";
import { BiSolidChevronUp, BiSolidChevronDown } from "react-icons/bi";
import toast from "react-hot-toast";
import AdminLogModal from "../../components/AdminLogModal";
interface BusinessUnit {
  id: number;
  name: string;
  abbreviation?: string | null;
}

const API = "/api/business-units";

const CreateBusinessUnit: React.FC = () => {
  /** ───────── state ───────── */
  const { t } = useTranslation("createBusinessUnit");
  const [units, setUnits] = useState<BusinessUnit[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [form, setForm] = useState({ id: 0, name: "", abbreviation: "" });
  const [sortAsc, setSortAsc] = useState(true); // A‑Z ⇄ Z‑A
  const [pageSize, setPageSize] = useState(10); // หน้าละกี่แถว
  const REQUIRED_FIELDS: Array<{ key: keyof typeof form; label: string }> = [
    { key: "name", label: t("formLabels.unitName") },
    { key: "abbreviation", label: t("formLabels.abbreviationOptional") },
  ];
  const [missingKeys, setMissingKeys] = useState<Record<string, boolean>>({});
  const [showLogModal, setShowLogModal] = useState(false);
  const validateRequiredOnly = () => {
    const missingItems = REQUIRED_FIELDS.filter(
      (f) => !String(form[f.key]).trim()
    );
    const missing = REQUIRED_FIELDS.filter(
      (f) => !String(form[f.key]).trim()
    ).map((f) => f.label);

    setMissingKeys(
      missingItems.reduce((acc, cur) => ({ ...acc, [cur.key]: true }), {})
    );

    if (missing.length > 0) {
      toast.error(
        `${t("errors.missing") || "กรุณากรอก"}: ${missing.join(", ")}`
      );
      return false;
    }
    setMissingKeys({});
    return true;
  };
  /** ───────── fetch ───────── */
  useEffect(() => {
    const fetchUnits = async () => {
      try {
        const { data } = await axios.get(API, { withCredentials: true });
        setUnits(data);
      } catch (err) {
        console.error("❌ Error loading business units:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchUnits();
  }, []);

  // ===== helper section =====
  const filteredUnits = units.filter((u) =>
    (u.name + (u.abbreviation ?? ""))
      .toLowerCase()
      .includes(searchTerm.toLowerCase())
  );

  // *** เรียง A‑Z / Z‑A ***
  const sortedUnits = [...filteredUnits].sort((a, b) =>
    sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
  );

  // *** เปลี่ยน pageSize เป็น state ***
  const totalPages = Math.max(1, Math.ceil(sortedUnits.length / pageSize));

  /** ───────── modal ───────── */
  const openModal = (mode: "create" | "edit", unit?: BusinessUnit) => {
    if (mode === "edit" && unit) {
      setForm({
        id: unit.id,
        name: unit.name,
        abbreviation: unit.abbreviation ?? "",
      });
    } else {
      setForm({ id: 0, name: "", abbreviation: "" });
    }
    setModalMode(mode);
  };

  const closeModal = () => setModalMode(null);

  /** ───────── form change ───────── */
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  /** ───────── submit ───────── */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateRequiredOnly()) return;
    try {
      if (modalMode === "create") {
        await axios.post(
          API,
          { name: form.name, abbreviation: form.abbreviation },
          { withCredentials: true }
        );
        toast.success(t("success.created") || "Business unit created successfully");
      } else if (modalMode === "edit") {
        await axios.put(
          `${API}/${form.id}`,
          { name: form.name, abbreviation: form.abbreviation },
          { withCredentials: true }
        );
        toast.success(t("success.updated") || "Business unit updated successfully");
      }
      const { data } = await axios.get(API, { withCredentials: true });
      setUnits(data);
      closeModal();
    } catch (err: any) {
      console.error("❌ Failed to submit:", err);
      const errorMsg = err.response?.data?.error || err.message || "Failed to submit";
      toast.error(errorMsg);
    }
  };

  /** ───────── delete ───────── */
  const handleDelete = async (id: number) => {
    if (!window.confirm("Delete this business unit?")) return;
    try {
      await axios.delete(`${API}/${id}`, { withCredentials: true });
      setUnits((prev) => prev.filter((u) => u.id !== id));
      toast.success(t("success.deleted") || "Business unit deleted successfully");
    } catch (err: any) {
      console.error("❌ Failed to delete:", err);
      const errorMsg = err.response?.data?.error || err.message || "Failed to delete";
      toast.error(errorMsg);
    }
  };

  /** ───────── UI ───────── */
  if (loading)
    return <p className="text-center mt-10 text-gray-500">Loading...</p>;

  return (
    <div className="p-6 w-full max-w-none min-h-screen text-[#183e33]">
      {/* ─── header ─── */}
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <h1 className="text-2xl font-bold">{t("title")}</h1>

          <div className="relative w-full md:w-1/2 lg:w-1/3">
            <input
              type="text"
              placeholder={t("searchPlaceholder")}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-[15px] focus:outline-none focus:ring-2 focus:ring-[#183e33]"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1); // รีเซ็ตหน้าเมื่อค้นหา
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
        </div>

        <hr className="border-t border-gray-300" />

<div className="flex items-center justify-between">
  {/* Left */}
  <PageSizeSelect
    pageSize={pageSize}
    setPageSize={(n) => {
      setPageSize(n);
      setCurrentPage(1);
    }}
  />

  {/* Right */}
  <div className="flex items-center gap-3">
    <button
      onClick={() => openModal("create")}
      className="bg-[#183e33] text-white px-4 py-2 rounded-[15px] hover:bg-[#141716]"
    >
      {t("button.create")}
    </button>

    <button
      onClick={() => setShowLogModal(true)}
      className="bg-gray-600 text-white px-4 py-2 rounded-[15px] hover:bg-gray-700"
    >
      {t("viewLog")}
    </button>
  </div>
</div>

      </div>

      {/* ─── table ─── */}
      <div className="bg-white shadow-xl rounded-2xl overflow-hidden -mx-6 sm:mx-0">
        <div className="overflow-x-auto w-full">
          <table className="min-w-full w-full table-auto divide-y divide-[#8A8787]">
            <thead className="bg-gradient-to-r text-left from-white font-extrabold">
              <tr>
                <th className="px-6 py-3 text-l uppercase tracking-wider">
                  {t("table.id")}
                </th>
                <th className="px-6 py-3 uppercase tracking-wider">
                  <span className="inline-flex items-center">
                    {t("table.name")}
                    <button
                      onClick={() => {
                        setSortAsc((a) => !a);
                        setCurrentPage(1);
                      }}
                      title={sortAsc ? "Z‑A" : "A‑Z"}
                      className="ml-0 inline-flex items-center justify-center w-5 h-5 text-gray-500 hover:text-[#183e33]"
                    >
                      {sortAsc ? (
                        <BiSolidChevronUp size={16} />
                      ) : (
                        <BiSolidChevronDown size={16} />
                      )}
                    </button>
                  </span>
                </th>

                <th className="px-6 py-3 text-left text-l uppercase tracking-wider">
                  {t("table.abbreviation")}
                </th>
                <th className="px-6 py-3 text-left text-l uppercase tracking-wider">
                  {t("table.actions")}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200 text-sm">
              {sortedUnits
                .slice((currentPage - 1) * pageSize, currentPage * pageSize)
                .map((u, i) => (
                  <tr key={u.id} className="hover:bg-gray-50 transition">
                    <td className="px-6 py-4 whitespace-nowrap">{u.id}</td>
                    <td className="px-6 py-4 whitespace-nowrap">{u.name}</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {u.abbreviation || "-"}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap space-x-2">
                      <button
                        onClick={() => openModal("edit", u)}
                        className="px-2 py-1 hover:bg-gray-200 rounded"
                      >
                        <FontAwesomeIcon
                          icon={faPenToSquare}
                          style={{ color: "#183e33", fontSize: 20 }}
                        />
                      </button>
                      <button
                        onClick={() => handleDelete(u.id)}
                        className="px-2 py-1 hover:bg-gray-200 rounded"
                      >
                        <FontAwesomeIcon
                          icon={faTrash}
                          style={{ color: "#183e33", fontSize: 20 }}
                        />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── pagination ─── */}
      <div className="flex justify-center items-center mt-4 space-x-2">
        {Array.from({ length: totalPages }, (_, i) => (
          <button
            key={i}
            className={`px-3 py-1 rounded border text-sm font-medium ${
              currentPage === i + 1
                ? "bg-[#183e33] text-white"
                : "bg-white text-green-900 border-gray-300 hover:bg-gray-100"
            }`}
            onClick={() => setCurrentPage(i + 1)}
          >
            {i + 1}
          </button>
        ))}
      </div>

      {/* ─── modal ─── */}
      {modalMode && (
        <div className="fixed inset-0 flex items-start justify-center z-50 pt-20">
          <div className="bg-white p-6 rounded-xl border border-green-300 text-green-900 shadow-lg w-full max-w-md">
            <h2 className="text-xl font-bold mb-4 text-green-700">
              {modalMode === "create" ? t("modal.create") : t("modal.edit")}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block mb-1 font-medium">
                  {t("formLabels.unitName")}
                </label>
                <input
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  className={`w-full border p-2 rounded focus:outline-none focus:ring-2 ${
                    missingKeys.name
                      ? "border-red-500 focus:ring-red-300"
                      : "border-green-300 focus:ring-green-500"
                  }`}
                  placeholder={t("form.placeholder.name")}
                />
              </div>
              <div>
                <label className="block mb-1 font-medium">
                  {t("formLabels.abbreviationOptional")}
                </label>
                <input
                  type="text"
                  name="abbreviation"
                  value={form.abbreviation}
                  onChange={handleChange}
                  className={`w-full border p-2 rounded focus:outline-none focus:ring-2 ${
                    missingKeys.abbreviation
                      ? "border-red-500 focus:ring-red-300"
                      : "border-green-300 focus:ring-green-500"
                  }`}
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
                >
                  {t("modal.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-[#183e33] text-white rounded hover:bg-green-700"
                >
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
        module="BUSINESS_UNIT"
        title="Business Unit Management Log"
      />
    </div>
  );
};

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
          {Array.from({ length: 10 }, (_, i) => (i + 1) * 10).map((n) => (
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
export default CreateBusinessUnit;
