type Props = { className?: string };

/**
 * Slow-moving blurred colour blobs (the look of React Bits' "Aurora" background)
 * done with CSS transforms instead of WebGL — no canvas, no extra dependency,
 * and it stops entirely with prefers-reduced-motion.
 */
export default function Aurora({ className = "" }: Props) {
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      <div
        className="rb-aurora-blob absolute -left-1/4 -top-1/4 h-[70%] w-[70%] rounded-full opacity-60 blur-3xl"
        style={{
          background: "radial-gradient(circle, #23805f 0%, transparent 65%)",
          animation: "rb-aurora-a 18s ease-in-out infinite",
        }}
      />
      <div
        className="rb-aurora-blob absolute -bottom-1/4 -right-1/4 h-[75%] w-[75%] rounded-full opacity-50 blur-3xl"
        style={{
          background: "radial-gradient(circle, #7ef0c2 0%, transparent 60%)",
          animation: "rb-aurora-b 22s ease-in-out infinite",
        }}
      />
      <div
        className="rb-aurora-blob absolute left-1/3 top-1/3 h-1/2 w-1/2 rounded-full opacity-40 blur-3xl"
        style={{
          background: "radial-gradient(circle, #3f9c7a 0%, transparent 60%)",
          animation: "rb-aurora-a 26s ease-in-out infinite reverse",
        }}
      />
      {/* fine grain so the gradient doesn't band */}
      <div
        className="absolute inset-0 opacity-[0.06] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
    </div>
  );
}
