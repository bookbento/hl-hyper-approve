import * as React from "react";
import { Popover } from "antd";
import { FiCalendar, FiClock } from "react-icons/fi";

type Props = {
  value: string;                 // "YYYY-MM-DDTHH:mm" (local)
  onChange: (v: string) => void; // เซ็ตกลับค่าแบบเดียวกัน
  minNow?: boolean;              // กันเลือกย้อนหลัง
};

const pad = (n: number) => String(n).padStart(2, "0");
const toLocalStr = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export default function DateTimeInline({ value, onChange, minNow }: Props) {
  const [open, setOpen] = React.useState(false);

  // ❗ ใช้ Date | null แทนที่จะ fallback เป็น today
  const selected = React.useMemo<Date | null>(() => {
    if (!value) return null;
    const d = new Date(value); // parse local
    return Number.isFinite(+d) ? d : null;
  }, [value]);

  const todayDateStr = React.useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }, []);

  const setPart = (p: Partial<{ y: number; m: number; d: number; h: number; i: number }>) => {
    // ใช้ฐานจาก selected ถ้ามี ไม่งั้นเริ่มจาก "ตอนนี้" แต่จะเขียนค่าก็ต่อเมื่อมีวันที่แล้ว
    const base = selected ?? new Date();
    const nd = new Date(base);

    if (p.y !== undefined || p.m !== undefined || p.d !== undefined) {
      nd.setFullYear(p.y ?? nd.getFullYear(), p.m ?? nd.getMonth(), p.d ?? nd.getDate());
    }
    if (p.h !== undefined) nd.setHours(p.h);
    if (p.i !== undefined) nd.setMinutes(p.i);

    if (minNow && nd.getTime() < Date.now()) {
      const snap = new Date(Date.now() + 60_000);
      onChange(toLocalStr(snap));
    } else {
      onChange(toLocalStr(nd));
    }
  };

  const onDateChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const v = e.target.value; // "YYYY-MM-DD"
    if (!v) {
      // เคลียร์ค่าเมื่อผู้ใช้ลบวันที่ทิ้ง
      onChange("");
      return;
    }
    const [y, m, d] = v.split("-").map((n) => Number(n));
    setPart({ y, m: m - 1, d });
  };

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 60 }, (_, i) => i);

  // ถ้ายังไม่เลือก ให้เป็นสตริงว่าง -> ช่อง date จะแสดงว่าง
  const dateOnly = selected
    ? `${selected.getFullYear()}-${pad(selected.getMonth() + 1)}-${pad(selected.getDate())}`
    : "";

  const content = (
    <div className="w-[320px] p-3 space-y-3">
      <input
        type="date"
        className="w-full rounded-md border px-3 py-2"
        value={dateOnly}                 // 👉 ว่างได้
        onChange={onDateChange}
        min={minNow ? todayDateStr : undefined}
        placeholder="yyyy-mm-dd"
      />

      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-center gap-2">
          <FiClock className="h-4 w-4 opacity-70" />
          <select
            className="w-full rounded-md border px-2 py-1"
            value={selected ? selected.getHours() : ""}  // 👉 ว่างได้ถ้ายังไม่เลือกวัน
            onChange={(e) => setPart({ h: Number(e.target.value) })}
            disabled={!selected}                          // 👉 ปิดจนกว่าจะเลือกวัน
          >
            {!selected && <option value="">{/* placeholder */}--</option>}
            {hours.map((h) => (
              <option key={h} value={h}>{pad(h)}</option>
            ))}
          </select>
          :
          <select
            className="w-full rounded-md border px-2 py-1"
            value={selected ? selected.getMinutes() : ""} // 👉 ว่างได้ถ้ายังไม่เลือกวัน
            onChange={(e) => setPart({ i: Number(e.target.value) })}
            disabled={!selected}                           // 👉 ปิดจนกว่าจะเลือกวัน
          >
            {!selected && <option value="">{/* placeholder */}--</option>}
            {minutes.map((m) => (
              <option key={m} value={m}>{pad(m)}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded-md hover:bg-neutral-100"
            onClick={() => onChange("")}
          >
            Clear
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 hover:bg-neutral-50"
            onClick={() => setOpen(false)}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <Popover open={open} onOpenChange={setOpen} trigger="click" placement="bottomLeft" content={content}>
      <button
        type="button"
        className="w-full inline-flex items-center justify-between gap-2 rounded-md border border-neutral-300 bg-white px-4 py-2 hover:bg-neutral-50"
      >
        <span className="truncate">
          {value ? value.replace("T", " ") : "mm/dd/yyyy --:--"}
        </span>
        <FiCalendar className="h-4 w-4 opacity-60" />
      </button>
    </Popover>
  );
}

