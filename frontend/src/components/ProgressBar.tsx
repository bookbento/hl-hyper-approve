interface Props { total: number; done: number }
export default function ProgressBar({ total, done }: Props) {
  const pct = (done / total) * 100;
  return (
    <div className="relative w-56 h-3 bg-gray-200 rounded-full overflow-hidden">
      <div
        style={{ width: `${pct}%` }}
        className="absolute inset-0 bg-emerald-500 transition-all"
      />
      <span className="absolute inset-0 flex items-center justify-center text-xs text-white font-medium">
        Level of Approval {done} / {total}
      </span>
    </div>
  );
}