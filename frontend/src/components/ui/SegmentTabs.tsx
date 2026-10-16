import type { ReactNode } from "react";
import RubberSegment from "../reactbits/RubberSegment/RubberSegment";

type Tab = { value: string; label: ReactNode; count?: number };

type Props = {
  tabs: Tab[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
};

/** Page tabs (Active / Archived …) on React Bits RubberSegment. */
export default function SegmentTabs({ tabs, value, onChange, ariaLabel = "Tabs" }: Props) {
  return (
    <RubberSegment
      aria-label={ariaLabel}
      size="sm"
      radius={12}
      equalSlots={false}
      value={value}
      onChange={(v) => onChange(v)}
      trackColor="#f1f3f2"
      thumbColor="#ffffff"
      textColor="#6b7280"
      activeTextColor="#183e33"
      items={tabs.map((t) => ({
        value: t.value,
        label: (
          <span className="inline-flex items-center gap-1.5">
            {t.label}
            {typeof t.count === "number" && (
              <span className="rounded-full bg-gray-200/70 px-1.5 text-[10px] leading-4 text-gray-600">{t.count}</span>
            )}
          </span>
        ),
      }))}
    />
  );
}
