import { Toaster, resolveValue, toast } from "react-hot-toast";
import type { Toast } from "react-hot-toast";
import { CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import SwipeToast from "../reactbits/SwipeToast/SwipeToast";

// react-hot-toast still queues, stacks and updates toasts (every existing toast.*
// call keeps working); React Bits SwipeToast draws them and owns the timeout
// (burning fuse, pause on hover, swipe down to dismiss).
const DEFAULT_MS: Record<Toast["type"], number> = {
  success: 3000,
  error: 5000,
  blank: 4000,
  custom: 4000,
  loading: 0, // stays until the promise settles / the caller updates it
};

function iconFor(t: Toast) {
  if (t.icon) return t.icon;
  switch (t.type) {
    case "success":
      return <CheckCircle2 size={18} className="text-[#7ef0c2]" />;
    case "error":
      return <XCircle size={18} className="text-red-400" />;
    case "loading":
      return <Loader2 size={18} className="animate-spin text-white/70" />;
    default:
      return <Info size={18} className="text-white/70" />;
  }
}

export default function AppToaster() {
  return (
    // duration: Infinity → react-hot-toast never dismisses on its own; SwipeToast's fuse does.
    <Toaster position="bottom-right" gutter={10} toastOptions={{ duration: Infinity }}>
      {(t) => (
        <div style={{ width: "min(360px, calc(100vw - 32px))" }}>
          <SwipeToast
            inline
            open={t.visible}
            title={resolveValue(t.message, t)}
            icon={iconFor(t)}
            duration={
              t.type === "loading"
                ? 0
                : Number.isFinite(t.duration)
                  ? (t.duration as number)
                  : DEFAULT_MS[t.type]
            }
            background="#0b1f1b"
            color="#f5f5f5"
            fuseColor={t.type === "error" ? "#f87171" : "#7ef0c2"}
            radius={14}
            onClose={() => toast.dismiss(t.id)}
          />
        </div>
      )}
    </Toaster>
  );
}
