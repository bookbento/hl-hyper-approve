import { motion, useReducedMotion } from "framer-motion";
import type { CSSProperties } from "react";
import { CountUp, SpotlightCard } from "../../components/motion";

type Props = {
  label: string;
  value: number;
  /** hex colour of this card's status */
  accent: string;
  active: boolean;
  loading: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** position in the grid, for the entrance stagger */
  index: number;
  loadingLabel: string;
};

/** Dashboard stat card: spotlight hover, counting number, accent when selected. */
export default function StatCard({
  label,
  value,
  accent,
  active,
  loading,
  onClick,
  disabled,
  index,
  loadingLabel,
}: Props) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: index * 0.04 }}
      whileHover={reduce || disabled ? undefined : { y: -3 }}
      whileTap={reduce || disabled ? undefined : { scale: 0.98 }}
      className="h-full"
    >
      <SpotlightCard
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={active}
        title={label}
        spotlightColor={`${accent}26`}
        style={{ "--accent": accent } as CSSProperties}
        className={[
          "flex h-full w-full flex-col justify-between gap-3 rounded-card border bg-white p-4",
          "shadow-card transition-[box-shadow,border-color,background-color] duration-300 ease-spring",
          "hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-60",
          active
            ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_7%,white)] shadow-card-hover"
            : "border-gray-100",
        ].join(" ")}
      >
        <span className="flex items-center gap-2 text-[13px] font-medium text-gray-500">
          <span
            className="relative inline-flex h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: accent }}
          >
            {active && !reduce && (
              <span
                className="absolute inset-0 animate-ping rounded-full opacity-60"
                style={{ backgroundColor: accent }}
              />
            )}
          </span>
          <span className="truncate">{label}</span>
        </span>

        <span className="text-[26px] font-bold leading-none tracking-tight text-gray-900" aria-busy={loading} aria-live="polite">
          {loading ? (
            <span className="inline-block h-7 w-20 animate-pulse rounded-md bg-gray-200 align-middle" aria-label={loadingLabel}>
              <span className="sr-only">{loadingLabel}</span>
            </span>
          ) : (
            <CountUp to={value} />
          )}
        </span>

        {/* accent bar that grows when the card is selected */}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-[3px] origin-left transition-transform duration-500 ease-spring"
          style={{ backgroundColor: accent, transform: active ? "scaleX(1)" : "scaleX(0.18)" }}
        />
      </SpotlightCard>
    </motion.div>
  );
}
