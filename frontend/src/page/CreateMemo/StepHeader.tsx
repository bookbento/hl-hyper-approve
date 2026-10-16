import { motion, useReducedMotion } from "framer-motion";
import { Check } from "lucide-react";

type StepDef = { key: string; label: string };

type Props = {
  steps: StepDef[];
  /** 1-based */
  current: number;
  isCompleted: (index: number) => boolean;
  onStepClick: (step: number) => void;
  stateLabel: (state: "completed" | "active" | "upcoming") => string;
};

/**
 * Step indicator in the style of React Bits' Stepper (numbered circles joined by a
 * track that fills with a spring). MemoForm keeps its own step logic and validation,
 * so only the indicator is used — the React Bits component also owns content and
 * Back/Next buttons. Replaces the old gradient cards (which also pulled a
 * background image from assets.codepen.io).
 */
export default function StepHeader({ steps, current, isCompleted, onStepClick, stateLabel }: Props) {
  const reduce = useReducedMotion();
  const progress = steps.length > 1 ? (current - 1) / (steps.length - 1) : 0;

  return (
    <nav aria-label="Steps" className="mb-6 rounded-card border border-gray-100 bg-white px-4 py-3 shadow-card sm:px-6">
      <ol className="relative flex items-center justify-between gap-4">
        {/* track */}
        <span aria-hidden="true" className="absolute left-[18px] right-[18px] top-[18px] h-[3px] rounded-full bg-gray-100" />
        <motion.span
          aria-hidden="true"
          className="absolute left-[18px] top-[18px] h-[3px] origin-left rounded-full bg-brand-500"
          style={{ right: 18 }}
          initial={false}
          animate={{ scaleX: progress }}
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 220, damping: 26 }}
        />

        {steps.map((s, i) => {
          const n = i + 1;
          const active = current === n;
          const done = isCompleted(i);
          const state = done && !active ? "completed" : active ? "active" : "upcoming";
          return (
            <li key={s.key} className="relative z-10 flex flex-1 last:flex-none">
              <button
                type="button"
                onClick={() => onStepClick(n)}
                aria-current={active ? "step" : undefined}
                className="group flex items-center gap-3 rounded-xl bg-white pr-3 text-left outline-none focus-visible:ring-4 focus-visible:ring-brand-500/20"
              >
                <motion.span
                  className={[
                    "relative grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 text-sm font-semibold",
                    done && !active
                      ? "border-brand-600 bg-brand-600 text-white"
                      : active
                        ? "border-brand-700 bg-brand-700 text-white"
                        : "border-gray-200 bg-white text-gray-400 group-hover:border-brand-200",
                  ].join(" ")}
                  animate={reduce ? undefined : { scale: active ? 1.06 : 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 22 }}
                >
                  {done && !active ? <Check size={16} strokeWidth={3} /> : n}
                  {active && !reduce && (
                    <span className="absolute -inset-1 rounded-full ring-4 ring-brand-500/15" aria-hidden="true" />
                  )}
                </motion.span>
                <span className="flex flex-col">
                  <span className={`text-sm font-semibold ${active ? "text-gray-900" : "text-gray-500"}`}>{s.label}</span>
                  <span className={`text-[11px] ${state === "completed" ? "text-brand-600" : active ? "text-brand-500" : "text-gray-400"}`}>
                    {stateLabel(state)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
