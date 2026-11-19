import { memo } from "react";
import { useTranslation } from "react-i18next";
import GlideSelect from "../../components/reactbits/GlideSelect/GlideSelect";

export type PageSize = number | "All";

const SIZES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

type Props = {
  page: number;
  /** rows matching the current filters (server total) */
  total: number;
  totalPages: number;
  pageSize: PageSize;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
};

/**
 * Pager + rows-per-page select. Lived inside Dashboard before, so it remounted on
 * every render (an open menu closed whenever the list refreshed).
 */
function PageSizePicker({ page, total, totalPages, pageSize, onPageChange, onPageSizeChange }: Props) {
  const { t, i18n } = useTranslation("dashboard");
  const isAll = pageSize === "All";
  const fmt = (n: number) => n.toLocaleString(i18n.language);
  const size = typeof pageSize === "number" ? pageSize : total;
  const from = total ? (page - 1) * size + 1 : 0;
  const to = Math.min(total, page * size);
  const navBtn =
    "grid h-8 w-8 place-items-center rounded-lg border border-gray-200 text-sm text-gray-600 shadow-sm transition-colors hover:border-brand-200 hover:bg-brand-50 disabled:opacity-40 disabled:hover:bg-transparent";

  // div, not label: a <label> forwards clicks to its first button (the disabled ‹),
  // which fought with the GlideSelect trigger.
  return (
    <div className="inline-flex items-center gap-2 text-sm text-gray-700">
      <span className="hidden text-sm tabular-nums text-gray-500 lg:inline" aria-live="polite">
        {isAll
          ? t("pager.countAll", { total: fmt(total) })
          : t("pager.range", { from: fmt(from), to: fmt(to), total: fmt(total) })}
      </span>
      {!isAll && (
        <span className="text-sm text-gray-600">{t("pager.pageOf", { page, totalPages })}</span>
      )}
      {!isAll && (
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className={navBtn}
          title={t("pager.titlePrev")}
          aria-label={t("pager.prev")}
        >
          ‹
        </button>
      )}
      <GlideSelect
        ariaLabel={t("pager.ariaPerPage")}
        size="sm"
        align="right"
        menuWidth={140}
        value={isAll ? "All" : String(pageSize)}
        options={[
          ...SIZES.map((n) => ({ value: String(n), label: String(n) })),
          // the count tells people how much "All" will load
          { value: "All", label: total ? t("pager.allWithCount", { count: fmt(total) }) : t("pager.all") },
        ]}
        onChange={(v) => onPageSizeChange(v === "All" ? "All" : Number(v))}
        accentColor="#183e33"
        surfaceColor="#ffffff"
        highlightColor="#eef7f3"
        textColor="#1f2937"
      />
      {!isAll && (
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className={navBtn}
          title={t("pager.titleNext")}
          aria-label={t("pager.next")}
        >
          ›
        </button>
      )}
    </div>
  );
}

export default memo(PageSizePicker);
