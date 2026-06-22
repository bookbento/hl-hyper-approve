// src/components/NotificationDropdown.tsx
import { useEffect, useState, useRef } from "react";
import axios from "axios";
import { Bell } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";
import { Transition } from "@headlessui/react";
import { useNavigate } from "react-router-dom";
import { toSecureUploadUrl } from "../lib/files";

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

  useEffect(() => {
    const id = setInterval(() => force((v) => v + 1), 60_000);
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
    ? "absolute right-0 mt-2 w-[70vw] max-w-[380px] max-h-[60vh] bg-white shadow-lg rounded-lg overflow-y-auto z-[60] "
    : "absolute right-0 mt-2 w-[420px] max-h-[500px] bg-white shadow-lg rounded-lg overflow-y-auto z-[60]";

  return (
    <div ref={dropdownRef} className={`relative ${mobile ? "" : ""}`}>
      <button
        onClick={() => {
          setShow((s) => !s);
          if (!show) load();
        }}
        className={`relative px-2 py-1 text-gray-200 hover:text-white rounded-md hover:bg-[#00ffaa]/10 ${bellClassName}`}
        aria-haspopup="menu"
        aria-expanded={show}
      >
        <Bell className="h-5 w-5 text-green-300 animate-pulse" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 px-1.5 py-0.5 text-xs font-bold text-white bg-red-600 rounded-full">
            {unread}
          </span>
        )}
      </button>

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
        <div className="flex justify-between items-center px-3 sm:px-4 py-2 border-b font-semibold text-gray-800 sticky top-0 bg-white/90 backdrop-blur text-sm sm:text-base">
          <span>{t("title")}</span>
          <div className="space-x-3 text-xs sm:text-sm text-blue-500">
            <button onClick={markAllRead} className="hover:underline">
              {t("markAll")}
            </button>
            <button onClick={clearAll} className="hover:underline text-red-500">
              {t("clearAll")}
            </button>
          </div>
        </div>

        {list.length === 0 ? (
          <div className="p-3 sm:p-4 text-sm text-gray-500 text-center">
            {t("noData")}
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {list.map((n) => {
              if (!n.actor) return null;

              const actorAvatar = getAvatarUrlFromActor(n.actor); // อาจเป็น null
              return (
                <li
                  key={n.id}
                  onClick={() => handleNotiClick(n)}
                  className={`p-3 sm:p-4 cursor-pointer transition ${
                    n.isRead ? "opacity-50 bg-gray-100" : "hover:bg-gray-50"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* ใช้ Avatar แบบเดียวกับ Navigation.tsx */}
                    <UserAvatar
                      src={actorAvatar ?? undefined}
                      name={n.actor.name}
                      className="w-9 h-9 sm:w-10 sm:h-10"
                    />

                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] sm:text-sm font-semibold text-[#183e33] truncate">
                        {n.actor.name}: {n.message}
                      </p>
                      {n.memo && (
                        <p className="text-[12px] sm:text-sm text-gray-700 truncate">
                          {t("subjectLabel")}: {n.memo.subject}
                        </p>
                      )}
                      <p className="text-[11px] sm:text-xs text-gray-400">
                        Notified at{" "}
                        {new Date(n.createdAt).toLocaleString("th-TH", {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </p>
                      <p className="text-[11px] sm:text-xs text-gray-400">
                        (
                        {formatDistanceToNow(new Date(n.createdAt), {
                          addSuffix: true,
                        })}
                        )
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Transition>
    </div>
  );
}
