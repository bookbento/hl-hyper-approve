import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Home, User, LogOut } from "lucide-react";
import {
  faFilePen,
  faStapler,
  faUserPlus,
  faUsers,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import axios from "axios";

function Navigation() {
  const location = useLocation();
  const [role, setRole] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (path: string) =>
    location.pathname === path ? "bg-green-900/30 text-green-300 rounded-md" : "";

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
      if (window.innerWidth >= 768) setMobileOpen(false);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    axios
      .get("http://localhost:3001/api/me", { withCredentials: true })
      .then((res) => {
        setRole(res.data.role);
      })
      .catch((err) => {
        console.error("Not authenticated:", err);
        window.location.href = "/login";
      });
  }, []);

  const handleLogout = () => {
    axios.post(
      "http://localhost:3001/api/auth/logout",
      {},
      { withCredentials: true }
    );
    window.location.href = "/login";
  };

  return (
    <>
      {/* Mobile Hamburger Button */}
      {isMobile && (
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="fixed top-4 left-4 z-50 p-2 rounded-lg bg-[#183e33] text-white shadow-lg md:hidden"
        >
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>
      )}

      {/* Navbar */}
      <nav
        className={`fixed md:relative z-40 w-72 h-screen bg-[#0a1f1a] text-white flex flex-col px-4 py-6 border-r border-green-900/30 transition-all duration-300 ${
          isMobile
            ? mobileOpen
              ? "left-0 shadow-2xl"
              : "-left-72"
            : "left-0"
        }`}
      >
        {/* Improved Header with Logo */}
        <div className="flex flex-col items-center mb-10 px-2 py-3">
          <Link
            to="/"
            className="flex flex-col items-center group transition-all duration-300"
          >
            <div className="relative flex items-center justify-center mb-3">
              <img
                src="/img/HYMEMO_W.png"
                alt="Logo"
                className="h-16 w-16 object-contain transition-transform duration-300 group-hover:scale-110"
              />
              <div className="absolute inset-0 bg-green-500/10 rounded-full blur-md opacity-0 group-hover:opacity-100 transition-opacity duration-300 -z-10"></div>
            </div>
            
            <div className="flex flex-col items-center">
              <span className="font-bold text-2xl text-white tracking-tight">
                HYLIFE
              </span>
              <span className="font-bold text-xl text-green-300 tracking-wider">
                E-APPROVAL
              </span>
            </div>
          </Link>
        </div>

        {/* Navigation Menu */}
        <div className="flex flex-col space-y-2 flex-grow overflow-y-auto">
          {/* ... rest of your navigation links remain the same ... */}
          <Link
            to="/"
            className={`flex items-center gap-3 px-4 py-3 hover:bg-green-900/20 rounded-lg transition-all ${isActive(
              "/"
            )}`}
          >
            <Home className="h-5 w-5 text-green-300" />
            <span className="font-medium">Dashboard</span>
            {location.pathname === "/" && (
              <span className="ml-auto w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
            )}
          </Link>

          <Link
            to="/profile"
            className={`flex items-center gap-3 px-4 py-3 hover:bg-green-900/20 rounded-lg transition-all ${isActive(
              "/profile"
            )}`}
          >
            <User className="h-5 w-5 text-green-300" />
            <span className="font-medium">Profile</span>
            {location.pathname === "/profile" && (
              <span className="ml-auto w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
            )}
          </Link>

          <Link
            to="/memos/new"
            className={`flex items-center gap-3 px-4 py-3 hover:bg-green-900/20 rounded-lg transition-all ${isActive(
              "/memos/new"
            )}`}
          >
            <FontAwesomeIcon
              icon={faFilePen}
              className="h-5 w-5 text-green-300"
            />
            <span className="font-medium">Create Memo</span>
            {location.pathname === "/memos/new" && (
              <span className="ml-auto w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
            )}
          </Link>

          {role === "admin" && (
            <>
              <div className="mt-4 mb-2 px-4 text-xs uppercase tracking-wider text-green-400/70">
                Admin Tools
              </div>

              <Link
                to="/user"
                className={`flex items-center gap-3 px-4 py-3 hover:bg-green-900/20 rounded-lg transition-all ${isActive(
                  "/user"
                )}`}
              >
                <FontAwesomeIcon
                  icon={faUserPlus}
                  className="h-5 w-5 text-green-300"
                />
                <span className="font-medium">Create User</span>
                {location.pathname === "/user" && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                )}
              </Link>

              <Link
                to="/team"
                className={`flex items-center gap-3 px-4 py-3 hover:bg-green-900/20 rounded-lg transition-all ${isActive(
                  "/team"
                )}`}
              >
                <FontAwesomeIcon
                  icon={faUsers}
                  className="h-5 w-5 text-green-300"
                />
                <span className="font-medium">Create Team</span>
                {location.pathname === "/team" && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                )}
              </Link>

              <Link
                to="/department"
                className={`flex items-center gap-3 px-4 py-3 hover:bg-green-900/20 rounded-lg transition-all ${isActive(
                  "/department"
                )}`}
              >
                <FontAwesomeIcon
                  icon={faStapler}
                  className="h-5 w-5 text-green-300"
                />
                <span className="font-medium">Create Department</span>
                {location.pathname === "/department" && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                )}
              </Link>

              <Link
                to="/business-units"
                className={`flex items-center gap-3 px-4 py-3 hover:bg-green-900/20 rounded-lg transition-all ${isActive(
                  "/business-units"
                )}`}
              >
                <FontAwesomeIcon
                  icon={faStapler}
                  className="h-5 w-5 text-green-300"
                />
                <span className="font-medium">Create Business-Units</span>
                {location.pathname === "/business-units" && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                )}
              </Link>
            </>
          )}
        </div>

        {/* Logout Button */}
        <button
          onClick={handleLogout}
          className="mt-4 flex items-center justify-center gap-2 w-full bg-green-900/40 hover:bg-green-900/60 text-green-300 font-medium py-2.5 rounded-lg transition-all border border-green-800/50 hover:border-green-500/50"
        >
          <LogOut className="h-5 w-5" />
          <span>Log Out</span>
        </button>

        {/* Version Info */}
        <div className="mt-4 text-center text-xs text-green-400/50">
          HyLife e-Approval V1.0
        </div>
      </nav>

      {/* Overlay for mobile */}
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
    </>
  );
}

export default Navigation;