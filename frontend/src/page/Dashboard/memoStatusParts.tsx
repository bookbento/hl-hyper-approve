/**
 * Small per-row pieces of the dashboard table/cards.
 *
 * These used to be declared inside the Dashboard component body, which gave
 * them a new component type on every render: every row's badge, progress bar
 * and StatusMark unmounted and remounted whenever any dashboard state changed.
 * At module scope + memo they render once per row and only update on change.
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";
import StatusMark from "../../components/reactbits/StatusMark/StatusMark";

export type ApproverCode = "waiting" | "approved" | "rejected" | "terminated" | "not_required";

const PROGRESS_FILL: Record<string, string> = {
  Draft: "bg-gray-500",
  Processing: "bg-yellow-500",
  Approved: "bg-green-600",
  Rejected: "bg-orange-400",
  Terminated: "bg-red-900",
  Recalled: "bg-sky-600",
  Published: "bg-indigo-600",
  Expired: "bg-purple-600",
  default: "bg-blue-600",
};

const BADGE_STYLES: Record<string, { pill: string; dot: string }> = {
  Draft: { pill: "bg-gray-100 text-gray-700 ring-gray-200", dot: "bg-gray-400" },
  Published: { pill: "bg-yellow-50 text-yellow-800 ring-yellow-200", dot: "bg-yellow-500" },
  Approved: { pill: "bg-green-50 text-green-700 ring-green-200", dot: "bg-green-500" },
  Rejected: { pill: "bg-orange-50 text-orange-700 ring-orange-200", dot: "bg-orange-500" },
  Terminated: { pill: "bg-red-50 text-red-700 ring-red-200", dot: "bg-red-600" },
  Processing: { pill: "bg-amber-50 text-amber-700 ring-amber-200", dot: "bg-amber-500 animate-pulse" },
  Recalled: { pill: "bg-sky-50 text-sky-700 ring-sky-200", dot: "bg-sky-500" },
  Expired: { pill: "bg-purple-50 text-purple-700 ring-purple-200", dot: "bg-purple-500" },
};

/** Soft pill + dot for a memo status. */
export const StatusBadge = memo(function StatusBadge({ status }: { status: string }) {
  const st = BADGE_STYLES[status] ?? BADGE_STYLES.Draft;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${st.pill}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} aria-hidden="true" />
      {status}
    </span>
  );
});

/** acted / total approvers as a bar coloured by the memo status. */
export const ApprovalProgress = memo(function ApprovalProgress({
  codes,
  status,
  className = "",
}: {
  /** status code of every main-line approver */
  codes: readonly ApproverCode[];
  status?: string;
  className?: string;
}) {
  const total = codes.length;
  const acted = codes.filter((c) => c !== "waiting").length;
  const pct = total ? Math.round((acted / total) * 100) : 0;
  const fill = (status && PROGRESS_FILL[status]) || PROGRESS_FILL.default;

  return (
    <div className={className}>
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-gray-200">
        <div
          className={`absolute left-0 top-0 h-full transition-[width] duration-300 ease-out ${fill}`}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-white drop-shadow-sm">
          {acted}/{total}
        </div>
      </div>
    </div>
  );
});

/**
 * Status badge with the progress bar exactly as wide as the badge.
 * An inline-grid column sizes to the badge and the bar stretches to it; this
 * replaces a ResizeObserver + setState per row.
 */
export const StatusWithProgress = memo(function StatusWithProgress({
  status,
  codes,
}: {
  status?: string;
  codes: readonly ApproverCode[];
}) {
  return (
    <div className="inline-grid gap-1">
      <span className="justify-self-center">
        <StatusBadge status={status ?? ""} />
      </span>
      <ApprovalProgress codes={codes} status={status} className="w-full" />
    </div>
  );
});

const MINI_STYLE: Record<ApproverCode, string> = {
  approved: "bg-green-100 text-green-700 border-green-200",
  not_required: "bg-green-50 text-green-700 border-green-200",
  rejected: "bg-orange-100 text-orange-700 border-orange-200",
  terminated: "bg-red-100 text-red-700 border-red-200",
  waiting: "bg-gray-200 text-gray-700 border-gray-200",
};

/** One approver's status: React Bits StatusMark (ring while waiting, tick, cross). */
export const MiniStatus = memo(function MiniStatus({ code }: { code: ApproverCode }) {
  const { t } = useTranslation("dashboard");
  const label =
    code === "approved"
      ? "Approved"
      : code === "not_required"
        ? t("statusByUser.not_required", "Level approved")
        : code === "rejected"
          ? "Rejected"
          : code === "terminated"
            ? "Terminated"
            : "Waiting";
  const mark =
    code === "approved" || code === "not_required"
      ? "done"
      : code === "rejected"
        ? "failed"
        : code === "terminated"
          ? "cancelled"
          : "pending";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 ${MINI_STYLE[code] ?? MINI_STYLE.waiting}`}>
      <StatusMark
        status={mark}
        label={label}
        size={13}
        strokeWidth={2}
        fontSize={12}
        color="currentColor"
        doneColor="#15803d"
        errorColor={code === "rejected" ? "#c2410c" : "#b91c1c"}
        strike={false}
      />
    </span>
  );
});
