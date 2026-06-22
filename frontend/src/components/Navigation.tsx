// src/components/Navigation.tsx
import { useState, useEffect, useRef, Fragment } from "react";
import { Link, useLocation } from "react-router-dom";
import { Transition } from "@headlessui/react";
import {
  Home,
  User,
  Users,
  LogOut,
  Menu,
  X,
  ChevronDown,
  ChevronUp,
  FilePen,
  FileSymlink,
} from "lucide-react";
import {
  faFilePen,
  faUserPlus,
  faStapler,
  faBuilding,
  faCog,
  faPeopleGroup,
  faArrowDownWideShort,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import axios from "axios";
import NotificationDropdown from "./NotificationDropdown";
import { useTranslation } from "react-i18next";
import { api, BASE_URL } from "../lib/api";
import { getAvatarUrlFromUser } from "../lib/files";
import ListTreeIcon from "./icons/ListTreeIcon";

export default function Navigation() {
  const { t, i18n } = useTranslation("nav");
  const location = useLocation();
  const [role, setRole] = useState<string | null>(null);
  const roleLower = (role || "").toLowerCase();
  const canSeeAdmin = roleLower === "admin";
  const canSeeSettings = roleLower === "admin" || roleLower === "dcc";
  const [mobileOpen, setMobileOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const adminRef = useRef<HTMLDivElement>(null);
  const mobileAdminRef = useRef<HTMLDivElement>(null);
  const [windowWidth] = useState(window.innerWidth);
  const [managementOpen, setManagementOpen] = useState(false);
  const managementRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [showNav, setShowNav] = useState(true);
  const lastScrollY = useRef(0);
  const shortLang = (i18n.resolvedLanguage || i18n.language).split("-")[0];
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string | null>(null);
  const displayName = nickname ? `${name} (${nickname})` : name;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        adminOpen &&
        !adminRef.current?.contains(e.target as Node) &&
        !mobileAdminRef.current?.contains(e.target as Node)
      ) {
        setAdminOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [adminOpen]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      // ❌ ไม่ต้องทำอะไรถ้าเมนูปิดอยู่
      if (!managementOpen) return;

      // ✅ ปิดด้วยคลิกนอกกรอบเฉพาะ Desktop (lg ขึ้นไป)
      if (windowWidth < 1024) return;

      if (
        managementRef.current &&
        !managementRef.current.contains(e.target as Node)
      ) {
        setManagementOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [managementOpen, windowWidth]);
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (
        userMenuOpen &&
        userMenuRef.current &&
        !userMenuRef.current.contains(e.target as Node)
      ) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [userMenuOpen]);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get("/api/me");
        const me = res.data?.user ?? res.data;
        setRole(me.role ?? null);
        setName(me.name ?? null);
        setEmail(me.email ?? null);
        setNickname(me.nickname ?? null);
        setProfileImageUrl(getAvatarUrlFromUser(me)); // <- ได้ URL พร้อมใช้แล้ว
      } catch {
        setRole(null);
        setName(null);
        setEmail(null);
        setNickname(null);
        setProfileImageUrl(null);
      }
    })();
  }, []);

  // คลาสสำหรับ link + animation (Enhanced)
  const navLinkClass =
    "relative flex items-center gap-1 px-2 py-1.5 rounded-md transition-all duration-300 group";
  const activeClass = "text-[#00ffaa] font-semibold";
  const inactiveClass = "text-gray-200 hover:text-white";

  // แก้ไขให้เส้นใต้แสดงเมื่อเมนูนั้น active
  const underlineAnimation = (paths: string | string[]) => {
    const activePaths = Array.isArray(paths) ? paths : [paths];
    const isActivePath = activePaths.includes(location.pathname);

    return `
      after:content-[''] after:absolute after:bottom-0 after:left-1/2 
      after:w-0 after:h-[2px] after:bg-[#00ffaa] 
      after:transition-all after:duration-500 after:transform after:-translate-x-1/2
      group-hover:after:w-full group-hover:after:shadow-[0_0_10px_#00ffaa]
      ${isActivePath ? "after:w-full" : ""}
    `;
  };

  const memoToolsPaths = ["/memotype-manager", "/cc-groups", "/approver-lines"];


  const mobileHighlight = `
    hover:bg-[#00ffaa]/10 hover:shadow-[0_0_15px_rgba(0,255,170,0.5)]
    transition-all duration-300 hover:pl-3
  `;
  const iconAnimation = `
    transition-transform duration-500 group-hover:scale-110 group-hover:rotate-[5deg]
  `;
  const neonGlow = `
    hover:shadow-[0_0_10px_#00ffaa,0_0_20px_#00ffaa33]
    transition-shadow duration-500
  `;

  // ฟัง scroll ของ <main id="scroll-container">
  useEffect(() => {
    const container = document.getElementById("scroll-container");
    if (!container) return;

    const handleScroll = () => {
      const currentScrollY = container.scrollTop;
      // ถ้าเลื่อนลงมากกว่า lastScrollY และเกิน 80px -> ซ่อน nav
      if (currentScrollY > lastScrollY.current && currentScrollY > 80) {
        setShowNav(false);
      } else {
        setShowNav(true);
      }
      lastScrollY.current = currentScrollY;
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const isActive = (path: string) =>
    location.pathname === path ? activeClass : inactiveClass;

  const handleLogout = () => {
    api.post("/api/auth/logout").finally(() => {
      window.location.href = "/login";
    });
  };

  // คลาสสำหรับข้อความที่ปรับตามขนาดหน้าจอ
  const textSizeClass = windowWidth <= 320 ? "text-sm" : "text-base";

  return (
    <>
      {/* Enhanced Nav with more effects */}
      <nav
        className={`
          fixed top-0 left-0 w-full h-16 bg-[#183e33]/95 backdrop-blur-md shadow-lg z-50
          flex items-center justify-between px-4
          transition-transform duration-500 ease-in-out
          border-b border-[#00ffaa]/20
          ${showNav ? "translate-y-0" : "-translate-y-full"}
        `}
      >
        {/* ===== ซ้าย: Logo with Hover Effect ===== */}
        <Link
          to="/"
          className="flex items-center gap-1 group transition-all duration-500"
        >
          <div className="flex items-center space-x-1 px-2 py-1 rounded-md group-hover:bg-[#00ffaa]/10 group-hover:shadow-[0_0_15px_rgba(0,255,170,0.3)]">
            <span
              className={`text-white ${textSizeClass} font-bold transition-all duration-300 group-hover:text-[#00ffaa]/80`}
            >
              HYLIFE
            </span>
            <span
              className={`text-[#00ffaa] ${textSizeClass} font-bold transition-all duration-300 group-hover:text-white`}
            >
              e-Approval
            </span>
            {windowWidth > 320 && (
              <span className="ml-2 px-1 text-[#00ffaa] text-[10px] font-semibold bg-[#00ffaa]/20 rounded-full group-hover:bg-[#00ffaa]/40 group-hover:scale-110 transition-all">
                v1.0
              </span>
            )}
          </div>
        </Link>

        {/* ===== กลาง: เมนูหลัก with Enhanced Effects ===== */}
        <div className="flex-1 min-w-0 flex justify-center">
          <div className="max-w-7xl mx-auto px-4">
            <nav className="hidden lg:flex items-center justify-center space-x-2">
              <Link
                to="/"
                className={`${navLinkClass} ${isActive(
                  "/"
                )} ${underlineAnimation("/")} ${neonGlow}`}
              >
                <Home
                  className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                    location.pathname === "/" ? "text-[#00ffaa] scale-110" : ""
                  }`}
                />
                <span className={`font-medium ${textSizeClass}`}>
                  {t("dashboard")}
                </span>
              </Link>

              <Link
                to="/memotype"
                className={`${navLinkClass} ${isActive(
                  "/memotype"
                )} ${underlineAnimation("/memotype")} ${neonGlow}`}
              >
                <FontAwesomeIcon
                  icon={faFilePen}
                  className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                    location.pathname === "/memotype"
                      ? "text-[#00ffaa] scale-110"
                      : ""
                  }`}
                />
                <span className={`font-medium ${textSizeClass}`}>
                  {t("createMemo")}
                </span>
              </Link>

              {/* <Link
                to="/memos/new"
                className={`${navLinkClass} ${isActive(
                  "/memos/new"
                )} ${underlineAnimation("/memos/new")} ${neonGlow}`}
              >
                <FontAwesomeIcon
                  icon={faFilePen}
                  className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                    location.pathname === "/memos/new"
                      ? "text-[#00ffaa] scale-110"
                      : ""
                  }`}
                />
                <span className={`font-medium ${textSizeClass}`}>
                  {t("createMemo")}
                </span>
              </Link> */}
{/* 
              <Link
                to="/appover"
                className={`${navLinkClass} ${isActive(
                  "/appover"
                )} ${mobileHighlight}`}
                onClick={() => setMobileOpen(false)}
              >
                <FileSymlink
                  className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                    location.pathname === "/appover"
                      ? "text-[#00ffaa] scale-110"
                      : ""
                  }`}
                />
                <span className={`font-medium ${textSizeClass}`}>
                  {t("approvar")}
                </span>
                {location.pathname === "/appover" && (
                  <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                )}
              </Link> */}
              {/* ===== Memo Admin Tools (Desktop dropdown) ===== */}
              {canSeeSettings && (
                <div ref={managementRef} className="relative">
                  <button
                    onClick={() => {
                      setAdminOpen(false); // กันชนกับ admin dropdown
                      setManagementOpen((prev) => !prev);
                    }}
                    className={`
                      ${navLinkClass}
                      ${
                        memoToolsPaths.includes(location.pathname)
                          ? activeClass
                          : inactiveClass
                      }
                      ${underlineAnimation(memoToolsPaths)}
                      ${neonGlow}
                    `}
                  >
                    <FontAwesomeIcon
                      icon={faCog}
                      className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                        memoToolsPaths.includes(location.pathname) || managementOpen
                          ? "text-[#00ffaa] scale-110"
                          : ""
                      }`}
                    />
                    <span className={`font-medium ${textSizeClass}`}>
                      {t("memoTools")}
                    </span>
                    {managementOpen ? (
                      <ChevronUp className="h-4 w-4 text-[#00ffaa] transition-transform duration-300 group-hover:scale-125" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-gray-200 transition-transform duration-300 group-hover:scale-125" />
                    )}
                  </button>

                  <Transition
                    as="div"
                    show={managementOpen}
                    enter="transition ease-out duration-200"
                    enterFrom="transform opacity-0 -translate-y-2"
                    enterTo="transform opacity-100 translate-y-0"
                    leave="transition ease-in duration-150"
                    leaveFrom="transform opacity-100 translate-y-0"
                    leaveTo="transform opacity-0 -translate-y-2"
                    className="absolute top-full left-0 mt-1 w-52 bg-[#0a1f1a]/95 backdrop-blur-lg rounded-md shadow-lg overflow-hidden border border-[#00ffaa]/20 z-50"
                  >
                    <Link
                      to="/memotype-manager"
                      onClick={() => setManagementOpen(false)}
                      className={`
                        flex items-center gap-2 px-4 py-2
                        hover:bg-[#00ffaa]/10 hover:pl-5 hover:shadow-[0_0_10px_#00ffaa33]
                        transition-all duration-300
                        ${isActive("/memotype-manager")}
                      `}
                    >
                      <ListTreeIcon className="h-4 w-4 text-green-300 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-125" />
                      <span className="text-sm text-gray-200">
                        {t("typeMgmt")}
                      </span>
                    </Link>

                    <Link
                      to="/cc-groups"
                      onClick={() => setManagementOpen(false)}
                      className={`
                        flex items-center gap-2 px-4 py-2
                        hover:bg-[#00ffaa]/10 hover:pl-5 hover:shadow-[0_0_10px_#00ffaa33]
                        transition-all duration-300
                        ${isActive("/cc-groups")}
                      `}
                    >
                      <FontAwesomeIcon
                        icon={faPeopleGroup}
                        className="h-4 w-4 text-green-300 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-125"
                      />
                      <span className="text-sm text-gray-200">
                        {t("ccgroups")}
                      </span>
                    </Link>

                    <Link
                      to="/approver-lines"
                      onClick={() => setManagementOpen(false)}
                      className={`
                        flex items-center gap-2 px-4 py-2
                        hover:bg-[#00ffaa]/10 hover:pl-5 hover:shadow-[0_0_10px_#00ffaa33]
                        transition-all duration-300
                        ${isActive("/approver-lines")}
                      `}
                    >
                      <FontAwesomeIcon
                        icon={faArrowDownWideShort}
                        className="h-4 w-4 text-green-300 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-125"
                      />
                      <span className="text-sm text-gray-200">
                        {t("approversline")}
                      </span>
                    </Link>
                  </Transition>
                </div>
              )}

              {canSeeAdmin && (
                <div ref={adminRef} className="relative">
                  <button
                    onClick={() => {
                      setManagementOpen(false);
                      setAdminOpen((prev) => !prev);
                    }}
                    className={`
        ${navLinkClass}
        ${adminOpen ? "text-[#00ffaa]" : "text-gray-200 hover:text-white"}
        ${underlineAnimation(
          adminOpen || location.pathname.startsWith("/admin") ? "/admin" : ""
        )}
        ${neonGlow}
      `}
                  >
                    <Users
                      className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                        adminOpen ? "text-[#00ffaa] scale-110" : ""
                      }`}
                    />
                    <span className={`font-medium ${textSizeClass}`}>
                      {t("adminTools")}
                    </span>
                    {adminOpen ? (
                      <ChevronUp className="h-4 w-4 text-[#00ffaa] transition-transform duration-300 group-hover:scale-125" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-gray-200 transition-transform duration-300 group-hover:scale-125" />
                    )}
                  </button>

                  <Transition
                    as="div"
                    show={adminOpen}
                    enter="transition ease-out duration-200"
                    enterFrom="transform opacity-0 -translate-y-2"
                    enterTo="transform opacity-100 translate-y-0"
                    leave="transition ease-in duration-150"
                    leaveFrom="transform opacity-100 translate-y-0"
                    leaveTo="transform opacity-0 -translate-y-2"
                    className="absolute top-full left-0 mt-1 w-44 bg-[#0a1f1a]/95 backdrop-blur-lg rounded-md shadow-lg overflow-hidden border border-[#00ffaa]/20"
                  >
                    <Link
                      to="/user"
                      onClick={() => setAdminOpen(false)}
                      className={`
          flex items-center gap-2 px-4 py-2
          hover:bg-[#00ffaa]/10 hover:pl-5 hover:shadow-[0_0_10px_#00ffaa33]
          transition-all duration-300
          ${isActive("/user")}
        `}
                    >
                      <FontAwesomeIcon
                        icon={faUserPlus}
                        className="h-4 w-4 text-green-300 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-125"
                      />
                      <span
                        className={`text-sm text-gray-200 ${textSizeClass}`}
                      >
                        {t("createUser")}
                      </span>
                    </Link>

                    <Link
                      to="/department"
                      onClick={() => setAdminOpen(false)}
                      className={`
          flex items-center gap-2 px-4 py-2
          hover:bg-[#00ffaa]/10 hover:pl-5 hover:shadow-[0_0_10px_#00ffaa33]
          transition-all duration-300
          ${isActive("/department")}
        `}
                    >
                      <FontAwesomeIcon
                        icon={faStapler}
                        className="h-4 w-4 text-green-300 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-125"
                      />
                      <span className={`text-sm ${textSizeClass}`}>
                        {t("createDept")}
                      </span>
                    </Link>

                    <Link
                      to="/business-units"
                      onClick={() => setAdminOpen(false)}
                      className={`
          flex items-center gap-2 px-4 py-2
          hover:bg-[#00ffaa]/10 hover:pl-5 hover:shadow-[0_0_10px_#00ffaa33]
          transition-all duration-300
          ${isActive("business-units")}
        `}
                    >
                      <FontAwesomeIcon
                        icon={faBuilding}
                        className="h-4 w-4 text-green-300 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-125"
                      />
                      <span className={`text-sm ${textSizeClass}`}>
                        {t("createBU")}
                      </span>
                    </Link>
                  </Transition>
                </div>
              )}
            </nav>
          </div>
        </div>

        {/* ===== ขวา: Enhanced Right Side Menu ===== */}
        <div className="flex items-center space-x-4">
          {/* ปุ่มสลับภาษา with Hover Effect */}
          {windowWidth > 320 && (
            <button
              type="button"
              onClick={() =>
                i18n.changeLanguage(shortLang === "th" ? "en" : "th")
              }
              className="relative px-2 py-1 overflow-hidden border rounded-md text-gray-200 border-gray-400
             transition-all duration-300 hover:text-white hover:border-[#00ffaa]
             hover:shadow-[0_0_10px_#00ffaa33] group"
            >
              {/* label ด้านหน้า */}
              <span className="relative z-10">{shortLang.toUpperCase()}</span>

              {/* ชั้นไหลสี – ใช้ span แทน pseudo‑element */}
              <span
                aria-hidden
                className="absolute inset-0 -translate-x-full bg-[#00ffaa]/10
               transition-transform duration-500 group-hover:translate-x-0"
              />
            </button>
          )}

          {/* Notification – ส่ง mobile flag เมื่อจอแคบ */}
          <NotificationDropdown
            mobile={windowWidth <= 640}
            onItemClick={() => setMobileOpen(false)}
            bellClassName="relative px-2 py-1"
          />
          {/* Logout (Desktop) with name & email */}
          {windowWidth > 768 && (
            <div className="relative group" ref={userMenuRef}>
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2 group rounded-lg ..."
              >
                {/* Avatar */}
                {profileImageUrl ? (
                  <img
                    src={profileImageUrl}
                    alt="avatar"
                    className="w-8 h-8 rounded-full object-cover"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      e.currentTarget.src = "/img/default-avatar.png";
                    }}
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-gradient-to-r from-[#00ffaa] to-[#00cc88] flex items-center justify-center font-bold text-gray-900">
                    {name
                      ? name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")
                          .toUpperCase()
                          .slice(0, 2)
                      : "U"}
                  </div>
                )}

                {/* ชื่อ-เมล */}
                <div className="flex flex-col items-end">
                  {displayName && (
                    <span className="text-gray-200 font-medium truncate">
                      {displayName}
                    </span>
                  )}
                  {email && (
                    <span className="text-gray-400 text-xs truncate">
                      {email}
                    </span>
                  )}
                </div>

                <ChevronDown
                  className={`h-4 w-4 transition-transform ${
                    userMenuOpen ? "rotate-180 text-[#00ffaa]" : ""
                  }`}
                />
              </button>

              {/* User dropdown menu */}
              <Transition
                show={userMenuOpen}
                as={Fragment}
                enter="transition ease-out duration-200"
                enterFrom="opacity-0 translate-y-1"
                enterTo="opacity-100 translate-y-0"
                leave="transition ease-in duration-150"
                leaveFrom="opacity-100 translate-y-0"
                leaveTo="opacity-0 translate-y-1"
              >
                <div className="absolute right-0 mt-2 w-64 bg-[#0a1f1a]/95 backdrop-blur-lg rounded-lg shadow-xl z-50 border border-[#00ffaa]/20 overflow-hidden">
                  {/* View Profile Option */}
                  <Link
                    to="/profile"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-3 px-4 py-3 text-sm text-gray-200 hover:bg-[#00ffaa]/10 transition-colors duration-300"
                  >
                    <User className="h-5 w-5 text-[#00ffaa]" />
                    <span>{t("profile")}</span>
                  </Link>

                  {/* Logout Button */}
                  <button
                    onClick={() => {
                      handleLogout();
                      setUserMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-200 hover:bg-red-500/20 transition-colors duration-300 border-t border-[#00ffaa]/10"
                  >
                    <LogOut className="h-5 w-5 text-red-400" />
                    <span>{t("logout")}</span>
                  </button>
                </div>
              </Transition>
            </div>
          )}

          {/* Hamburger (Mobile) with Enhanced Animation */}
          <button
            onClick={() => setMobileOpen((prev) => !prev)}
            className={`
              lg:hidden text-gray-200 hover:text-white
              focus:outline-none px-2 py-1 rounded-md
              transition-all duration-500
              ${mobileOpen ? "rotate-90 bg-[#00ffaa]/10" : "rotate-0"}
              hover:bg-[#00ffaa]/10 hover:shadow-[0_0_10px_#00ffaa33]
            `}
          >
            {mobileOpen ? (
              <X className="h-6 w-6 transition-transform duration-500 hover:scale-125" />
            ) : (
              <Menu className="h-6 w-6 transition-transform duration-500 hover:scale-125" />
            )}
          </button>
        </div>

        {/* ===== Enhanced Mobile Dropdown Menu ===== */}
        {mobileOpen && (
          <div
            className={`
            lg:hidden fixed inset-x-0 top-16
            bg-[#0a1f1a]/95 backdrop-blur-lg shadow-xl
            border-t border-[#00ffaa]/20
            transition-all duration-500 ease-in-out
            ${
              mobileOpen
                ? "opacity-100 translate-y-0"
                : "opacity-0 -translate-y-2"
            }
            z-50 overflow-visible
          `}
          >
            <div className="flex flex-col px-4 py-3 space-y-2">
              <Link
                to="/"
                className={`${navLinkClass} ${isActive(
                  "/"
                )} ${mobileHighlight}`}
                onClick={() => setMobileOpen(false)}
              >
                <Home
                  className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                    location.pathname === "/" ? "text-[#00ffaa] scale-110" : ""
                  }`}
                />
                <span className={`font-medium ${textSizeClass}`}>
                  {t("dashboard")}
                </span>
                {location.pathname === "/" && (
                  <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                )}
              </Link>

              {/* {canSeeSettings && (
                <Link
                  to="/approval-line"
                  className={`${navLinkClass} ${isActive(
                    "/approval-line"
                  )} ${mobileHighlight}`}
                  onClick={() => setMobileOpen(false)}
                >
                  <FilePen
                    className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                      location.pathname === "/approval-line"
                        ? "text-[#00ffaa] scale-110"
                        : ""
                    }`}
                  />
                  <span className={`font-medium ${textSizeClass}`}>
                    {t("approvalline")}
                  </span>
                  {location.pathname === "/approval-line" && (
                    <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                  )}
                </Link>
              )} */}

              <Link
                to="/profile"
                className={`${navLinkClass} ${isActive(
                  "/profile"
                )} ${mobileHighlight}`}
                onClick={() => setMobileOpen(false)}
              >
                <User
                  className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                    location.pathname === "/profile"
                      ? "text-[#00ffaa] scale-110"
                      : ""
                  }`}
                />
                <span className={`font-medium ${textSizeClass}`}>
                  {t("profile")}
                </span>
                {location.pathname === "/profile" && (
                  <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                )}
              </Link>
{/* 
              <Link
                to="/appover"
                className={`${navLinkClass} ${isActive(
                  "/appover"
                )} ${mobileHighlight}`}
                onClick={() => setMobileOpen(false)}
              >
                <FileSymlink
                  className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                    location.pathname === "/appover"
                      ? "text-[#00ffaa] scale-110"
                      : ""
                  }`}
                />
                <span className={`font-medium ${textSizeClass}`}>
                  {t("approvar")}
                </span>
                {location.pathname === "/appover" && (
                  <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                )}
              </Link> */}

              <Link
                to="/memotype"
                className={`${navLinkClass} ${isActive(
                  "/memotype"
                )} ${mobileHighlight}`}
                onClick={() => setMobileOpen(false)}
              >
                <FontAwesomeIcon
                  icon={faFilePen}
                  className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                    location.pathname === "/memotype"
                      ? "text-[#00ffaa] scale-110"
                      : ""
                  }`}
                />
                <span className={`font-medium ${textSizeClass}`}>
                  {t("createMemo")}
                </span>
                {location.pathname === "/memotype" && (
                  <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                )}
              </Link>

              {/* ===== Memo Admin Tools (Mobile dropdown) ===== */}
              {canSeeSettings && (
                <>
                  <button
                    onClick={() => setManagementOpen((prev) => !prev)}
                    className={`${navLinkClass} ${mobileHighlight} ${
                      managementOpen ? "bg-[#00ffaa]/10" : ""
                    }`}
                  >
                    <FontAwesomeIcon
                      icon={faCog}
                      className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                        memoToolsPaths.includes(location.pathname) || managementOpen
                          ? "text-[#00ffaa] scale-110"
                          : ""
                      }`}
                    />
                    <span
                      className={`font-medium text-gray-200 ${textSizeClass}`}
                    >
                      {t("memoTools")}
                    </span>
                    {managementOpen ? (
                      <ChevronUp className="h-4 w-4 text-[#00ffaa] ml-auto transform transition-transform duration-300" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-gray-200 ml-auto transform transition-transform duration-300" />
                    )}
                  </button>

                  {managementOpen && (
                    <div className="pl-6 flex flex-col space-y-1 animate-fadeIn">
                      <Link
                        to="/memotype-manager"
                        className={`${navLinkClass} ${isActive(
                          "/memotype-manager"
                        )} ${mobileHighlight}`}
                        onClick={() => {
                          setManagementOpen(false);
                          setMobileOpen(false);
                        }}
                      >
                        <ListTreeIcon className={`h-4 w-4 text-green-300 ${iconAnimation}`} />
                        <span className={`text-sm ${textSizeClass}`}>
                          {t("typeMgmt")}
                        </span>
                        {location.pathname === "/memotype-manager" && (
                          <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                        )}
                      </Link>

                      <Link
                        to="/cc-groups"
                        className={`${navLinkClass} ${isActive(
                          "/cc-groups"
                        )} ${mobileHighlight}`}
                        onClick={() => {
                          setManagementOpen(false);
                          setMobileOpen(false);
                        }}
                      >
                        <FontAwesomeIcon
                          icon={faPeopleGroup}
                          className={`h-4 w-4 text-green-300 ${iconAnimation}`}
                        />
                        <span className={`text-sm ${textSizeClass}`}>
                          {t("ccgroups")}
                        </span>
                        {location.pathname === "/cc-groups" && (
                          <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                        )}
                      </Link>

                      {/* <Link
                        to="/approversline"
                        className={`${navLinkClass} ${isActive(
                          "/approversline"
                        )} ${mobileHighlight}`}
                        onClick={() => {
                          setManagementOpen(false);
                          setMobileOpen(false);
                        }}
                      >
                        <FontAwesomeIcon
                          icon={faArrowDownWideShort}
                          className={`h-4 w-4 text-green-300 ${iconAnimation}`}
                        />
                        <span className={`text-sm ${textSizeClass}`}>
                          {t("approversline")}
                        </span>
                        {location.pathname === "/approversline" && (
                          <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                        )}
                      </Link> */}
                    </div>
                  )}
                </>
              )}


              {canSeeAdmin && (
                <>
                  <button
                    onClick={() => setAdminOpen((prev) => !prev)}
                    className={`${navLinkClass} ${mobileHighlight} ${
                      adminOpen ? "bg-[#00ffaa]/10" : ""
                    }`}
                  >
                    <Users
                      className={`h-5 w-5 text-green-300 ${iconAnimation} ${
                        adminOpen ? "text-[#00ffaa] scale-110" : ""
                      }`}
                    />
                    <span
                      className={`font-medium text-gray-200  ${textSizeClass}`}
                    >
                      {t("adminTools")}
                    </span>
                    {adminOpen ? (
                      <ChevronUp className="h-4 w-4 text-[#00ffaa] transform transition-transform duration-300 ml-auto" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-gray-200 transform transition-transform duration-300 ml-auto" />
                    )}
                  </button>
                  {adminOpen && (
                    <div
                      ref={mobileAdminRef}
                      className="pl-6 flex flex-col space-y-1 animate-fadeIn z-50"
                    >
                      <Link
                        to="/user"
                        className={`${navLinkClass} ${isActive(
                          "/user"
                        )} ${mobileHighlight}`}
                        onClick={() => {
                          setAdminOpen(false);
                          setMobileOpen(false);
                        }}
                      >
                        <FontAwesomeIcon
                          icon={faUserPlus}
                          className={`h-4 w-4 text-green-300 ${iconAnimation}`}
                        />
                        <span className={`text-sm ${textSizeClass}`}>
                          {t("createUser")}
                        </span>
                        {location.pathname === "/user" && (
                          <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                        )}
                      </Link>
                      <Link
                        to="/department"
                        className={`${navLinkClass} ${isActive(
                          "/department"
                        )} ${mobileHighlight}`}
                        onClick={() => {
                          setAdminOpen(false);
                          setMobileOpen(false);
                        }}
                      >
                        <FontAwesomeIcon
                          icon={faStapler}
                          className={`h-4 w-4 text-green-300 ${iconAnimation}`}
                        />
                        <span className={`text-sm ${textSizeClass}`}>
                          {t("createDept")}
                        </span>
                        {location.pathname === "/department" && (
                          <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                        )}
                      </Link>
                      <Link
                        to="business-units"
                        className={`${navLinkClass} ${isActive(
                          "business-units"
                        )} ${mobileHighlight}`}
                        onClick={() => {
                          setAdminOpen(false);
                          setMobileOpen(false);
                        }}
                      >
                        <FontAwesomeIcon
                          icon={faBuilding}
                          className={`h-4 w-4 text-green-300 ${iconAnimation}`}
                        />
                        <span className={`text-sm ${textSizeClass}`}>
                          {t("createBU")}
                        </span>
                        {location.pathname === "business-units" && (
                          <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-3/4 h-[2px] bg-[#00ffaa] rounded-full" />
                        )}
                      </Link>
                    </div>
                  )}
                </>
              )}

              {/* ปุ่มสลับภาษา (Mobile) */}
              {windowWidth <= 320 && (
                <button
                  onClick={() =>
                    i18n.changeLanguage(i18n.language === "th" ? "en" : "th")
                  }
                  className={`${navLinkClass} ${mobileHighlight}`}
                >
                  <span
                    className={`font-medium text-gray-200 ${textSizeClass}`}
                  >
                    {t("switchLang")}: {i18n.language.toUpperCase()}
                  </span>
                </button>
              )}

              {/* Logout (Mobile) with Enhanced Effect */}
              <button
                onClick={() => {
                  handleLogout();
                  setMobileOpen(false);
                }}
                className={`${navLinkClass} ${mobileHighlight} hover:bg-red-500/10 hover:shadow-[0_0_10px_rgba(255,0,0,0.3)]`}
              >
                <LogOut className={`h-5 w-5 text-red-400 ${iconAnimation}`} />
                <span className={`font-medium text-gray-200 ${textSizeClass}`}>
                  {t("logout")}
                </span>
              </button>
            </div>
          </div>
        )}
      </nav>
    </>
  );
}
