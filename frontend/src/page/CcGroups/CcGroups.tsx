import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import axios from "axios";
import toast from "react-hot-toast";
import { api } from "../../lib/api";
import { toSecureUploadUrl } from "../../lib/files";
import {
  FiUsers,
  FiPlus,
  FiEdit2,
  FiTrash2,
  FiX,
  FiSearch,
} from "react-icons/fi";
// @ts-ignore
import { Listbox } from "@headlessui/react";
import {
  BiChevronDown,
  BiSolidChevronDown,
  BiSolidChevronUp,
} from "react-icons/bi";
import { useNavigate } from "react-router-dom";
import AdminLogModal from "../../components/AdminLogModal";
import UnauthorizedAccess from "../../components/UnauthorizedAccess";

/* ---------------- Types ---------------- */
type IdName = { id: number; name: string };

interface User {
  id: number;
  name: string;
  lastname?: string | null;
  nickname?: string | null;
  email: string;
  profileImage?: string | null;
  profileImagePath?: string | null;
  profileImageUrl?: string | null;
  department?: { id: number; name: string };
  businessUnit?: { id: number; name: string };
}

interface MeRes {
  id: number;
  name: string;
  email: string;
  role: string;
  roles?: string[];
}

interface CcGroupSummary {
  id: number;
  name: string;
  memberCount: number;
  members?: User[]; // เพิ่ม members เพื่อแสดงรายชื่อ
}

interface CcGroupDetail {
  id: number;
  name: string;
  members: User[];
}

/* --------------- Helpers --------------- */
function getAvatarUrl(u: User): string | null {
  let raw: string | null =
    (u.profileImageUrl as any) ??
    (u.profileImagePath as any) ??
    (u.profileImage as any) ??
    null;
  if (!raw) return null;
  raw = raw.replace(/\\/g, "/");
  if (raw.startsWith("data:image/")) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/uploads/")) return toSecureUploadUrl(raw)!;
  const path = raw.startsWith("profiles/") ? raw : `profiles/${raw}`;
  return toSecureUploadUrl(`/uploads/${path}`);
}

const PAGE_SIZE_OPTIONS = [
  ...Array.from({ length: 6 }, (_, i) => 50 + i * 10),
  0,
]; // 0 = All

/* --------------- Member Pill Component --------------- */
const MemberPill = React.memo(({
  member,
  t,
  searchTerm,
  groupId,
  onRemove
}: {
  member: User;
  t: any;
  searchTerm?: string;
  groupId?: number;
  onRemove?: (memberId: number) => void;
}) => {
  const fullName = [member.name, member.lastname].filter(Boolean).join(" ");
  const displayText = member.nickname
    ? `${fullName} (${member.nickname})`
    : fullName;

  const handleRemove = React.useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRemove) {
      onRemove(member.id);
    }
  }, [onRemove, member.id]);

  return (
    <div className="relative group inline-flex items-center gap-2 px-3 py-1 bg-gray-50 border border-gray-200 rounded-full text-sm hover:bg-gray-100 transition-colors cursor-default">

      <span className="text-gray-700 whitespace-nowrap">
        {member.name} {member.lastname}
      </span>

      {/* ปุ่มลบ */}
      {onRemove && (
        <button
          onClick={handleRemove}
          className="ml-1 rounded-full hover:bg-red-100 p-0.5 text-gray-400 hover:text-red-600 transition-colors"
          title={t("member.remove", { defaultValue: "Remove" }) as string}
        >
          <FiX size={14} />
        </button>
      )}

      {/* Custom Tooltip */}
      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none z-10 shadow-lg">
        {displayText}
        <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1 border-4 border-transparent border-t-gray-900"></div>
      </div>
    </div>
  );
});

MemberPill.displayName = "MemberPill";

/* --------------- User Dropdown Item Component --------------- */
const UserDropdownItem = React.memo(({ user, onClick }: { user: User; onClick: () => void }) => {
  const fullName = [user.name, user.lastname].filter(Boolean).join(" ");
  const displayName = user.nickname
    ? `${fullName} (${user.nickname})`
    : fullName;
  const avatarUrl = React.useMemo(() => getAvatarUrl(user), [user]);
  const [imgError, setImgError] = React.useState(false);
  const firstLetter = React.useMemo(
    () => user.name?.[0]?.toUpperCase?.() || "U",
    [user.name]
  );

  const handleImageError = React.useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const target = e.currentTarget;
    if (target.src !== "/img/default-avatar.png") {
      target.src = "/img/default-avatar.png";
      setImgError(true);
    }
  }, []);

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0"
      onClick={onClick}
    >
      <div className="h-10 w-10 rounded-full overflow-hidden border bg-gray-100 flex-shrink-0">
        {avatarUrl && !imgError ? (
          <img
            src={avatarUrl}
            alt={user.name}
            className="h-full w-full object-cover"
            loading="lazy"
            onError={handleImageError}
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-sm font-semibold text-gray-400">
            {firstLetter}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">
          {user.email}
        </div>
        <div className="text-xs text-gray-500 truncate">
          {displayName}
        </div>
      </div>
    </div>
  );
});

UserDropdownItem.displayName = "UserDropdownItem";

/* --------------- Available User Item Component (for modal) --------------- */
const AvailableUserItem = React.memo(({
  user,
  onAdd
}: {
  user: User;
  onAdd: (user: User) => void;
}) => {
  const avatarUrl = React.useMemo(() => getAvatarUrl(user), [user]);
  const [imgError, setImgError] = React.useState(false);
  const firstLetter = React.useMemo(
    () => user.name?.[0]?.toUpperCase?.() || "U",
    [user.name]
  );

  const handleImageError = React.useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const target = e.currentTarget;
    if (target.src !== "/img/default-avatar.png") {
      target.src = "/img/default-avatar.png";
      setImgError(true);
    }
  }, []);

  const handleAdd = React.useCallback(() => {
    onAdd(user);
  }, [onAdd, user]);

  const fullName = React.useMemo(() =>
    [user.name, user.lastname].filter(Boolean).join(" "),
    [user.name, user.lastname]
  );

  return (
    <div className="py-2 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="h-9 w-9 rounded-full overflow-hidden border bg-gray-100 flex-shrink-0">
          {avatarUrl && !imgError ? (
            <img
              src={avatarUrl}
              alt={user.name}
              className="h-full w-full object-cover"
              loading="lazy"
              onError={handleImageError}
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-gray-400">
              {firstLetter}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900 truncate">
            {fullName}{" "}
            {user.nickname ? (
              <span className="text-gray-500">({user.nickname})</span>
            ) : null}
          </div>
          <div className="text-xs text-gray-500 truncate">{user.email}</div>
        </div>
      </div>

      <button
        type="button"
        onClick={handleAdd}
        className="px-3 py-1 text-xs font-medium rounded-full bg-[#183e33] text-white hover:bg-[#141716] whitespace-nowrap"
      >
        Add
      </button>
    </div>
  );
});

AvailableUserItem.displayName = "AvailableUserItem";

/* --------------- Selected User Chip Component (for modal) --------------- */
const SelectedUserChip = React.memo(({
  user,
  onRemove,
  t
}: {
  user: User;
  onRemove: (id: number) => void;
  t: any;
}) => {
  const avatarUrl = React.useMemo(() => getAvatarUrl(user), [user]);
  const [imgError, setImgError] = React.useState(false);

  const handleImageError = React.useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const target = e.currentTarget;
    if (target.src !== "/img/default-avatar.png") {
      target.src = "/img/default-avatar.png";
      setImgError(true);
    }
  }, []);

  const handleRemove = React.useCallback(() => {
    onRemove(user.id);
  }, [onRemove, user.id]);

  const displayName = React.useMemo(() => {
    if (user.nickname) {
      return `${user.name} (${user.nickname})`;
    }
    return [user.name, user.lastname].filter(Boolean).join(" ");
  }, [user.name, user.lastname, user.nickname]);

  return (
    <span
      className="inline-flex items-center gap-2 pl-1 pr-2 py-1 rounded-full bg-emerald-50 text-emerald-900 border border-emerald-200"
      title={user.email}
    >
      {avatarUrl && !imgError ? (
        <img
          src={avatarUrl}
          alt={user.name}
          className="h-6 w-6 rounded-full object-cover border"
          loading="lazy"
          onError={handleImageError}
        />
      ) : (
        <div className="h-6 w-6 rounded-full bg-gray-200 flex items-center justify-center text-xs font-semibold text-gray-500 border">
          {user.name?.[0]?.toUpperCase?.() || "U"}
        </div>
      )}
      <span className="text-xs font-medium">{displayName}</span>
      <button
        type="button"
        onClick={handleRemove}
        className="ml-1 rounded-full hover:bg-emerald-200 p-0.5"
        aria-label="Remove"
        title={t("member.remove", { defaultValue: "Remove" }) as string}
      >
        <FiX />
      </button>
    </span>
  );
});

SelectedUserChip.displayName = "SelectedUserChip";

/* --------------- Component --------------- */
const CcGroups: React.FC = () => {
  const { t } = useTranslation("ccgroups");
  // ใช้ namespace ใหม่ ถ้าไม่มีจะ fallback ลง defaultValue
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [groups, setGroups] = useState<CcGroupSummary[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [sortAsc, setSortAsc] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [memberSearchTerm, setMemberSearchTerm] = useState(""); // ค้นหาสมาชิก
  const [showMemberDropdown, setShowMemberDropdown] = useState(false); // แสดง dropdown
  const memberSearchRef = useRef<HTMLDivElement>(null); // ref สำหรับ dropdown
  const navigate = useNavigate();
  // modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editGroupId, setEditGroupId] = useState<number | null>(null);
  const [groupName, setGroupName] = useState("");
  const [selectedUsers, setSelectedUsers] = useState<User[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [showLogModal, setShowLogModal] = useState(false);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [addMemberGroupId, setAddMemberGroupId] = useState<number | null>(null);
  const [addMemberSearch, setAddMemberSearch] = useState("");
  const [showRemoveMemberConfirm, setShowRemoveMemberConfirm] = useState(false);
  const [removeMemberData, setRemoveMemberData] = useState<{
    groupId: number;
    memberId: number;
    groupName: string;
  } | null>(null);
  const [showAddMemberConfirm, setShowAddMemberConfirm] = useState(false);
  const [addMemberData, setAddMemberData] = useState<{
    groupId: number;
    user: User;
    groupName: string;
  } | null>(null);
  const [selectedUsersToAdd, setSelectedUsersToAdd] = useState<User[]>([]); // เลือกหลายคน

  // New States for Bulk Update & Show Edited
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<number>>(new Set());
  const [selectedFromUser, setSelectedFromUser] = useState<User | null>(null);
  const [fromUserSearchTerm, setFromUserSearchTerm] = useState("");
  const [showFromUserDropdown, setShowFromUserDropdown] = useState(false);
  const fromUserSearchRef = useRef<HTMLDivElement>(null);
  
  const [replaceMemberSearchTerm, setReplaceMemberSearchTerm] = useState("");
  const [showReplaceMemberDropdown, setShowReplaceMemberDropdown] = useState(false);
  const replaceMemberSearchRef = useRef<HTMLDivElement>(null);
  
  const [isBulkUpdateModalOpen, setIsBulkUpdateModalOpen] = useState(false);
  const [bulkUpdateAction, setBulkUpdateAction] = useState<"replace" | "remove">("replace");
  const [selectedNewUser, setSelectedNewUser] = useState<User | null>(null);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  
  const [editedGroupIds, setEditedGroupIds] = useState<Set<number>>(new Set());

  // pagination (list groups)
  const [pageSize, setPageSize] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSizeBeforeSearchRef = useRef<number>(50);

  const isSearching = searchTerm.trim().length > 0 || memberSearchTerm.trim().length > 0;
  const isAll = pageSize === 0;

  // รายชื่อผู้ใช้ที่ตรงกับการค้นหา
  const matchedUsers = useMemo(() => {
    const q = memberSearchTerm.trim().toLowerCase();
    if (!q) return [];

    return users
      .filter((u) => {
        const searchableText = [
          u.name,
          u.lastname,
          u.nickname,
          u.email,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return searchableText.includes(q);
      })
      .slice(0, 50); // จำกัด 50 คน
  }, [users, memberSearchTerm]);

  const matchedFromUsers = useMemo(() => {
    const q = fromUserSearchTerm.trim().toLowerCase();
    if (!q) return [];
    return users
      .filter((u) => {
        const searchableText = [u.name, u.lastname, u.nickname, u.email]
          .filter(Boolean).join(" ").toLowerCase();
        return searchableText.includes(q);
      })
      .slice(0, 50);
  }, [users, fromUserSearchTerm]);

  const matchedReplaceUsers = useMemo(() => {
    const q = replaceMemberSearchTerm.trim().toLowerCase();
    if (!q) return [];
    return users
      .filter((u) => {
        const searchableText = [u.name, u.lastname, u.nickname, u.email]
          .filter(Boolean).join(" ").toLowerCase();
        return searchableText.includes(q);
      })
      .slice(0, 50);
  }, [users, replaceMemberSearchTerm]);

  // ปิด dropdown เมื่อคลิกข้างนอก
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        memberSearchRef.current &&
        !memberSearchRef.current.contains(event.target as Node)
      ) {
        setShowMemberDropdown(false);
      }
      if (
        fromUserSearchRef.current &&
        !fromUserSearchRef.current.contains(event.target as Node)
      ) {
        setShowFromUserDropdown(false);
      }
      if (
        replaceMemberSearchRef.current &&
        !replaceMemberSearchRef.current.contains(event.target as Node)
      ) {
        setShowReplaceMemberDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  /* -------- Load initial data -------- */
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        // Check permissions first
        const { data: meRes } = await axios.get<MeRes>("/api/me", {
          withCredentials: true,
        });
        if (!alive) return;

        const roles = meRes.roles || [meRes.role];
        const hasRole = (target: string) =>
          roles.some((r) => (r ?? "").toUpperCase() === target);
        const isAdminOrDcc = hasRole("ADMIN") || hasRole("DCC");

        if (!isAdminOrDcc) {
          setBlocked(true);
          setLoading(false);
          return;
        }

        const [gRes, uRes] = await Promise.all([
          api.get("/api/cc-groups"),
          api.get("/api/users"),
        ]);

        const gs: any[] = Array.isArray(gRes.data) ? gRes.data : [];

        // รองรับทั้ง {id,name,memberCount} หรือ {id,name,members:[...]}
        const normalized: CcGroupSummary[] = gs.map((g) => ({
          id: g.id,
          name: g.name,
          memberCount: Array.isArray(g.members)
            ? g.members.length
            : g.memberCount ?? 0,
          members: Array.isArray(g.members) ? g.members : [], // เก็บข้อมูล members ไว้แสดง
        }));

        const us: User[] = (Array.isArray(uRes.data) ? uRes.data : []).map(
          (u: any) => ({
            id: u.id,
            name: u.name,
            lastname: u.lastname,
            nickname: u.nickname,
            email: u.email,
            profileImage: u.profileImage,
            profileImagePath: u.profileImagePath,
            profileImageUrl: u.profileImageUrl,
            department: u.department,
            businessUnit: u.businessUnit,
          })
        );

        setGroups(normalized);
        setUsers(us);
      } catch (err) {
        console.error("Load cc-groups/users failed:", err);
        setGroups([]);
        setUsers([]);
        toast.error(
          t("errors.loadFailed", { defaultValue: "Failed to load data" })
        );
      } finally {
        if (alive) setLoading(false);
      }
    };

    load();
    return () => {
      alive = false;
    };
  }, [t]);

  const refreshGroups = async () => {
    try {
      const gRes = await api.get("/api/cc-groups");
      const gs: any[] = Array.isArray(gRes.data) ? gRes.data : [];
      const normalized: CcGroupSummary[] = gs.map((g) => ({
        id: g.id,
        name: g.name,
        memberCount: Array.isArray(g.members)
          ? g.members.length
          : g.memberCount ?? 0,
        members: Array.isArray(g.members) ? g.members : [],
      }));
      setGroups(normalized);
    } catch (err) {
      console.error("Failed to refresh groups", err);
    }
  };

  /* -------- Derived (groups list) -------- */
  const filteredGroups = useMemo(() => {
    let result = groups;

    if (selectedFromUser) {
      result = result.filter(g => 
        g.members && g.members.some(m => m.id === selectedFromUser.id)
      );
    }

    const groupQuery = searchTerm.trim().toLowerCase();
    const memberQuery = memberSearchTerm.trim().toLowerCase();

    if (!groupQuery && !memberQuery) return result;

    return result.filter((g) => {
      // ค้นหาชื่อกลุ่ม
      const matchGroupName = !groupQuery || g.name.toLowerCase().includes(groupQuery);

      // ค้นหาชื่อสมาชิกในกลุ่ม
      let matchMember = !memberQuery;
      if (memberQuery && g.members && g.members.length > 0) {
        matchMember = g.members.some((member) => {
          const searchableText = [
            member.name,
            member.lastname,
            member.nickname,
            member.email,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return searchableText.includes(memberQuery);
        });
      }

      return matchGroupName && matchMember;
    });
  }, [groups, searchTerm, memberSearchTerm, selectedFromUser, editedGroupIds]);

  const editedOrderMap = useMemo(() => new Map(
    Array.from(editedGroupIds).reverse().map((id, index) => [String(id), index])
  ), [editedGroupIds]);

  const sortedGroups = useMemo(() => {
    return [...filteredGroups].sort((a, b) => {
      // Always float edited lines to the top (newest first). Unedited lines keep their original order.
      const indexA = editedOrderMap.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER;
      const indexB = editedOrderMap.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER;
      
      if (indexA !== indexB) {
        return indexA - indexB;
      }
      return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    });
  }, [filteredGroups, sortAsc, editedOrderMap]);

  const indexOfLast = isAll ? sortedGroups.length : currentPage * pageSize;
  const indexOfFirst = isAll ? 0 : indexOfLast - pageSize;
  const currentGroups = isAll
    ? sortedGroups
    : sortedGroups.slice(indexOfFirst, indexOfLast);
  const totalPages = isAll
    ? 1
    : Math.max(1, Math.ceil(sortedGroups.length / pageSize));

  // paging utils like your page
  function makePageWindow(current: number, total: number, sibling = 1) {
    const totalNumbers = sibling * 2 + 5;
    if (total <= totalNumbers)
      return Array.from({ length: total }, (_, i) => i + 1);
    const left = Math.max(2, current - sibling);
    const right = Math.min(total - 1, current + sibling);
    const showLeftDots = left > 2;
    const showRightDots = right < total - 1;
    const pages: (number | "...")[] = [1];
    if (showLeftDots) pages.push("...");
    for (let i = left; i <= right; i++) pages.push(i);
    if (showRightDots) pages.push("...");
    pages.push(total);
    return pages;
  }
  const pagesToShow = useMemo(
    () => makePageWindow(currentPage, totalPages, 1),
    [currentPage, totalPages]
  );

  useEffect(() => setCurrentPage(1), [searchTerm, memberSearchTerm]);
  useEffect(() => {
    if (isAll) return;
    const lastPage = Math.max(1, Math.ceil(sortedGroups.length / pageSize));
    if (currentPage > lastPage) setCurrentPage(lastPage);
  }, [sortedGroups.length, pageSize, isAll, currentPage]);

  useEffect(() => {
    const q = searchTerm.trim();
    const mq = memberSearchTerm.trim();
    if (q || mq) {
      if (pageSize !== 0) {
        pageSizeBeforeSearchRef.current = pageSize;
        setPageSize(0);
      }
      setCurrentPage(1);
    } else {
      if (pageSize === 0) {
        setPageSize(pageSizeBeforeSearchRef.current || 50);
        setCurrentPage(1);
      }
    }
  }, [searchTerm, memberSearchTerm, pageSize]);

  /* -------- Modal helpers -------- */
  const openCreateModal = () => {
    setEditGroupId(null);
    setGroupName("");
    setSelectedUsers([]);
    setMemberSearch("");
    setIsModalOpen(true);
  };

  const openEditModal = async (id: number) => {
    try {
      const { data } = await api.get(`/api/cc-groups/${id}`);

      const rawMembers: any[] = Array.isArray(data.members) ? data.members : [];

      // 🔧 รวมข้อมูลจาก /api/cc-groups/:id เข้ากับ users (เพื่อเอารูป/แผนก/BU)
      const members: User[] = rawMembers.map((m) => {
        const uid = m.userId ?? m.id; // id ของ user
        const found = users.find((u) => u.id === uid); // ข้อมูลเต็มจาก /api/users

        return {
          id: uid,
          name: m.name ?? found?.name ?? "",
          lastname: m.lastname ?? found?.lastname ?? null,
          nickname: m.nickname ?? found?.nickname ?? null,
          email: m.email ?? found?.email ?? "",
          // ✅ รูป: ใช้ของ m ถ้ามี ไม่งั้น fallback ไปของ found
          profileImage: m.profileImage ?? found?.profileImage ?? null,
          profileImagePath:
            m.profileImagePath ?? found?.profileImagePath ?? null,
          profileImageUrl: m.profileImageUrl ?? found?.profileImageUrl ?? null,
          department: m.department ?? found?.department,
          businessUnit: m.businessUnit ?? found?.businessUnit,
        };
      });

      setEditGroupId(Number(data.id));
      setGroupName(String(data.name || ""));
      setSelectedUsers(members); // ✅ ตอนนี้ getAvatarUrl จะมีข้อมูลรูปให้ใช้
      setMemberSearch("");
      setIsModalOpen(true);
    } catch (err) {
      console.error("getGroup failed:", err);
      toast.error(
        t("errors.loadGroupFailed", { defaultValue: "Failed to load group" })
      );
    }
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditGroupId(null);
    setGroupName("");
    setSelectedUsers([]);
    setMemberSearch("");
  };

  /* -------- Save / Delete -------- */
  const onSave = async () => {
    const memberIds = selectedUsers.map((u) => u.id);
    if (!groupName.trim()) {
      toast.error(
        t("errors.nameRequired", { defaultValue: "Please enter a group name" })
      );
      return;
    }
    try {
      if (editGroupId) {
        // แก้ไข: rename + replace members
        await api.put(`/api/cc-groups/${editGroupId}`, {
          name: groupName.trim(),
        });
        await api.put(`/api/cc-groups/${editGroupId}/members`, {
          userIds: memberIds,
        });

        toast.success(
          t("success.groupUpdated", { defaultValue: "Group updated" })
        );
        setEditedGroupIds(prev => {
          const newSet = new Set(prev);
          newSet.delete(editGroupId!);
          newSet.add(editGroupId!);
          return newSet;
        });
      } else {
        // Create: Backend supports adding members during creation
        await api.post(`/api/cc-groups`, {
          name: groupName.trim(),
          memberIds: memberIds,
        });

        toast.success(
          t("success.groupCreated", { defaultValue: "Group created" })
        );
      }
      closeModal();
      // Reload page to refresh data
      await refreshGroups();
    } catch (err) {
      console.error("save group failed:", err);
      if (axios.isAxiosError(err)) {
        const msg =
          err.response?.data?.error ||
          err.response?.data?.message ||
          err.message ||
          t("errors.generic", { defaultValue: "Something went wrong" });
        toast.error(msg);
      } else {
        toast.error(
          t("errors.generic", { defaultValue: "Something went wrong" })
        );
      }
    }
  };

  const onDelete = async (id: number) => {
    if (!confirm(t("confirmDelete", { defaultValue: "Delete this group?" })))
      return;
    try {
      await api.delete(`/api/cc-groups/${id}`);
      setGroups((prev) => prev.filter((g) => g.id !== id));
      toast.success(
        t("success.groupDeleted", { defaultValue: "Group deleted" })
      );
    } catch (err) {
      console.error("delete group failed:", err);
      toast.error(
        t("errors.deleteFailed", { defaultValue: "Failed to delete group" })
      );
    }
  };

  /* -------- Member management (add/remove from table) -------- */
  const removeMemberFromGroup = async (groupId: number, memberId: number) => {
    try {
      const group = groups.find((g) => g.id === groupId);
      if (!group || !group.members) return;

      const updatedMemberIds = group.members
        .filter((m) => m.id !== memberId)
        .map((m) => m.id);

      await api.put(`/api/cc-groups/${groupId}/members`, {
        userIds: updatedMemberIds,
      });

      toast.success(
        t("success.memberRemoved", { defaultValue: "Member removed" })
      );
      setEditedGroupIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(groupId);
        newSet.add(groupId);
        return newSet;
      });
      // Reload page to refresh data
      await refreshGroups();
    } catch (err) {
      console.error("Remove member failed:", err);
      toast.error(
        t("errors.removeMemberFailed", {
          defaultValue: "Failed to remove member",
        })
      );
    }
  };

  const addMembersToGroup = async (groupId: number, userIds: number[]) => {
    try {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return;

      const currentMemberIds = group.members?.map((m) => m.id) || [];
      const newUserIds = userIds.filter((id) => !currentMemberIds.includes(id));

      if (newUserIds.length === 0) {
        toast.error(
          t("errors.allMembersExist", {
            defaultValue: "All selected members are already in the group",
          })
        );
        return;
      }

      const updatedMemberIds = [...currentMemberIds, ...newUserIds];

      await api.put(`/api/cc-groups/${groupId}/members`, {
        userIds: updatedMemberIds,
      });

      toast.success(
        t("success.membersAdded", {
          defaultValue: `${newUserIds.length} member(s) added`
        })
      );
      setEditedGroupIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(groupId);
        newSet.add(groupId);
        return newSet;
      });
      // Reload page to refresh data
      await refreshGroups();
    } catch (err) {
      console.error("Add members failed:", err);
      toast.error(
        t("errors.addMemberFailed", { defaultValue: "Failed to add members" })
      );
    }
  };

  const performBulkUpdate = async () => {
    if (!selectedFromUser) {
      toast.error("Please search and select a user to update");
      return;
    }
    if (bulkUpdateAction === "replace" && !selectedNewUser) {
      toast.error("Please select a new user for replacement");
      return;
    }
    if (selectedGroupIds.size === 0) {
      toast.error("Please select at least one group to update");
      return;
    }

    try {
      setIsBulkUpdating(true);
      const payload = {
        action: bulkUpdateAction,
        fromUserId: selectedFromUser.id,
        groupIds: Array.from(selectedGroupIds),
        ...(bulkUpdateAction === "replace" && selectedNewUser ? { toUserId: selectedNewUser.id } : {})
      };

      const response = await axios.post("/api/cc-groups/bulk-update", payload, { withCredentials: true });
      if (response.data.ok) {
        toast.success(`Successfully updated ${response.data.groupsUpdated} group(s)`);
        
        setEditedGroupIds(prev => {
          const newSet = new Set(prev);
          selectedGroupIds.forEach(id => {
            newSet.delete(id);
            newSet.add(id);
          });
          return newSet;
        });

        setIsBulkUpdateModalOpen(false);
        setSelectedGroupIds(new Set());
        setFromUserSearchTerm("");
        setSelectedFromUser(null);
        setSelectedNewUser(null);

        await refreshGroups();
      }
    } catch (err: any) {
      console.error("Bulk update error:", err);
      toast.error(err.response?.data?.error || "Failed to perform bulk update");
    } finally {
      setIsBulkUpdating(false);
    }
  };

  /* -------- Member picker (left list filter / right selected chips) -------- */
  const availableUsers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    const selectedIds = new Set(selectedUsers.map((u) => u.id));
    return users
      .filter((u) => !selectedIds.has(u.id))
      .filter((u) => {
        if (!q) return true;
        const hay = [
          u.id,
          u.name,
          u.lastname ?? "",
          u.nickname ?? "",
          u.email,
          u.department?.name ?? "",
          u.businessUnit?.name ?? "",
        ]
          .map((v) => String(v).toLowerCase())
          .join(" ");
        return hay.includes(q);
      })
      .slice(0, 100); // จำกัดรายการตอนค้นหาให้ลื่น
  }, [users, selectedUsers, memberSearch]);

  const addMember = (u: User) => {
    if (selectedUsers.some((x) => x.id === u.id)) return;
    setSelectedUsers((prev) => [...prev, u]);
  };
  const removeMember = (id: number) => {
    setSelectedUsers((prev) => prev.filter((u) => u.id !== id));
  };

  // รายชื่อผู้ใช้สำหรับ modal เพิ่มสมาชิก
  const availableUsersForAdd = useMemo(() => {
    if (!addMemberGroupId) return [];

    const group = groups.find((g) => g.id === addMemberGroupId);
    const currentMemberIds = new Set(group?.members?.map((m) => m.id) || []);
    const q = addMemberSearch.trim().toLowerCase();

    return users
      .filter((u) => !currentMemberIds.has(u.id))
      .filter((u) => {
        if (!q) return true;
        const searchableText = [
          u.name,
          u.lastname,
          u.nickname,
          u.email,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return searchableText.includes(q);
      })
      .slice(0, 50);
  }, [users, addMemberGroupId, groups, addMemberSearch]);

  /* -------- Render -------- */
  if (loading) {
    return (
      <div className="p-6 w-full flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#183e33]"></div>
      </div>
    );
  }

  if (blocked) {
    return <UnauthorizedAccess />;
  }

  return (
    <div className="p-6 w-full">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <h1 className="text-2xl font-bold text-[#183e33] flex items-center gap-2">
          <FiUsers /> {t("title", { defaultValue: "CC Groups" })}
        </h1>

        <div className="flex flex-col md:flex-row gap-3 w-full md:w-auto">
          {/* Search Groups */}
          <div className="relative w-full md:w-72">
            <input
              type="text"
              placeholder={t("searchGroupPlaceholder", {
                defaultValue: "Search groups...",
              })}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 [border-radius:15px] focus:outline-none focus:ring-2 focus:ring-[#183e33]"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <FiSearch className="absolute left-3 top-2.5 h-5 w-5 text-gray-400" />
          </div>

          {/* Search Members */}
          <div className="relative w-full md:w-72" ref={memberSearchRef}>
            <input
              type="text"
              placeholder={t("searchMemberPlaceholder", {
                defaultValue: "Search members...",
              })}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 [border-radius:15px] focus:outline-none focus:ring-2 focus:ring-[#183e33]"
              value={memberSearchTerm}
              onChange={(e) => {
                setMemberSearchTerm(e.target.value);
                setShowMemberDropdown(true);
              }}
              onFocus={() => setShowMemberDropdown(true)}
            />
            <FiUsers className="absolute left-3 top-2.5 h-5 w-5 text-gray-400" />

            {/* Dropdown รายชื่อ */}
            {showMemberDropdown && memberSearchTerm.trim() && matchedUsers.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-300 rounded-xl shadow-lg max-h-80 overflow-y-auto z-50">
                {matchedUsers.map((user) => (
                  <UserDropdownItem
                    key={user.id}
                    user={user}
                    onClick={() => {
                      setMemberSearchTerm(user.name);
                      setShowMemberDropdown(false);
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Search User for Bulk Update */}
          <div className="relative w-full md:w-72" ref={fromUserSearchRef}>
            <input
              type="text"
              placeholder="Select user to bulk update..."
              className="w-full pl-10 pr-8 py-2 border border-gray-300 [border-radius:15px] focus:outline-none focus:ring-2 focus:ring-[#183e33]"
              value={fromUserSearchTerm}
              onChange={(e) => {
                setFromUserSearchTerm(e.target.value);
                setShowFromUserDropdown(true);
                if (e.target.value === "") setSelectedFromUser(null);
              }}
              onFocus={() => setShowFromUserDropdown(true)}
            />
            <FiUsers className="absolute left-3 top-2.5 h-5 w-5 text-gray-400" />
            {selectedFromUser && (
              <button
                onClick={() => {
                  setFromUserSearchTerm("");
                  setSelectedFromUser(null);
                  setSelectedGroupIds(new Set());
                }}
                className="absolute right-3 top-2.5 h-5 w-5 text-gray-400 hover:text-red-500"
              >
                <FiX />
              </button>
            )}

            {showFromUserDropdown && fromUserSearchTerm.trim() && matchedFromUsers.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-300 rounded-xl shadow-lg max-h-80 overflow-y-auto z-50">
                {matchedFromUsers.map((user) => (
                  <UserDropdownItem
                    key={user.id}
                    user={user}
                    onClick={() => {
                      const displayName = user.nickname ? `${user.name} (${user.nickname})` : user.name;
                      setFromUserSearchTerm(displayName);
                      setSelectedFromUser(user);
                      setShowFromUserDropdown(false);
                      setSelectedGroupIds(new Set());
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <PageSizeSelect
            pageSize={pageSize}
            setPageSize={(n) => {
              setPageSize(n);
              setCurrentPage(1);
            }}
            isSearching={isSearching}
          />
          <button
            onClick={openCreateModal}
            className="bg-[#183e33] text-white px-4 py-2 [border-radius:15px] hover:bg-[#141716] inline-flex items-center gap-2"
          >
            <FiPlus /> {t("createNew", { defaultValue: "Create" })}
          </button>
          <button
            onClick={() => setShowLogModal(true)}
            className="bg-gray-600 text-white px-4 py-2 [border-radius:15px] hover:bg-gray-700"
          >
            {t("viewLog")}
          </button>
        </div>
      </div>

      {/* Action Row - Bulk Actions & Show Edited */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-4">
        <div className="flex items-center gap-3">
          {/* Selected user actions */}
          {selectedFromUser && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600">
                Selected <span className="font-semibold text-gray-900">{selectedGroupIds.size}</span> group(s)
              </span>
              <button
                onClick={() => setIsBulkUpdateModalOpen(true)}
                disabled={selectedGroupIds.size === 0}
                className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-[15px] hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Bulk Update Members
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white shadow-xl rounded-2xl overflow-hidden -mx-6 sm:mx-0">
        <div className="overflow-x-auto w-full">
          <table className="min-w-full w-full table-auto divide-y divide-[#8A8787]">
            <thead className="bg-gradient-to-r from-white text-[#000000] font-extrabold">
              <tr>
                {selectedFromUser && (
                  <th className="px-6 py-3 text-left w-12">
                    <input
                      type="checkbox"
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedGroupIds(new Set(currentGroups.map(g => g.id)));
                        } else {
                          setSelectedGroupIds(new Set());
                        }
                      }}
                      checked={currentGroups.length > 0 && currentGroups.every(g => selectedGroupIds.has(g.id))}
                      className="w-4 h-4 text-orange-600 border-gray-300 rounded focus:ring-orange-500"
                    />
                  </th>
                )}
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                  <span className="inline-flex items-center">
                    {t("col.name", { defaultValue: "Group name" })}
                    <button
                      onClick={() => {
                        setSortAsc((p) => !p);
                        setCurrentPage(1);
                      }}
                      className="ml-1 w-5 h-5 flex items-center justify-center text-gray-600 hover:text-[#183e33]"
                      title={sortAsc ? "Z-A" : "A-Z"}
                    >
                      {sortAsc ? (
                        <BiSolidChevronUp size={16} />
                      ) : (
                        <BiSolidChevronDown size={16} />
                      )}
                    </button>
                  </span>
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                  {t("col.members")}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider">
                  {t("col.actions", { defaultValue: "Actions" })}
                </th>
              </tr>
            </thead>

            <tbody className="bg-white divide-y divide-gray-200">
              {currentGroups.length > 0 ? (
                currentGroups.map((g) => (
                  <tr
                    key={g.id}
                    className={`transition-colors cursor-pointer ${
                      editedGroupIds.has(g.id) ? 'bg-green-50/70 hover:bg-green-100/70' :
                      selectedGroupIds.has(g.id) ? 'bg-orange-50 hover:bg-orange-100' : 'hover:bg-gray-50'
                    }`}
                    onClick={() => {
                      if (selectedFromUser) {
                        setSelectedGroupIds(prev => {
                          const newSet = new Set(prev);
                          if (newSet.has(g.id)) newSet.delete(g.id);
                          else newSet.add(g.id);
                          return newSet;
                        });
                      }
                    }}
                  >
                    {selectedFromUser && (
                      <td className="px-6 py-4" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedGroupIds.has(g.id)}
                          onChange={() => {
                            setSelectedGroupIds(prev => {
                              const newSet = new Set(prev);
                              if (newSet.has(g.id)) newSet.delete(g.id);
                              else newSet.add(g.id);
                              return newSet;
                            });
                          }}
                          className="w-4 h-4 text-orange-600 border-gray-300 rounded focus:ring-orange-500"
                        />
                      </td>
                    )}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium text-gray-900">
                          {g.name}
                        </div>
                        {editedGroupIds.has(g.id) && (
                          <span className="inline-flex flex-shrink-0 items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 border border-green-300">
                            Edited
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {t("idLabel", { defaultValue: "ID" })}: {g.id}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-2">
                        {g.members && g.members.length > 0 ? (
                          g.members.map((member) => (
                            <MemberPill
                              key={member.id}
                              member={member}
                              t={t}
                              searchTerm={memberSearchTerm}
                              groupId={g.id}
                              onRemove={(memberId) => {
                                setRemoveMemberData({ groupId: g.id, memberId, groupName: g.name });
                                setShowRemoveMemberConfirm(true);
                              }}
                            />
                          ))
                        ) : (
                          <span className="text-xs text-gray-400 italic">
                            {t("noMembers", { defaultValue: "No members" })}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-4">
                      <button
                        onClick={() => {
                          setAddMemberGroupId(g.id);
                          setShowAddMemberModal(true);
                        }}
                        className="text-green-600 hover:text-green-900 inline-flex items-center gap-1"
                      >
                        <FiPlus /> {t("addMember", { defaultValue: "Add Member" })}
                      </button>
                      <button
                        onClick={() => openEditModal(g.id)}
                        className="text-blue-600 hover:text-blue-900 inline-flex items-center gap-1"
                      >
                        <FiEdit2 /> {t("edit", { defaultValue: "Edit" })}
                      </button>
                      <button
                        onClick={() => onDelete(g.id)}
                        className="text-red-600 hover:text-red-900 inline-flex items-center gap-1"
                      >
                        <FiTrash2 /> {t("delete", { defaultValue: "Delete" })}
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={3}
                    className="px-6 py-4 text-center text-gray-500"
                  >
                    {searchTerm
                      ? t("noMatch", {
                        defaultValue: "No groups matched your search",
                      })
                      : t("noData", { defaultValue: "No groups yet" })}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Summary */}
      {filteredGroups.length > 0 && (
        <div className="mt-4 text-sm text-gray-600">
          {t("showing", { defaultValue: "Showing" })} {sortedGroups.length} /{" "}
          {groups.length} {t("groups", { defaultValue: "groups" })}
        </div>
      )}

      {/* Pagination */}
      {!isAll && totalPages > 1 && (
        <div className="flex justify-center flex-wrap gap-2 mt-4">
          <button
            className="px-3 py-1 rounded border text-sm font-medium bg-white text-green-900 border-gray-300 disabled:opacity-40"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
          >
            {t("prev", { defaultValue: "Prev" })}
          </button>

          {pagesToShow.map((p, idx) =>
            p === "..." ? (
              <span
                key={`dots-${idx}`}
                className="px-2 text-gray-500 select-none"
              >
                …
              </span>
            ) : (
              <button
                key={p}
                className={`px-3 py-1 rounded border text-sm font-medium ${currentPage === p
                    ? "bg-[#183e33] text-white"
                    : "bg-white text-green-900 border-gray-300 hover:bg-gray-100"
                  }`}
                onClick={() => setCurrentPage(p as number)}
              >
                {p}
              </button>
            )
          )}

          <button
            className="px-3 py-1 rounded border text-sm font-medium bg-white text-green-900 border-gray-300 disabled:opacity-40"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
          >
            {t("next", { defaultValue: "Next" })}
          </button>
        </div>
      )}

      {/* Modal: create/edit group */}
      {isModalOpen && (
        <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-white border border-[#183e33] rounded-xl shadow-2xl p-6 w-full max-w-4xl pointer-events-auto relative drop-shadow-lg">
            <button
              className="absolute top-3 right-3 text-green-500 hover:text-red-500 text-xl font-bold"
              onClick={closeModal}
            >
              ✕
            </button>

            <h2 className="text-xl font-bold text-green-700 mb-4">
              {editGroupId
                ? t("modal.editTitle", { defaultValue: "Edit CC Group" })
                : t("modal.createTitle", { defaultValue: "Create CC Group" })}
            </h2>

            {/* Group name */}
            <div className="mb-4">
              <label className="block text-sm font-semibold text-green-700 mb-1">
                {t("form.groupName", { defaultValue: "Group name" })}
              </label>
              <input
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder={t("form.groupNamePh", {
                  defaultValue: "Enter group name",
                })}
                className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 border-[#183e33] focus:ring-green-500"
              />
            </div>

            {/* Member picker */}
            <div className="mb-4">
              <label className="block text-sm font-semibold text-green-700 mb-1">
                {t("modal.memberPicker", { defaultValue: "Select members to add to this CC group" })}
              </label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Left: search + list */}
                <div className="border rounded-xl p-3">
                  <div className="relative mb-3">
                    <input
                      type="text"
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder={t("member.searchPh", {
                        defaultValue: "Search users...",
                      })}
                      className="w-full pl-10 pr-3 py-2 border rounded-md focus:outline-none focus:ring-2 border-[#183e33] focus:ring-green-500"
                    />
                    <FiSearch className="absolute left-3 top-2.5 h-5 w-5 text-gray-400" />
                  </div>

                  <div className="max-h-[360px] overflow-auto divide-y">
                    {availableUsers.length > 0 ? (
                      availableUsers.map((u) => (
                        <AvailableUserItem
                          key={u.id}
                          user={u}
                          onAdd={addMember}
                        />
                      ))
                    ) : (
                      <div className="text-sm text-gray-500 py-6 text-center">
                        {t("member.noUsers", {
                          defaultValue: "No users found",
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: selected chips */}
                <div className="border rounded-xl p-3">
                  <div className="mb-2 text-sm font-semibold text-green-700">
                    {t("member.selected", { defaultValue: "Selected members" })}{" "}
                    ({selectedUsers.length})
                  </div>
                  {selectedUsers.length === 0 ? (
                    <div className="text-sm text-gray-500 py-6 text-center">
                      {t("member.empty", {
                        defaultValue: "No members selected",
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {selectedUsers.map((u) => (
                        <SelectedUserChip
                          key={u.id}
                          user={u}
                          onRemove={removeMember}
                          t={t}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer buttons */}
            <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3">
              <button
                onClick={onSave}
                className="w-full bg-[#183e33] hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-md transition duration-300"
              >
                {editGroupId
                  ? t("modal.saveEdit", { defaultValue: "Save changes" })
                  : t("modal.saveCreate", { defaultValue: "Create group" })}
              </button>
              <button
                onClick={closeModal}
                className="w-full bg-white text-[#183e33] border border-[#183e33] font-semibold py-2 px-4 rounded-md hover:bg-gray-50"
              >
                {t("cancel", { defaultValue: "Cancel" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Log Modal */}
      <AdminLogModal
        isOpen={showLogModal}
        onClose={() => setShowLogModal(false)}
        module="CC_GROUP"
        title="CC Groups Management Log"
      />

      {/* Remove Member Confirmation Modal */}
      {showRemoveMemberConfirm && removeMemberData && (
        <div className="fixed inset-0 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-[#183e33] mb-4">
              {t("confirmRemoveMember", { defaultValue: "Confirm Remove Member" })}
            </h2>
            <p className="text-gray-700 mb-6">
              {t("confirmRemoveMemberMessage", {
                defaultValue: "Are you sure you want to remove this member from the group?",
              })}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  removeMemberFromGroup(removeMemberData.groupId, removeMemberData.memberId);
                  setShowRemoveMemberConfirm(false);
                  setRemoveMemberData(null);
                }}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-4 rounded-md transition duration-300"
              >
                {t("remove", { defaultValue: "Remove" })}
              </button>
              <button
                onClick={() => {
                  setShowRemoveMemberConfirm(false);
                  setRemoveMemberData(null);
                }}
                className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold py-2 px-4 rounded-md transition duration-300"
              >
                {t("cancel", { defaultValue: "Cancel" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Member Modal */}
      {showAddMemberModal && addMemberGroupId && (
        <div className="fixed inset-0 flex items-center justify-center z-50">
          <div className="bg-white border rounded-xl shadow-2xl p-6 w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-[#183e33]">
                {t("addMemberTitle", { defaultValue: "Add Members to Group" })}
              </h2>
              <button
                onClick={() => {
                  setShowAddMemberModal(false);
                  setAddMemberGroupId(null);
                  setAddMemberSearch("");
                  setSelectedUsersToAdd([]);
                }}
                className="text-gray-500 hover:text-red-500"
              >
                <FiX size={24} />
              </button>
            </div>

            {/* Selected count */}
            {selectedUsersToAdd.length > 0 && (
              <div className="mb-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                {selectedUsersToAdd.length} {t("membersSelected", { defaultValue: "member(s) selected" })}
              </div>
            )}

            {/* Search */}
            <div className="relative mb-4">
              <input
                type="text"
                value={addMemberSearch}
                onChange={(e) => setAddMemberSearch(e.target.value)}
                placeholder={t("searchUserPlaceholder", {
                  defaultValue: "Search users...",
                })}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#183e33]"
              />
              <FiSearch className="absolute left-3 top-2.5 h-5 w-5 text-gray-400" />
            </div>

            {/* User List with Checkboxes */}
            <div className="flex-1 overflow-y-auto border rounded-lg divide-y">
              {availableUsersForAdd.length > 0 ? (
                availableUsersForAdd.map((user) => {
                  const isSelected = selectedUsersToAdd.some((u) => u.id === user.id);
                  const avatarUrl = getAvatarUrl(user);

                  return (
                    <div
                      key={user.id}
                      className={`flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors ${isSelected ? "bg-blue-50" : ""
                        }`}
                      onClick={() => {
                        if (isSelected) {
                          setSelectedUsersToAdd((prev) =>
                            prev.filter((u) => u.id !== user.id)
                          );
                        } else {
                          setSelectedUsersToAdd((prev) => [...prev, user]);
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => { }}
                        className="h-4 w-4 text-[#183e33] rounded border-gray-300 focus:ring-[#183e33]"
                      />
                      <div className="h-10 w-10 rounded-full overflow-hidden border bg-gray-100 flex-shrink-0">
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt={user.name}
                            className="h-full w-full object-cover"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).src =
                                "/img/default-avatar.png";
                            }}
                          />
                        ) : (
                          <div className="h-full w-full flex items-center justify-center text-sm font-semibold text-gray-400">
                            {user.name?.[0]?.toUpperCase?.() || "U"}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {user.email}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {[user.name, user.lastname].filter(Boolean).join(" ")}
                          {user.nickname && (
                            <span className="ml-1">({user.nickname})</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-8 text-gray-500">
                  {t("noUsersAvailable", {
                    defaultValue: "No users available to add",
                  })}
                </div>
              )}
            </div>

            {/* Footer buttons */}
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => {
                  if (selectedUsersToAdd.length === 0) {
                    toast.error(
                      t("errors.noMembersSelected", {
                        defaultValue: "Please select at least one member",
                      })
                    );
                    return;
                  }
                  const group = groups.find((g) => g.id === addMemberGroupId);
                  setAddMemberData({
                    groupId: addMemberGroupId,
                    user: selectedUsersToAdd[0],
                    groupName: group?.name || "",
                  });
                  setShowAddMemberConfirm(true);
                }}
                disabled={selectedUsersToAdd.length === 0}
                className="flex-1 bg-[#183e33] hover:bg-[#141716] text-white font-semibold py-2 px-4 rounded-md transition duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {selectedUsersToAdd.length > 0
                  ? `${t("add", { defaultValue: "Add" })} ${selectedUsersToAdd.length} ${t("members", { defaultValue: "member(s)" })}`
                  : t("add", { defaultValue: "Add" })}
              </button>
              <button
                onClick={() => {
                  setShowAddMemberModal(false);
                  setAddMemberGroupId(null);
                  setAddMemberSearch("");
                  setSelectedUsersToAdd([]);
                }}
                className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold py-2 px-4 rounded-md transition duration-300"
              >
                {t("cancel", { defaultValue: "Cancel" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Member Confirmation Modal */}
      {showAddMemberConfirm && addMemberData && (
        <div className="fixed inset-0 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col">
            <h2 className="text-xl font-bold text-[#183e33] mb-4">
              {t("confirmAddMembers", { defaultValue: "Confirm Add Members" })}
            </h2>
            <p className="text-gray-700 mb-2">
              {t("confirmAddMembersMessage", {
                defaultValue: `Are you sure you want to add ${selectedUsersToAdd.length} member(s) to the group?`,
              })}
            </p>
            <div className="bg-gray-50 rounded-lg p-3 mb-6 max-h-60 overflow-y-auto flex-1">
              {selectedUsersToAdd.map((user) => {
                const avatarUrl = getAvatarUrl(user);
                return (
                  <div key={user.id} className="flex items-center gap-3 mb-2 last:mb-0">
                    <div className="h-8 w-8 rounded-full overflow-hidden border bg-gray-100 flex-shrink-0">
                      {avatarUrl ? (
                        <img
                          src={avatarUrl}
                          alt={user.name}
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).src =
                              "/img/default-avatar.png";
                          }}
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-xs font-semibold text-gray-400">
                          {user.name?.[0]?.toUpperCase?.() || "U"}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {[user.name, user.lastname].filter(Boolean).join(" ")}
                        {user.nickname && (
                          <span className="text-gray-500 ml-1">
                            ({user.nickname})
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {user.email}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  addMembersToGroup(
                    addMemberData.groupId,
                    selectedUsersToAdd.map((u) => u.id)
                  );
                  setShowAddMemberConfirm(false);
                  setAddMemberData(null);
                  setShowAddMemberModal(false);
                  setAddMemberGroupId(null);
                  setAddMemberSearch("");
                  setSelectedUsersToAdd([]);
                }}
                className="flex-1 bg-[#183e33] hover:bg-[#141716] text-white font-semibold py-2 px-4 rounded-md transition duration-300"
              >
                {t("add", { defaultValue: "Add" })}
              </button>
              <button
                onClick={() => {
                  setShowAddMemberConfirm(false);
                  setAddMemberData(null);
                }}
                className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold py-2 px-4 rounded-md transition duration-300"
              >
                {t("cancel", { defaultValue: "Cancel" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Update Modal */}
      {isBulkUpdateModalOpen && selectedFromUser && (
        <div className="fixed inset-0 flex items-center justify-center z-50">
          <div className="bg-white border rounded-xl shadow-2xl p-6 w-full max-w-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-[#183e33]">
                Bulk Update Members
              </h2>
              <button
                onClick={() => {
                  setIsBulkUpdateModalOpen(false);
                  setSelectedNewUser(null);
                }}
                className="text-gray-500 hover:text-red-500"
              >
                <FiX size={24} />
              </button>
            </div>

            <p className="text-sm text-gray-700 mb-6">
              You are updating member <strong>{selectedFromUser.name}</strong> in {selectedGroupIds.size} selected group(s).
            </p>

            <div className="mb-6 space-y-4">
              <div className="flex items-start gap-3 border p-4 rounded-lg">
                <input 
                  type="radio" 
                  id="action-replace"
                  checked={bulkUpdateAction === "replace"}
                  onChange={() => setBulkUpdateAction("replace")}
                  className="mt-1 rounded text-blue-600 focus:ring-blue-500"
                />
                <div className="flex-1">
                  <label htmlFor="action-replace" className="cursor-pointer font-semibold text-gray-900 block mb-2">
                    Replace With Another User
                  </label>
                  {bulkUpdateAction === "replace" && (
                    <div className="relative mt-2" ref={replaceMemberSearchRef}>
                      <input
                        type="text"
                        placeholder="Search user to replace with..."
                        value={selectedNewUser ? `${selectedNewUser.name} ${selectedNewUser.lastname || ""}` : replaceMemberSearchTerm}
                        onChange={(e) => {
                          setSelectedNewUser(null);
                          setReplaceMemberSearchTerm(e.target.value);
                          setShowReplaceMemberDropdown(true);
                        }}
                        className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        onFocus={() => setShowReplaceMemberDropdown(true)}
                      />
                      <FiSearch className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                      
                      {showReplaceMemberDropdown && replaceMemberSearchTerm.trim() && matchedReplaceUsers.length > 0 && !selectedNewUser && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-300 rounded-xl shadow-lg max-h-60 overflow-y-auto z-50">
                          {matchedReplaceUsers.map((user) => (
                            <UserDropdownItem
                              key={user.id}
                              user={user}
                              onClick={() => {
                                setSelectedNewUser(user);
                                setShowReplaceMemberDropdown(false);
                                setReplaceMemberSearchTerm("");
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-start gap-3 border p-4 rounded-lg">
                <input 
                  type="radio" 
                  id="action-remove"
                  checked={bulkUpdateAction === "remove"}
                  onChange={() => setBulkUpdateAction("remove")}
                  className="mt-1 rounded text-red-600 focus:ring-red-500"
                />
                <label htmlFor="action-remove" className="cursor-pointer font-semibold text-gray-900 line-clamp-2 mt-0.5">
                  Remove Entirely from Selected Groups
                </label>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={performBulkUpdate}
                disabled={isBulkUpdating || (bulkUpdateAction === "replace" && !selectedNewUser)}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-md disabled:opacity-50 transition-colors flex items-center justify-center"
              >
                {isBulkUpdating ? (
                  <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white"></div>
                ) : (
                  "Apply Update"
                )}
              </button>
              <button
                onClick={() => {
                  setIsBulkUpdateModalOpen(false);
                  setSelectedNewUser(null);
                }}
                disabled={isBulkUpdating}
                className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold py-2 px-4 rounded-md transition duration-300 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* -------- rows-per-page dropdown -------- */
function PageSizeSelect({
  pageSize,
  setPageSize,
  isSearching,
}: {
  pageSize: number;
  setPageSize: (n: number) => void;
  isSearching: boolean;
}) {

  return (
    <Listbox value={pageSize} onChange={setPageSize}>
      <div className="relative w-24">
        <Listbox.Button className="w-full border border-gray-400 rounded-xl px-2 py-1 flex justify-between items-center">
          {isSearching || pageSize === 0 ? "All" : pageSize} <BiChevronDown />
        </Listbox.Button>

        <Listbox.Options className="absolute mt-1 w-full bg-white shadow-lg rounded-xl overflow-auto z-10">
          {PAGE_SIZE_OPTIONS.map((n) => (
            <Listbox.Option
              key={n}
              value={n}
              className={({ active, selected }) =>
                `cursor-pointer select-none px-2 py-1 ${active ? "bg-[#183e33] text-white" : "text-gray-700"
                } ${selected ? "font-semibold" : ""}`
              }
            >
              {n === 0 ? "All" : n}
            </Listbox.Option>
          ))}
        </Listbox.Options>
      </div>
    </Listbox>
  );
}

export default CcGroups;
