import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageHeader from "../../components/ui/PageHeader";
import SegmentTabs from "../../components/ui/SegmentTabs";
import SearchInput from "../../components/ui/SearchInput";
import { btn } from "../../components/ui/button";
import { ClipboardCheck, RefreshCw } from "lucide-react";

/* ---------- types ที่ match กับ /api/approval-requests/my ---------- */
type Owner = { id: number; name: string; lastname?: string | null; nickname: string | null };


type RequestItemMain = {
  memoId: number;
  memonumber: string;
  subject: string;
  owner: Owner;
  requestedAt: string; // ISO
  requestType: "main";
  level: number; // 0-based
  expiresAt?: string | null; // ← ADD
};

type RequestItemExtra = {
  memoId: number;
  memonumber: string;
  subject: string;
  owner: Owner;
  requestedAt: string; // ISO
  requestType: "extra";
  extraId: number;
  expiresAt?: string | null; // ← ADD
};

type Payload = { items: Array<RequestItemMain | RequestItemExtra> };

type FilterType = "all" | "main" | "extra";
type ExpiryFilter = "all" | "expired" | "soon" | "active" | "none"; // none = ไม่มีวันหมดอายุ

// --- helper: เช็คสถานะวันหมดอายุ ---
const getExpiryState = (iso?: string | null): "expired" | "soon" | "ok" | "none" => {
  if (!iso) return "none";
  const d = new Date(iso);
  if (isNaN(+d)) return "none";
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return "expired";
  const daysLeft = Math.ceil(diffMs / 86400000);
  return daysLeft <= 3 ? "soon" : "ok";
};



// ===== ป้ายสถานะวันหมดอายุ 3 ระดับ =====
const ExpiryBadge: React.FC<{ iso?: string | null }> = ({ iso }) => {
  const { t } = useTranslation("showApprover");
  const formatDate = useDateTimeFormatter();

  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(+d)) return null;

  const now = Date.now();
  const diffMs = d.getTime() - now;
  const daysLeft = Math.ceil(diffMs / 86400000); // ปัดขึ้นเป็นจำนวนวัน
  const state = diffMs <= 0 ? "expired" : daysLeft <= 3 ? "soon" : "ok";

  const styles =
    state === "expired"
      ? "bg-red-50 text-red-700 border border-red-200"
      : state === "soon"
      ? "bg-amber-50 text-amber-700 border border-amber-200"
      : "bg-brand-50 text-brand-700 border border-brand-200";

  const label =
    state === "expired"
      ? t("expiry.expired", "Expired")
      : state === "soon"
      ? t("expiry.soon", "Expiring soon")
      : t("expiry.ok", "Active");

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-gray-600">
        {t("label.expiresAt", "Expires In")}:
      </span>

      {/* ป้ายสถานะ */}
      <span
        className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${styles}`}
      >
        {/* ไอคอนตามระดับ */}
        {state === "expired" ? (
          <svg
            viewBox="0 0 20 20"
            className="w-4 h-4 mr-1.5"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.72-1.36 3.485 0l6.518 11.6c.75 1.335-.213 3.001-1.742 3.001H3.48c-1.53 0-2.492-1.666-1.743-3.001l6.52-11.6zM11 14a1 1 0 11-2 0 1 1 0 012 0zm-1-2a1 1 0 01-1-1V8a1 1 0 112 0v3a1 1 0 01-1 1z"
              clipRule="evenodd"
            />
          </svg>
        ) : state === "soon" ? (
          <svg
            viewBox="0 0 20 20"
            className="w-4 h-4 mr-1.5"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.099a2 2 0 013.486 0l6 10.682A2 2 0 0115.999 17H4.001a2 2 0 01-1.744-3.219l6-10.682zM11 14a1 1 0 11-2 0 1 1 0 012 0zm-1-7a1 1 0 00-1 1v3a1 1 0 102 0V8a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        ) : (
          <svg
            viewBox="0 0 20 20"
            className="w-4 h-4 mr-1.5"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 10-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
        )}
        {state === "soon"
          ? t("expiry.soon", "Expiring soon")
          : state === "expired"
          ? t("expiry.expired", "Expired")
          : t("expiry.ok", "Active")}
      </span>

      {/* วันที่หมดอายุ */}
      <time
        className="text-sm text-gray-700"
        dateTime={iso}
        title={new Date(iso).toLocaleString()}
      >
        {formatDate(iso)}
      </time>
    </div>
  );
};

async function fetchExpiresMap(
  ids: number[]
): Promise<Record<number, string | null>> {
  if (!ids.length) return {};
  const uniq = Array.from(new Set(ids));

  const settled = await Promise.allSettled(
    uniq.map((id) => axios.get(`/api/memos/${id}`, { withCredentials: true }))
  );

  const map: Record<number, string | null> = {};
  settled.forEach((res, i) => {
    const id = uniq[i];
    if (res.status === "fulfilled") {
      // รองรับหลายรูปทรง response
      const raw = res.value.data;
      const obj = raw?.data ?? raw ?? {};
      map[id] =
        obj.expiresAt ??
        obj.expires_at ??
        obj.memo?.expiresAt ??
        obj.memo?.expires_at ??
        null;
    } else {
      map[id] = null; // พลาดก็ปล่อยว่าง
    }
  });
  return map;
}
// ===== helper: format วันที่ตามภาษา (คงของเดิมไว้ก็ได้) =====
const useDateTimeFormatter = () => {
  const { i18n } = useTranslation();
  return (iso?: string | null) => {
    if (!iso) return "-";
    const d = new Date(iso);
    if (isNaN(+d)) return "-";
    return new Intl.DateTimeFormat(i18n.language || undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  };
};

// ===== ป้ายวันหมดอายุแบบเข้าธีม (2 ชิ้น: วันที่ + สถานะ) =====
const ExpiryPills: React.FC<{ iso?: string | null }> = ({ iso }) => {
  const { t } = useTranslation("showApprover");
  const formatDate = useDateTimeFormatter();

  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(+d)) return null;

  const diffMs = d.getTime() - Date.now();
  const daysLeft = Math.ceil(diffMs / 86400000);
  const state: "expired" | "soon" | "ok" =
    diffMs <= 0 ? "expired" : daysLeft <= 3 ? "soon" : "ok";

  const pillClass =
    state === "expired"
      ? "bg-red-100 text-red-700 border border-red-200"
      : state === "soon"
      ? "bg-amber-100 text-amber-700 border border-amber-200"
      : "bg-brand-50 text-brand-700 border border-brand-200";

  const label =
    state === "expired"
      ? t("expiry.expired", "หมดอายุ")
      : state === "soon"
      ? t("expiry.soon", "ใกล้หมดอายุ")
      : t("expiry.ok", "ใช้งานได้");

  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      {/* ป้ายวันที่ – โทนเดียวกับ memonumber */}
      <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-gray-100 text-gray-700">
        {/* calendar icon */}
        <svg
          className="w-4 h-4 mr-1 text-gray-500"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M6 2a1 1 0 011 1v1h6V3a1 1 0 112 0v1h1a2 2 0 012 2v9a2 2 0 01-2 2H3a2 2 0 01-2-2V6a2 2 0 012-2h1V3a1 1 0 112 0v1zm11 6H3v7a1 1 0 001 1h12a1 1 0 001-1V8zM3 7h14V6a1 1 0 00-1-1h-1v1a1 1 0 11-2 0V5H7v1a1 1 0 11-2 0V5H4a1 1 0 00-1 1v1z" />
        </svg>
        <time dateTime={iso} title={new Date(iso).toLocaleString()}>
          {formatDate(iso)}
        </time>
      </span>

      {/* ป้ายสถานะ – 3 ระดับ พร้อมไอคอน */}
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${pillClass}`}
      >
        {state === "expired" ? (
          // ไอคอนอันตราย
          <svg
            className="w-4 h-4 mr-1"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.099a2 2 0 013.486 0l6 10.682A2 2 0 0115.999 17H4.001a2 2 0 01-1.744-3.219l6-10.682zM11 14a1 1 0 11-2 0 1 1 0 012 0zm-1-7a1 1 0 00-1 1v3a1 1 0 102 0V8a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        ) : state === "soon" ? (
          // ไอคอนระวัง
          <svg
            className="w-4 h-4 mr-1"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm-.75-5.5a.75.75 0 011.5 0v1a.75.75 0 01-1.5 0v-1zm0-6a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0V6.5z"
              clipRule="evenodd"
            />
          </svg>
        ) : (
          // ไอคอนผ่าน
          <svg
            className="w-4 h-4 mr-1"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.536-9.95a.75.75 0 10-1.06-1.06L9 10.464 7.525 8.99a.75.75 0 10-1.06 1.06l2 2a.75.75 0 001.06 0l4.01-4z"
              clipRule="evenodd"
            />
          </svg>
        )}
        {label}
      </span>
    </div>
  );
};


const getCreatorDisplay = (it: any) => {
  const o = it?.owner ?? {};

  const first =
    o.firstName ?? o.first_name ?? o.name ??  // 👈 บางระบบใช้ name = ชื่อจริง
    it.createdByFirstName ?? it.creatorFirstName ??
    it.firstName ?? it.first_name ?? null;

  const last =
    o.lastName ?? o.last_name ?? o.lastname ?? // 👈 เพิ่ม o.lastname
    it.createdByLastName ?? it.creatorLastName ??
    it.lastName ?? it.last_name ?? null;

  let baseName: string | null =
    o.fullName ?? o.full_name ??
    it.createdByName ?? it.creatorName ??
    it.ownerName ?? it.fullName ?? it.full_name ?? null;

  if (!baseName) {
    if (first || last) baseName = [first, last].filter(Boolean).join(" ").trim();
    else baseName = o.name ?? it.createdBy ?? it.creator ?? "-";
  }

  const nickname =
    o.nickname ?? it.ownerNickname ?? it.createdByNickname ?? it.creatorNickname ?? null;

  return nickname ? `${baseName} (${nickname})` : String(baseName);
};

export default function ShowAppover() {
  const [items, setItems] = useState<Payload["items"]>([]);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const { t } = useTranslation("showApprover");
 const [filterType, setFilterType] = useState<FilterType>("all");
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>("all");
  const navigate = useNavigate();
 const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get<Payload>("/api/approval-requests/my", {
        withCredentials: true,
      });

      const all = data?.items ?? [];

      // -------- SEARCH --------
      const q = searchTerm.trim().toLowerCase();

      // -------- TYPE FILTER (all/main/extra) --------
      let filtered = all.filter((m) => {
        if (filterType === "all") return true;
        return m.requestType === filterType;
      });

      // -------- EXPIRY FILTER (all/expired/soon/active/none) --------
      filtered = filtered.filter((m) => {
        if (expiryFilter === "all") return true;
        const s = getExpiryState((m as any).expiresAt);
        if (expiryFilter === "none") return s === "none";
        if (expiryFilter === "active") return s === "ok";
        return s === expiryFilter; // "expired" | "soon"
      });

      // -------- TEXT SEARCH --------
      filtered = q
        ? filtered.filter((m) => {
            const o = (m.owner as any) || {};
            return [m.memonumber, m.subject, o.name, o.lastname, o.nickname || ""]
              .join(" ")
              .toLowerCase()
              .includes(q);
          })
        : filtered;

      setTotal(filtered.length);

      // paginate
      const start = (page - 1) * limit;
      const paginated = filtered.slice(start, start + limit);

      // enrich expiresAt (กันกรณี BE ไม่ส่ง)
      let enriched = paginated as Array<RequestItemMain | RequestItemExtra>;
      const hasExpAlready = paginated.some((x: any) => x.expiresAt != null);
      if (!hasExpAlready) {
        try {
          const ids = paginated.map((x) => x.memoId);
          const expMap = await fetchExpiresMap(ids);
          enriched = paginated.map((it) => ({
            ...it,
            expiresAt: (it as any).expiresAt ?? expMap[it.memoId] ?? null,
          }));
        } catch (e) {
          console.warn("Cannot enrich expiresAt:", e);
        }
      }

      setItems(enriched);
    } catch (err) {
      console.error("Failed to load approval requests", err);
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, limit, searchTerm, filterType, expiryFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / limit)),
    [total, limit]
  );

  return (
    <div className="w-full p-4 sm:p-6">
      <div className="mx-auto max-w-6xl">
        <PageHeader
          icon={<ClipboardCheck />}
          title={t("title")}
          description={t("subtitle", { defaultValue: "Memos waiting for your approval" })}
          actions={
            <button onClick={() => fetchData()} className={btn("secondary")}>
              <RefreshCw className="h-4 w-4" />
              {t("refresh")}
            </button>
          }
        >
          <div className="ui-panel flex flex-col gap-3 p-3">
            <SearchInput
              wrapperClassName="sm:max-w-none"
              placeholder={t("searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => {
                setPage(1);
                setSearchTerm(e.target.value);
              }}
            />
            <div className="flex flex-col gap-3 overflow-x-auto lg:flex-row lg:items-center lg:justify-between">
              <SegmentTabs
                ariaLabel="Request type"
                value={filterType}
                onChange={(v) => {
                  setPage(1);
                  setFilterType(v as FilterType);
                }}
                tabs={[
                  { value: "all", label: t("filter.type.all", "ทั้งหมด") },
                  { value: "main", label: t("filter.type.main", "Main") },
                  { value: "extra", label: t("filter.type.extra", "Extra") },
                ]}
              />
              <SegmentTabs
                ariaLabel="Expiry"
                value={expiryFilter}
                onChange={(v) => {
                  setPage(1);
                  setExpiryFilter(v as ExpiryFilter);
                }}
                tabs={[
                  { value: "all", label: t("filter.expiry.all", "หมดอายุทั้งหมด") },
                  { value: "expired", label: t("filter.expiry.expired", "หมดอายุแล้ว") },
                  { value: "soon", label: t("filter.expiry.soon", "ใกล้หมดอายุ (≤3วัน)") },
                  { value: "active", label: t("filter.expiry.active", "ยังไม่หมดอายุ") },
                  { value: "none", label: t("filter.expiry.none", "ไม่มีวันหมดอายุ") },
                ]}
              />
            </div>
          </div>
        </PageHeader>

        {/* Content */}
        <div className="ui-panel overflow-hidden">
          {/* Loading */}
          {loading && (
            <div className="py-12 flex flex-col items-center justify-center">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-brand-600 mb-4"></div>
              <p className="text-gray-600">{t("loading")}</p>
            </div>
          )}

          {/* Empty */}
          {!loading && items.length === 0 && (
            <div className="py-12 flex flex-col items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-24 w-24 text-gray-300 mb-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <h3 className="text-xl font-medium text-gray-700 mb-2">
                {t("emptyTitle")}
              </h3>
              <p className="text-gray-500 max-w-md text-center">
                {t("emptySubtitle")}
              </p>
            </div>
          )}

          {/* List */}
          {!loading && items.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {items.map((it) => (
                <li
                  key={`${it.requestType}-${it.memoId}-${
                    "level" in it ? it.level : (it as RequestItemExtra).extraId
                  }`}
                  className="border-b border-gray-100 p-5 transition-colors duration-150 last:border-b-0 hover:bg-brand-50/50"
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-3">
                        <div className="rounded-xl bg-brand-50 p-2 ring-1 ring-inset ring-brand-100">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-6 w-6 text-brand-700"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                            />
                          </svg>
                        </div>
                        <div className="min-w-0">
                          <h2 className="truncate text-base font-semibold text-gray-900">
                            {it.subject}
                          </h2>

                          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
                            {/* เลขเอกสาร */}
                            <span className="px-2 py-0.5 rounded-md bg-gray-100 text-gray-700">
                              {it.memonumber}
                            </span>

                            {/* ผู้สร้าง */}
 <span className="flex items-center text-gray-500">
   <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" viewBox="0 0 20 20" fill="currentColor">
     <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
   </svg>
   <span className="mr-1">{t("createdByLabel", "ผู้สร้าง:")}</span>
   <span className="text-gray-700">{getCreatorDisplay(it)}</span>
 </span>

                            {/* ประเภทงาน */}
                            {it.requestType === "extra" ? (
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200">
                                Extra
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200">
                                Main{" "}
                                {"level" in it
                                  ? `(L${(it as RequestItemMain).level + 1})`
                                  : ""}
                              </span>
                            )}
                            {/* Expires At */}
                            {it.expiresAt ? (
                              <div className="mt-1">
                                <ExpiryPills iso={it.expiresAt} />
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => navigate(`/memo/${it.memoId}`)}
                      className={btn("primary")}
                    >
                      {t("goApprove")}
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10.293 5.293a1 1 0 011.414 0l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414-1.414L12.586 11H5a1 1 0 110-2h7.586l-2.293-2.293a1 1 0 010-1.414z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Pagination */}
          <div className="border-t border-gray-300 px-5 py-4">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center">
                <span className="text-sm text-gray-700">
                  {t("footer.show")}
                </span>
                <select
                  className="mx-2 border-gray-300 rounded-lg text-sm focus:border-brand-500 focus:ring-brand-500"
                  value={limit}
                  onChange={(e) => {
                    setPage(1);
                    setLimit(Number(e.target.value));
                  }}
                >
                  {[10, 20, 50].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setPage((p) => Math.max(p - 1, 1))}
                  disabled={page === 1}
                  className={`p-2 rounded-lg ${
                    page === 1
                      ? "text-gray-300"
                      : "text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>

                <span className="text-sm font-medium">
                  {t("footer.page", { page, totalPages })}
                </span>

                <button
                  onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                  disabled={page === totalPages}
                  className={`p-2 rounded-lg ${
                    page === totalPages
                      ? "text-gray-300"
                      : "text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
