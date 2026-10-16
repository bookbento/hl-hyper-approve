import type { ReactNode } from "react";
import toast from "react-hot-toast";
import HoldButton from "../reactbits/HoldButton/HoldButton";

type Props = {
  children: ReactNode;
  /** shown after the hold completes */
  doneLabel?: ReactNode;
  onConfirm: () => void | Promise<void>;
  tone?: "danger" | "warning";
  size?: "sm" | "md" | "lg";
  holdTime?: number;
  disabled?: boolean;
  /** shown when the button is only tapped */
  tapHint?: string;
  /** icon-only button (table rows); `label` becomes its accessible name */
  compact?: boolean;
  label?: string;
};

const TONES = {
  danger: { bg: "#fef2f2", fill: "#dc2626", text: "#b91c1c" },
  warning: { bg: "#fffbeb", fill: "#d97706", text: "#b45309" },
};

/**
 * Hold-to-confirm for destructive actions (React Bits HoldButton), replacing
 * the browser's confirm() dialog. A quick tap only shows a hint.
 */
export default function HoldToConfirm({
  children,
  doneLabel,
  onConfirm,
  tone = "danger",
  size = "sm",
  holdTime = 1200,
  disabled,
  tapHint = "Press and hold to confirm",
  compact = false,
  label,
}: Props) {
  const c = TONES[tone];
  const content = compact ? (
    <span className="inline-flex items-center" title={label}>
      <span aria-hidden="true" className="inline-flex">{children}</span>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  ) : (
    children
  );
  return (
    <span className={compact ? "inline-flex [&_button]:!px-2.5" : "inline-flex"}>
      <HoldButton
        size={size}
        holdTime={holdTime}
        disabled={disabled}
        backgroundColor={c.bg}
        fillColor={c.fill}
        textColor={c.text}
        fillTextColor="#ffffff"
        doneLabel={doneLabel ?? content}
        radius={10}
        onHold={() => void onConfirm()}
        onTap={() => toast(tapHint, { duration: 2500 })}
      >
        {content}
      </HoldButton>
    </span>
  );
}
