// src/components/NotificationDropdown.tsx
import { useEffect, useState, useRef } from "react";
import axios from "axios";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";
import { Transition } from "@headlessui/react";
import { useNavigate } from "react-router-dom";
import { toSecureUploadUrl } from "../lib/files";
import BellToggle from "./reactbits/BellToggle/BellToggle";
import AnimatedList from "./reactbits/AnimatedList/AnimatedList";

const UNREAD_POLL_MS = 60_000;

/* ----------------------- เพิ่ม helper: Initials + Avatar ----------------------- */
const getInitials = (name?: string) => {
  if (!name) return "U";
  return name
    .trim()
    .split(/\s+/)
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
};

function UserAvatar({
  src,
  name,
  className = "",
}: {
  src?: string | null;
  name?: string;
  className?: string;
}) {
  const [err, setErr] = useState(false);

  if (src && !err) {
    return (
      <img
        src={src}
        alt={name || "avatar"}
        className={`${className} rounded-full border object-cover`}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setErr(true)}
      />
    );
  }

  // Fallback แบบเดียวกับ Navigation.tsx
  return (
    <div
      className={`${className} rounded-full bg-gradient-to-r from-[#00ffaa] to-[#00cc88] flex items-center justify-center font-bold text-gray-900`}
      aria-label={name || "avatar-initials"}
    >
      {getInitials(name)}
    </div>
  );
}
/* ----------------------------------------------------------------------------- */

interface Noti {
  id: number;
  isRead: boolean;
  createdAt: string;
  message: string;
  actor: {
    id: number;
    name: string;
    profileImageUrl?: string | null;
    profileImagePath?: string | null;
    profileImage?: string | null;
  };
  memo?: {
    id: number;
    subject: string;
    memonumber: string;
  };
  type: { name: string };
  status?: { name: string };
  comment?: { id: number; comment: string };
}

type Props = {
  mobile?: boolean;
  onItemClick?: () => void;
  bellClassName?: string;
};

const isNonEmptyStr = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

function getAvatarUrlFromActor(actor: any): string | null {
  const picked: string | null =
    [actor?.profileImageUrl, actor?.profileImagePath, actor?.profileImage].find(
      isNonEmptyStr
    ) ?? null;

  if (!picked) return null;

  let raw = picked.replace(/\\/g, "/");

  if (raw.startsWith("data:image/")) return raw;          // base64
  if (/^https?:\/\//i.test(raw)) return raw;              // absolute
  if (raw.startsWith("/uploads/")) return toSecureUploadUrl(raw) ?? raw;

  const path = raw.startsWith("profiles/") ? raw : `profiles/${raw}`;
  return toSecureUploadUrl(`/uploads/${path}`) ?? `/uploads/${path}`;
}

export default function NotificationDropdown({
  mobile = false,
  onItemClick,
  bellClassName = "",
}: Props) {
  const [list, setList] = useState<Noti[]>([]);
  const [show, setShow] = useState(false);
  const [unread, setUnread] = useState(0);
  const { t } = useTranslation("notifications");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [, force] = useState(0);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        show &&
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setShow(false);
      }
    }
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") setShow(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", onKeydown);
    };
  }, [show]);

  useEffect(() => {
    load();
  }, []);

  // Re-render relative times and check the unread count once a minute (only while
  // the tab is visible), so new notifications ring the bell without a reload.
  useEffect(() => {
    const id = setInterval(async () => {
      force((v) => v + 1);
      if (document.visibilityState !== "visible") return;
      try {
        const { data } = await axios.get<{ count: number }>("/api/notifications/unread-count", {
          withCredentials: true,
        });
        if (typeof data?.count === "number") setUnread(data.count);
      } catch {
        /* keep the last known count */
      }
    }, UNREAD_POLL_MS);
    return () => clearInterval(id);
  }, []);

  const load = async () => {
    const { data } = await axios.get(
      `/api/notifications?limit=50&_=${Date.now()}`,
      { withCredentials: true }
    );
    setList(data.items);
    setUnread(data.items.filter((n: Noti) => !n.isRead).length);
  };

  const handleNotiClick = async (n: Noti) => {
    try {
      await axios.patch(
        `/api/notifications/${n.id}/mark-read`,
        {},
        { withCredentials: true }
      );
      setList((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x))
      );
      setUnread((u) => Math.max(u - 1, 0));
    } catch {
      console.error("mark-read failed");
    }
    if (n.memo) navigate(`/memo/${n.memo.id}`);
    setShow(false);
    onItemClick?.();
  };

  const markAllRead = async () => {
    await axios.patch(
      "/api/notifications/mark-all-read",
      {},
      { withCredentials: true }
    );
    setList((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnread(0);
  };

  const clearAll = async () => {
    await axios.delete("/api/notifications/clear-read", {
      withCredentials: true,
    });
    const newList = list.filter((n) => !n.isRead);
    setList(newList);
    setUnread(newList.length);
  };

  const panelClass = mobile
    ? "absolute right-0 mt-2 w-[80vw] max-w-[380px] rounded-2xl border border-gray-100 bg-white/95 shadow-[0_24px_48px_-20px_rgba(11,31,27,0.45)] backdrop-blur z-[60] overflow-hidden"
    : "absolute right-0 mt-2 w-[420px] rounded-2xl border border-gray-100 bg-white/95 shadow-[0_24px_48px_-20px_rgba(11,31,27,0.45)] backdrop-blur z-[60] overflow-hidden";

  const visible = list.filter((n) => n.actor);

  return (
    <div ref={dropdownRef} className={`relative ${bellClassName}`}>
      {/* React Bits BellToggle: rings when opened, wobbles when the unread count rises.
          Icon-only: an unfurling label would reserve ~90px of dead, unclickable space in the navbar. */}
      <BellToggle
        size="sm"
        radius={18}
        label={t("title")}
        offLabel=""
        onLabel=""
        pressed={show}
        onChange={(open) => {
          setShow(open);
          if (open) load();
        }}
        count={unread}
        badgeWhenOff
        color="#7ef0c2"
        background="rgba(255,255,255,0.06)"
        onColor="#0b1f1b"
        onBackground="#7ef0c2"
        badgeColor="#ef4444"
        ringAmplitude={18}
      />

      <Transition
        as="div"
        show={show}
        enter="transform transition ease-out duration-200"
        enterFrom="-translate-y-2 opacity-0"
        enterTo="translate-y-0 opacity-100"
        leave="transform transition ease-in duration-200"
        leaveFrom="translate-y-0 opacity-100"
        leaveTo="-translate-y-2 opacity-0"
        className={`${panelClass} text-xs sm:text-sm`}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            {t("title")}
            {unread > 0 && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">
                {unread}
              </span>
            )}
          </span>
          <div className="flex items-center gap-1 text-xs">
            <button
              onClick={markAllRead}
              className="rounded-lg px-2 py-1 font-medium text-brand-600 transition-colors hover:bg-brand-50"
            >
              {t("markAll")}
            </button>
            <button
              onClick={clearAll}
              className="rounded-lg px-2 py-1 font-medium text-red-500 transition-colors hover:bg-red-50"
            >
              {t("clearAll")}
            </button>
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500">{t("noData")}</div>
        ) : (
          // React Bits AnimatedList: rows spring in, arrow keys move the selection, Enter opens.
          <AnimatedList
            theme="light"
            accentColor="#23805f"
            width="100%"
            maxHeight={mobile ? "55vh" : 440}
            radius={14}
            gap={6}
            animation="slide"
            stagger={0.03}
            className="p-2"
            items={visible.map((n) => ({
              id: n.id,
              icon: (
                <span className="relative">
                  <UserAvatar
                    src={getAvatarUrlFromActor(n.actor) ?? undefined}
                    name={n.actor.name}
                    className="h-9 w-9"
                  />
                  {!n.isRead && (
                    <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-red-500" />
                  )}
                </span>
              ),
              title: (
                <span className={n.isRead ? "text-gray-500" : "font-semibold text-brand-700"}>
                  {n.actor.name}: {n.message}
                </span>
              ),
              description: n.memo ? `${t("subjectLabel")}: ${n.memo.subject}` : undefined,
              meta: (
                <span
                  title={new Date(n.createdAt).toLocaleString("th-TH", {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                >
                  {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                </span>
              ),
            }))}
            onItemSelect={(_item, index) => {
              const n = visible[index];
              if (n) void handleNotiClick(n);
            }}
          />
        )}
      </Transition>
    </div>
  );
}
