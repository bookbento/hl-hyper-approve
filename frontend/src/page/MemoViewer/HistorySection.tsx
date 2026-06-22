// src/component/HistorySection.tsx
import React from "react";

/** ชนิดข้อมูลประวัติที่ใช้งานในคอมโพเนนต์ */
export type HistoryItem = {
  id: number | string;
  action?: string | null;
  timestamp?: string | number | Date | null;
};

type Props = {
  items: HistoryItem[];
  title?: React.ReactNode;
  formatTimestamp?: (ts: HistoryItem["timestamp"]) => string;
  className?: string;
  order?: "asc" | "desc"; // default: "desc" = ใหม่สุดอยู่บน
};

/** สีของ badge ต่อสถานะ (Tailwind) */
const commentStatusColor = {
  Approved:   { bg: "bg-green-100",   text: "text-green-700",   ring: "ring-1 ring-green-200" },
  "Approved With Conditions": { bg: "bg-green-100", text: "text-green-700", ring: "ring-1 ring-green-200" },
   Rejected:   { bg: "bg-orange-100",     text: "text-orange-700",     ring: "ring-1 ring-orange-200" },
  Processing: { bg: "bg-yellow-100",  text: "text-yellow-700",  ring: "ring-1 ring-yellow-200" },
  Recalled:   { bg: "bg-sky-100",     text: "text-sky-700",     ring: "ring-1 ring-sky-200" },
  Terminated: { bg: "bg-orange-200",  text: "text-orange-600",  ring: "ring-1 ring-orange-300" },
  DRAFT:      { bg: "bg-slate-100",   text: "text-slate-700",   ring: "ring-1 ring-slate-200" },
  REVISE:     { bg: "bg-indigo-100",  text: "text-indigo-700",  ring: "ring-1 ring-indigo-200" },
  Commented:  { bg: "bg-fuchsia-300", text: "text-fuchsia-700", ring: "ring-1 ring-fuchsia-200" },
  Edited:     { bg: "bg-lime-200",    text: "text-lime-900",    ring: "ring-1 ring-lime-300" },
  Expiring: { bg: "bg-yellow-100", text: "text-yellow-700", ring: "ring-1 ring-yellow-200" },
  Expired:  { bg: "bg-rose-100",   text: "text-rose-700",   ring: "ring-1 ring-rose-200" },
  Extra:    { bg: "bg-teal-100",   text: "text-teal-700",   ring: "ring-1 ring-teal-200" },
} as const;
type StatusKey = keyof typeof commentStatusColor;


const DETECTORS: Array<{ key: StatusKey; re: RegExp }> = [
  { key: "Extra", re: /\bextra\b/i },
  { key: "Rejected", re: /\b(?:not\s+approved|unapproved|disapproved|declined|denied)\b/i },
  { key: "Rejected", re: /\b(?:reject(?:ed|s)?|decline(?:d|s)?|den(y|ied|ies|ying))\b/i },
  { key: "Rejected", re: /ไม่อนุมัติ|ปฏิเสธ/i },

  // Terminated / Cancelled
  { key: "Terminated", re: /\b(?:terminate(?:d|s)?|cancell?ed|cancell?ation)\b/i },
  { key: "Terminated", re: /ยุติ|ยกเลิก/i },

  // Recalled / Withdraw
  { key: "Recalled", re: /\brecall(?:ed|s)?\b|\bwithdraw(?:n|s|ing)?\b/i },
  { key: "Recalled", re: /เรียกคืน/i },

  // DRAFT
  { key: "DRAFT", re: /\bsaved\s+as\s+draft\b|\bdraft(?:ed)?\b/i },
  { key: "DRAFT", re: /ฉบับร่าง|แบบร่าง/i },

  // REVISE
  { key: "REVISE", re: /\brevis(?:e|ed|es|ing|ion)\b/i },
  { key: "REVISE", re: /ปรับแก้/i },

  // Approved
  { key: "Approved", re: /\bapprov(?:e|ed|es)\b/i },
  { key: "Approved", re: /อนุมัติ/i },

  // Processing / Publish / Issue
  { key: "Processing", re: /\bprocessing\b|\bin\s+progress\b|\bsubmit(?:ted|s)?\b/i },
  { key: "Processing", re: /\bpublish(?:ed|es)?\b|\bissue(?:d|s)?\b/i },
  { key: "Processing", re: /กำลังดำเนินการ|เผยแพร่|ออกประกาศ/i },

  // Commented
  { key: "Commented", re: /\bcomment(?:ed|s|ing)?\b|\brepl(?:y|ied|ies|ying)\b/i },
  { key: "Commented", re: /คอมเมนต์|แสดงความคิดเห็น|ตอบกลับ/i },

  // Edited (แยกจาก revise)
  { key: "Edited", re: /\bedit(?:ed|s|ing)?\b|\bupdate(?:d|s|ing)?\b|\bmodif(?:y|ied|ies|ying)\b/i },
  { key: "Edited", re: /แก้ไข|ปรับปรุง/i },
];




const EXPIRY_TAG_RE = /\[expiry:(?:expired|3d-\d+:\d{4}-\d{2}-\d{2})\]/i;
const EXPIRY_WORD_RE = /\bexpir(?:e|ed|ing)\b/i;

function renderActionInline(action?: string | null): React.ReactNode {
  let text = String(action ?? "");

  // ลบแท็กระบบออกก่อนโชว์
  const tag = text.match(EXPIRY_TAG_RE)?.[0];
  if (tag) text = text.replace(tag, "").trim();

  // แยกชื่อคนออกมา (รูปแบบ: "ชื่อ (ชื่อเล่น)" หรือ "ชื่อ")
  // ชื่อจะอยู่ก่อนคำกริยา เช่น Approved, Rejected, etc.
  const nameMatch = text.match(/^([^(]+?)(\s*\([^)]+\))?\s+(?:Approved|Rejected|Terminated|Recalled|commented|edited|submitted|published|issued)/i);
  
  if (nameMatch) {
    const fullName = nameMatch[1].trim();
    const nickname = nameMatch[2] || ""; // ชื่อเล่นในวงเล็บ (ถ้ามี)
    const fullNamePart = fullName + nickname;
    const restOfText = text.slice(nameMatch[0].length - nameMatch[0].match(/(?:Approved|Rejected|Terminated|Recalled|commented|edited|submitted|published|issued).*/i)?.[0].length!);
    
    // ครอบเฉพาะคำ expire/expired/expiring ด้วย badge
    const m = EXPIRY_WORD_RE.exec(restOfText);
    if (m) {
      const word = m[0];
      const badgeKey = /ed$/i.test(word) ? "Expired" : "Expiring";
      const colors = commentStatusColor[badgeKey as keyof typeof commentStatusColor];
      const start = m.index, end = start + word.length;
      return (
        <>
          <span className="font-semibold">{fullNamePart}</span>
          {" "}
          {restOfText.slice(0, start)}
          <span
            className={[
              "mx-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium align-baseline",
              colors.bg, colors.text, colors.ring,
            ].join(" ")}
            title={badgeKey}
          >
            {word}
          </span>
          {restOfText.slice(end)}
        </>
      );
    }

    // หาตำแหน่ง "(with condition:" เพื่อข้าม badge ที่อยู่ในส่วน condition
    const conditionStart = restOfText.indexOf("(with condition:");

    // ถ้าไม่ใช่เคส expire ก็ใช้ดีเทกเตอร์เดิม
    for (const { key, re } of DETECTORS) {
      const mm = re.exec(restOfText);
      if (mm) {
        // ถ้าคำที่ match อยู่ภายใน "(with condition: ...)" ให้ข้ามไป ไม่ใส่ badge
        if (conditionStart >= 0 && mm.index >= conditionStart) continue;

        // ถ้าเป็น Approved + มี "(with condition:" → แสดง badge "Approved With Conditions"
        const badgeLabel = (key === "Approved" && conditionStart >= 0)
          ? "Approved With Conditions" as const
          : key;
        const colors = commentStatusColor[badgeLabel];
        const start = mm.index, end = start + mm[0].length;
        return (
          <>
            <span className="font-semibold">{fullNamePart}</span>
            {" "}
            {restOfText.slice(0, start)}
            <span
              className={[
                "mx-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium align-baseline",
                colors.bg, colors.text, colors.ring,
              ].join(" ")}
              title={mm[0]}
            >
              {badgeLabel}
            </span>
            {restOfText.slice(end)}
          </>
        );
      }
    }
    
    return (
      <>
        <span className="font-semibold">{fullNamePart}</span>
        {" "}
        {restOfText}
      </>
    );
  }

  // ถ้าไม่เจอชื่อ ใช้โค้ดเดิม
  // ครอบเฉพาะคำ expire/expired/expiring ด้วย badge
  const m = EXPIRY_WORD_RE.exec(text);
  if (m) {
    const word = m[0];
    const badgeKey = /ed$/i.test(word) ? "Expired" : "Expiring";
    const colors = commentStatusColor[badgeKey as keyof typeof commentStatusColor];
    const start = m.index, end = start + word.length;
    return (
      <>
        {text.slice(0, start)}
        <span
          className={[
            "mx-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium align-baseline",
            colors.bg, colors.text, colors.ring,
          ].join(" ")}
          title={badgeKey}
        >
          {word}
        </span>
        {text.slice(end)}
      </>
    );
  }

  // หาตำแหน่ง "(with condition:" เพื่อข้าม badge ที่อยู่ในส่วน condition
  const conditionStart = text.indexOf("(with condition:");
  
  // ตรวจจับ terminate reason (รูปแบบ: "User terminated the memo: reason")
  const terminateMatch = text.match(/terminated the memo:\s*(.+)/i);
  if (terminateMatch) {
    const reason = terminateMatch[1].trim();
    const beforeReason = text.substring(0, terminateMatch.index! + "terminated the memo".length);
    const colors = commentStatusColor["Terminated"];
    
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {beforeReason}
          <span
            className={[
              "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
              colors.bg, colors.text, colors.ring,
            ].join(" ")}
          >
            Terminated
          </span>
        </div>
        {reason && (
          <div className="ml-4 pl-3 border-l-2 border-orange-300 text-sm text-gray-600 italic">
            <span className="font-medium text-orange-700">Reason:</span> {reason}
          </div>
        )}
      </div>
    );
  }

  // ตรวจจับ reject reason (รูปแบบ: "User rejected the memo: reason" หรือ "needs revised: reason")
  const rejectMatch = text.match(/(?:rejected|needs revised)(?:\s+the\s+memo)?:\s*(.+)/i);
  if (rejectMatch) {
    const reason = rejectMatch[1].trim();
    const beforeReason = text.substring(0, rejectMatch.index! + rejectMatch[0].indexOf(':'));
    const colors = commentStatusColor["Rejected"];
    
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {beforeReason}
          <span
            className={[
              "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
              colors.bg, colors.text, colors.ring,
            ].join(" ")}
          >
            Needs Revised
          </span>
        </div>
        {reason && (
          <div className="ml-4 pl-3 border-l-2 border-orange-300 text-sm text-gray-600 italic">
            <span className="font-medium text-orange-700">Reason:</span> {reason}
          </div>
        )}
      </div>
    );
  }

  // ถ้าไม่ใช่เคส expire ก็ใช้ดีเทกเตอร์เดิม
  for (const { key, re } of DETECTORS) {
    const mm = re.exec(text);
    if (mm) {
      // ถ้าคำที่ match อยู่ภายใน "(with condition: ...)" ให้ข้ามไป ไม่ใส่ badge
      if (conditionStart >= 0 && mm.index >= conditionStart) continue;

      // ถ้าเป็น Approved + มี "(with condition:" → แสดง badge "Approved With Conditions"
      const badgeLabel = (key === "Approved" && conditionStart >= 0)
        ? "Approved With Conditions" as const
        : key;
      const colors = commentStatusColor[badgeLabel];
      const start = mm.index, end = start + mm[0].length;
      return (
        <>
          {text.slice(0, start)}
          <span
            className={[
              "mx-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium align-baseline",
              colors.bg, colors.text, colors.ring,
            ].join(" ")}
            title={mm[0]}
          >
            {badgeLabel}
          </span>
          {text.slice(end)}
        </>
      );
    }
  }
  return text;
}


const HistorySection: React.FC<Props> = ({
  items,
  title = "History",
  formatTimestamp,
  className,
  order = "desc",
}) => {
  const sortedItems = React.useMemo(() => {
    const toMs = (ts: HistoryItem["timestamp"]) => {
      if (ts == null) return Number.NaN;
      const n = new Date(ts as any).getTime();
      return Number.isNaN(n) ? Number.NaN : n;
    };
    return [...items].sort((a, b) => {
      const A = toMs(a.timestamp);
      const B = toMs(b.timestamp);
      if (Number.isNaN(A) && Number.isNaN(B)) return 0;
      if (Number.isNaN(A)) return 1;
      if (Number.isNaN(B)) return -1;
      return order === "asc" ? A - B : B - A;
    });
  }, [items, order]);

  return (
    <section className={className}>
      <div className="flex flex-col flex-1 min-h-0 h-full justify-between gap-4">
        <h2 className="text-white bg-[#183E33] rounded-t-lg p-3 font-semibold">
          {title}
        </h2>

        <ul className="space-y-3">
          {sortedItems.map((h) => {
            const full = String(h?.action ?? "");
            const time =
              h?.timestamp != null
                ? formatTimestamp
                  ? formatTimestamp(h.timestamp)
                  : new Date(h.timestamp as any).toLocaleString()
                : "";

            const renderedAction = renderActionInline(full);
            const isMultiLine = React.isValidElement(renderedAction) && 
                               renderedAction.type === 'div' && 
                               (renderedAction.props as any)?.className?.includes('flex-col');

            return (
              <li
                key={String(h.id)}
                className="p-4 bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow"
              >
                {/* Date in first line - top right */}
                <div className="flex justify-end mb-2">
                  <span className="text-xs text-gray-500">
                    {time}
                  </span>
                </div>

                {/* Content in second line - full width */}
                <div className="w-full">
                  <span className="text-sm text-gray-700 break-words">
                    {renderedAction}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
};
export default HistorySection;
