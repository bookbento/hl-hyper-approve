/** Relative time ("5 minutes ago" / "ผ่านมาแล้ว 5 นาที") for the dashboard. */
import { useCallback } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const UNITS: Array<[number, "year" | "month" | "week" | "day" | "hour" | "minute"]> = [
  [365 * DAY, "year"],
  [30 * DAY, "month"],
  [7 * DAY, "week"],
  [DAY, "day"],
  [HOUR, "hour"],
  [MIN, "minute"],
];

function compose(n: number, unit: string, isPast: boolean, t: TFunction, lang: string) {
  if (lang.startsWith("en")) {
    const unitStr = n !== 1 ? `${unit}s` : unit;
    return isPast ? `${n} ${unitStr} ago` : `${t("timeago.futurePrefix")}${n} ${unitStr}`;
  }
  const prefix = isPast ? t("timeago.pastPrefix") : t("timeago.futurePrefix");
  return `${prefix}${n} ${unit}`;
}

export function formatTimeAgo(fromISO: string | null | undefined, t: TFunction, lang: string): string {
  if (!fromISO) return "-";
  const then = new Date(fromISO).getTime();
  if (Number.isNaN(then)) return "-";
  const diff = Date.now() - then; // > 0 = past
  const abs = Math.abs(diff);
  if (abs < 45 * 1000) return diff >= 0 ? t("timeago.nowPast") : t("timeago.nowFuture");
  for (const [ms, key] of UNITS) {
    if (abs >= ms) return compose(Math.floor(abs / ms), t(`timeago.units.${key}`), diff >= 0, t, lang);
  }
  return compose(Math.floor(abs / 1000), t("timeago.units.second"), diff >= 0, t, lang);
}

/** Stable `timeAgo(iso)` for the current language. */
export function useTimeAgo() {
  const { t, i18n } = useTranslation("dashboard");
  const lang = i18n.language;
  return useCallback((fromISO?: string | null) => formatTimeAgo(fromISO, t, lang), [t, lang]);
}
