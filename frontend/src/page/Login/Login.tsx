import React, { useEffect, useRef, useState } from "react";
import "./Login.css";
import { FaEnvelope, FaLock, FaEye, FaEyeSlash } from "react-icons/fa";
import { useNavigate, useLocation } from "react-router-dom";
const normalizeEmail = (s: string) =>
  (s ?? "").normalize("NFKC").trim().toLowerCase();

export default function LoginPage() {
  const navigate = useNavigate();
  const { search } = useLocation();
  const params = new URLSearchParams(search);

  const bg = `${import.meta.env.BASE_URL}img/hylife_3D.png`;
  const logo = `${import.meta.env.BASE_URL}img/New-ememo-icon-4.png`;
  const charImg = `${import.meta.env.BASE_URL}img/Mhanrun.png`;

  const emailToken = params.get("token");
  const memoId = params.get("memoId");
  const redirect = params.get("redirect") || "/";
  const isArchivedLogout = params.get("reason") === "archived";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errorVisible, setErrorVisible] = useState(false);
  const [loginErrorMsg, setLoginErrorMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailLoginFailed, setEmailLoginFailed] = useState(false);

  /* ================= Runner on Ground ================= */
  const CFG = {
    groundOffset: 8,
    charW: 96,
    follow: 0.04,
    gravity: 0.9,
    jumpVel: 16,
    upGesturePx: 48,
    maxTilt: 12,
    stretchMax: 0.08,
    runBobAmp: 4,
    maxStepX: 1.2,
    pointerLerp: 0.06,
    deadZone: 10,
  };

  const [charX, setCharX] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth / 2 : 0
  );
  const [charH, setCharH] = useState(0);
  const velYRef = useRef(0);
  const pointerRef = useRef({
    x: charX,
    y: typeof window !== "undefined" ? window.innerHeight : 0,
  });
  const prevPointerY = useRef(pointerRef.current.y);
  const reducedMotion = useRef(false);
  const toSafePath = (path: string) =>
    path && path.startsWith("/") ? path : "/";

  // ติดตามเมาส์/ทัช + ตรวจจับ "ยกเมาส์ขึ้น" → กระโดด
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const nx = e.clientX;
      const ny = e.clientY;
      const dyUp = prevPointerY.current - ny;
      if (dyUp > CFG.upGesturePx && charH === 0) velYRef.current = CFG.jumpVel;
      prevPointerY.current = ny;
      pointerRef.current = { x: nx, y: ny };
    };
    const onTouch = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const nx = t.clientX;
      const ny = t.clientY;
      const dyUp = prevPointerY.current - ny;
      if (dyUp > CFG.upGesturePx && charH === 0) velYRef.current = CFG.jumpVel;
      prevPointerY.current = ny;
      pointerRef.current = { x: nx, y: ny };
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && charH === 0) velYRef.current = CFG.jumpVel;
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.code === "Space" || e.code === "ArrowUp") && charH === 0) {
        velYRef.current = CFG.jumpVel;
      }
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("touchmove", onTouch, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [charH]);

  // วิ่งตามเมาส์บนพื้น + ฟิสิกส์กระโดด (ไม่มีพารัลแลกซ์แล้ว)
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.current = mq.matches;

    let runPhase = 0;
    let raf = 0;

    const tick = () => {
      // ----- Horizontal follow -----
      const targetX = Math.max(
        CFG.charW / 2,
        Math.min(window.innerWidth - CFG.charW / 2, pointerRef.current.x)
      );
      const nextX = reducedMotion.current
        ? targetX
        : charX + (targetX - charX) * CFG.follow;
      const vx = nextX - charX;

      // ----- Vertical jump physics -----
      let vy = velYRef.current;
      if (!reducedMotion.current) {
        vy -= CFG.gravity;
        let nextH = charH + vy;
        if (nextH <= 0) {
          nextH = 0;
          vy = 0;
          if (Math.abs(vx) > 0.5)
            runPhase += Math.min(Math.abs(vx) * 0.15, 0.35);
        }
        velYRef.current = vy;
        setCharH(nextH);
      } else {
        setCharH(0);
        velYRef.current = 0;
      }

      setCharX(nextX);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [charX, charH]);

  // สไตล์ตัวละคร
  const faceLeft = pointerRef.current.x < charX ? -1 : 1;
  const vx = pointerRef.current.x - charX;
  const tilt = Math.max(-CFG.maxTilt, Math.min(CFG.maxTilt, vx * 0.08));
  const speed = Math.abs(vx);
  const stretch = Math.min(CFG.stretchMax, speed / 1400);
  const scaleX = faceLeft * (1 + stretch);
  const scaleY = 1 - stretch;

  const running = charH === 0 && Math.abs(vx) > 0.6;
  const bob = running ? CFG.runBobAmp * Math.sin(charX / 18) : 0;

  /* ================= Auth flow เดิม ================= */
  useEffect(() => {
    if (!emailToken) return;

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/auth/email-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ token: emailToken }),
        });
        if (!res.ok) throw new Error(await res.text());

        if (cancelled) return;

        // ✅ ถ้ามี memoId ให้เด้งเข้าเมโมนั้นทันที ไม่งั้นค่อยใช้ redirect (แบบปลอดภัย)
        const safe = toSafePath(redirect);
        navigate(memoId ? `/memo/${memoId}` : safe, { replace: true });
      } catch (err) {
        console.error("Email login failed:", err);
        setErrorVisible(true);
        setEmailLoginFailed(true); // ⬅️ ล้มเหลวให้กลับไปแสดงฟอร์ม
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [emailToken, memoId, redirect, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorVisible(false);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: normalizeEmail(email), password }),
      });
      
      if (!res.ok) {
        let errMsg = "Login failed";
        try {
          const errorData = await res.json();
          errMsg = errorData.message || errMsg;
        } catch (_) {
          // Fallback to text if JSON parsing fails
        }
        if (errMsg === "Invalid credentials") {
          errMsg = "Invalid email or password. Please try again.";
        }
        throw new Error(errMsg);
      }
      
      const data = await res.json();
      
      // Check if this is first-time login
      if (data.isFirstLogin) {
        navigate("/change-password", { replace: true });
        return;
      }
      
      // Normal login flow
      if (memoId) navigate(`/memo/${memoId}`, { replace: true });
      else {
        const safe = toSafePath(redirect);
        navigate(safe, { replace: true });
      }
    } catch (error: any) {
      setLoginErrorMsg(error.message || "Invalid email or password. Please try again.");
      setErrorVisible(true);
      const form = document.querySelector(".auth-form") as HTMLElement | null;
      if (form) {
        form.style.animation = "shake 0.4s ease";
        setTimeout(() => (form.style.animation = ""), 400);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100svh] grid items-center gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:grid-cols-2 relative overflow-hidden">
      {/* Runner at the Bottom */}
      {/* <div
        className="fixed pointer-events-none z-[60]"
        style={{
          left: `${charX}px`,
          bottom: `${CFG.groundOffset + charH + bob}px`,
          transform: `translateX(-50%) rotate(${tilt}deg) scale(${scaleX}, ${scaleY})`,
          filter: `drop-shadow(0 10px ${10 + Math.min(speed / 30, 30)}px rgba(0,0,0,0.18))`,
          willChange: "transform, bottom, filter",
        }}
      >
        <img
          src={charImg}
          alt=""
          className="w-16 sm:w-18 lg:w-20 select-none"
          draggable={false}
        />
      </div> */}

      {/* Brand - Desktop */}
      <div className="absolute left-0 top-2 hidden lg:flex items-center gap-2 p-6 group z-20">
        <div className="relative">
          <div className="absolute -inset-1 bg-gradient-to-r from-gray-200 to-gray-100 rounded-full opacity-0 group-hover:opacity-100 blur transition-opacity duration-500" />
          <img
            src={logo}
            alt="HYLIFE E-APPROVAL"
            className="relative h-[18px] w-[18px] object-contain select-none transition-transform duration-300 group-hover:scale-110"
            draggable={false}
          />
        </div>
        <span className="font-bold tracking-[0.2px] transition-all duration-300 group-hover:tracking-[0.4px]">
          HYLIFE E-APPROVAL
        </span>
      </div>

      {/* FORM */}
      <section className="relative order-1 lg:order-2 grid content-center justify-items-center z-10">
        {/* Brand - Mobile */}
        <div className="mb-4 flex items-center justify-center gap-2 lg:hidden group">
          <div className="relative">
            <div className="absolute -inset-1 bg-gradient-to-r from-gray-200 to-gray-100 rounded-full opacity-0 group-hover:opacity-100 blur transition-opacity duration-500" />
            <img
              src={logo}
              alt="HYLIFE E-APPROVAL"
              className="relative h-5 w-5 object-contain select-none transition-transform duration-300 group-hover:scale-110"
              draggable={false}
            />
          </div>
          <span className="font-semibold transition-all duration-300 group-hover:tracking-[0.3px]">
            HYLIFE E-APPROVAL
          </span>
        </div>

        {/* Mobile image */}
        <div className="mb-4 w-full sm:hidden">
          <img
            src={bg}
            alt=""
            className="w-full max-h-48 object-contain select-none"
            draggable={false}
          />
        </div>

        <div className="w-full max-w-[420px]">
          <h1 className="mb-1 text-2xl sm:text-3xl lg:text-[34px] font-extrabold leading-tight text-gray-900">
            Sign in to your account
          </h1>
          <p className="mb-6 text-gray-500">
            Enter your email and password to continue
          </p>

          {emailToken && !emailLoginFailed ? (
            <div className="text-sm text-gray-600">กำลังเข้าสู่ระบบ…</div>
          ) : (
            <form
              className="auth-form flex w-full flex-col gap-3"
              onSubmit={handleSubmit}
            >
              {isArchivedLogout && (
                <div className="rounded-xl border border-orange-200 bg-orange-100/70 px-3 py-2 text-sm text-orange-700">
                  Your account has been deactivated. Please contact your administrator.
                </div>
              )}

              {emailLoginFailed && (
                <div className="rounded-xl border border-red-200 bg-red-100/70 px-3 py-2 text-sm text-red-700">
                  Email link invalid or expired. Please log in with your
                  password.
                </div>
              )}

              {errorVisible && (
                <div className="rounded-xl border border-red-200 bg-red-100/70 px-3 py-2 text-sm text-red-700 animate-fade-in">
                  {loginErrorMsg || "Invalid email or password. Please try again."}
                </div>
              )}

              <label className="text-xs text-gray-600">
                Email<span className="text-red-500">*</span>
              </label>
              <div className="relative flex items-center group">
                <FaEnvelope className="pointer-events-none absolute left-3 text-sm text-gray-400 transition-colors duration-200 group-focus-within:text-gray-600" />
                <input
                  type="email"
                  placeholder="Enter your email"
                  className="h-11 w-full rounded-full border border-gray-200 bg-white pl-10 pr-4 text-sm outline-none placeholder:text-gray-400 transition-all duration-200 focus:border-gray-400 focus:ring-4 focus:ring-black/5 hover:border-gray-300"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={(e) => setEmail(normalizeEmail(e.target.value))}
                  required
                  autoComplete="username"
                  inputMode="email"
                />
              </div>

              <label className="text-xs text-gray-600">
                Password<span className="text-red-500">*</span>
              </label>
              <div className="relative flex items-center group">
                <FaLock className="pointer-events-none absolute left-3 text-sm text-gray-400 transition-colors duration-200 group-focus-within:text-gray-600" />
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter your password"
                  className="h-11 w-full rounded-full border border-gray-200 bg-white pl-10 pr-10 text-sm outline-none placeholder:text-gray-400 transition-all duration-200 focus:border-gray-400 focus:ring-4 focus:ring-black/5 hover:border-gray-300"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-1 grid h-9 w-9 place-items-center rounded-lg text-gray-400 transition-all duration-200 hover:bg-gray-100 hover:text-gray-600"
                >
                  {showPassword ? <FaEyeSlash /> : <FaEye />}
                </button>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-1 inline-flex h-11 w-full items-center justify-center rounded-full border border-black bg-black font-semibold text-white transition-all duration-200 hover:bg-gray-900 hover:shadow-lg hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0 disabled:hover:shadow-none"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <svg
                      className="animate-spin h-4 w-4"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    Please wait…
                  </span>
                ) : (
                  "Log In"
                )}
              </button>
            </form>
          )}
        </div>
      </section>

      {/* IMAGE — no parallax, no hover */}
      <aside className="order-2 lg:order-1 hidden md:block">
        <div
          className="h-[260px] sm:h-[340px] lg:h-[78vh] bg-no-repeat bg-contain bg-left"
          style={{ backgroundImage: `url(${bg})` }}
          aria-hidden="true"
        />
      </aside>
    </div>
  );
}
