import React, { useEffect, useState } from "react";
import "./Login.css";
import { FaEnvelope, FaLock, FaEye, FaEyeSlash } from "react-icons/fa";
import { useNavigate, useLocation } from "react-router-dom";
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "framer-motion";
import { AnimatedContent, Aurora, BlurText, ShinyText } from "../../components/motion";

const normalizeEmail = (s: string) =>
  (s ?? "").normalize("NFKC").trim().toLowerCase();

export default function LoginPage() {
  const navigate = useNavigate();
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const reduce = useReducedMotion();
  const formControls = useAnimationControls();

  const hero = `${import.meta.env.BASE_URL}img/hylife_3D.png`;
  const logo = `${import.meta.env.BASE_URL}img/New-ememo-icon-4.png`;

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

  const toSafePath = (path: string) =>
    path && path.startsWith("/") ? path : "/";

  /* ================= Auth flow (unchanged) ================= */
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
      // the old CSS "shake" keyframes were never defined — this one actually runs
      if (!reduce) {
        void formControls.start({
          x: [0, -10, 9, -6, 4, 0],
          transition: { duration: 0.42, ease: "easeInOut" },
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    "peer h-12 w-full rounded-xl border border-gray-200 bg-white/80 pl-11 pr-4 text-sm outline-none " +
    "placeholder:text-gray-400 transition-[border-color,box-shadow,background-color] duration-200 " +
    "hover:border-gray-300 focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-500/15";
  const iconClass =
    "pointer-events-none absolute left-4 text-sm text-gray-400 transition-colors duration-200 peer-focus:text-brand-600";

  return (
    <div className="relative grid min-h-[100svh] bg-white lg:grid-cols-[1.05fr_1fr]">
      {/* ── Brand panel (desktop) ───────────────────────────────────────── */}
      <aside className="relative hidden overflow-hidden bg-brand-900 lg:flex lg:flex-col lg:justify-between lg:p-10 xl:p-14">
        <Aurora />
        <div className="relative z-10 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15 backdrop-blur">
            <img src={logo} alt="" className="h-5 w-5 object-contain" draggable={false} />
          </span>
          <span className="text-sm font-semibold tracking-[0.18em] text-white/90">HYLIFE E-APPROVAL</span>
        </div>

        <div className="relative z-10 max-w-lg">
          <BlurText
            as="h2"
            text="Approvals, without the paper chase."
            className="text-4xl font-semibold leading-[1.1] tracking-tight text-white xl:text-5xl"
            delay={0.1}
          />
          <AnimatedContent delay={0.45} distance={8} className="mt-5">
            <p className="text-base leading-relaxed text-white/60">
              <ShinyText>Create, route and sign memos</ShinyText>{" "}
              across every business unit — and always know whose turn it is.
            </p>
          </AnimatedContent>
        </div>

        <AnimatedContent delay={0.3} distance={20} className="relative z-10 -mb-6 flex justify-end">
          <img
            src={hero}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="max-h-[38vh] w-auto select-none object-contain drop-shadow-[0_30px_60px_rgba(0,0,0,0.45)] animate-rb-float"
          />
        </AnimatedContent>
      </aside>

      {/* ── Form ────────────────────────────────────────────────────────── */}
      <main className="relative flex items-center justify-center px-5 py-10 sm:px-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,var(--color-brand-50),transparent_70%)] lg:hidden"
        />
        <div className="relative w-full max-w-[400px]">
          {/* Brand - Mobile */}
          <AnimatedContent className="mb-8 flex items-center gap-2 lg:hidden">
            <img src={logo} alt="" className="h-6 w-6 object-contain" draggable={false} />
            <span className="text-sm font-semibold tracking-[0.15em] text-brand-700">HYLIFE E-APPROVAL</span>
          </AnimatedContent>

          <AnimatedContent delay={0.05}>
            <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Welcome back</h1>
            <p className="mt-1.5 text-sm text-gray-500">Sign in with your work email to continue.</p>
          </AnimatedContent>

          {emailToken && !emailLoginFailed ? (
            <AnimatedContent delay={0.1} className="mt-8 flex items-center gap-3 text-sm text-gray-600">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
              กำลังเข้าสู่ระบบ…
            </AnimatedContent>
          ) : (
            <motion.form
              animate={formControls}
              className="auth-form mt-8 flex w-full flex-col gap-4"
              onSubmit={handleSubmit}
            >
              <AnimatePresence initial={false}>
                {isArchivedLogout && (
                  <motion.div
                    key="archived"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl border border-orange-200 bg-orange-50 px-3.5 py-2.5 text-sm text-orange-700"
                  >
                    Your account has been deactivated. Please contact your administrator.
                  </motion.div>
                )}
                {emailLoginFailed && (
                  <motion.div
                    key="email-failed"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
                  >
                    Email link invalid or expired. Please log in with your password.
                  </motion.div>
                )}
                {errorVisible && (
                  <motion.div
                    key="error"
                    role="alert"
                    initial={{ opacity: 0, y: -6, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
                  >
                    {loginErrorMsg || "Invalid email or password. Please try again."}
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatedContent delay={0.12} className="flex flex-col gap-1.5">
                <label htmlFor="login-email" className="text-xs font-medium text-gray-600">
                  Email<span className="text-red-500">*</span>
                </label>
                <div className="relative flex items-center">
                  <input
                    id="login-email"
                    type="email"
                    placeholder="name@hylife.co.th"
                    className={inputClass}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onBlur={(e) => setEmail(normalizeEmail(e.target.value))}
                    required
                    autoComplete="username"
                    inputMode="email"
                  />
                  <FaEnvelope className={iconClass} />
                </div>
              </AnimatedContent>

              <AnimatedContent delay={0.18} className="flex flex-col gap-1.5">
                <label htmlFor="login-password" className="text-xs font-medium text-gray-600">
                  Password<span className="text-red-500">*</span>
                </label>
                <div className="relative flex items-center">
                  <input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    className={`${inputClass} pr-12`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                  />
                  <FaLock className={iconClass} />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-1.5 grid h-9 w-9 place-items-center rounded-lg text-gray-400 transition-colors duration-200 hover:bg-gray-100 hover:text-gray-600"
                  >
                    {showPassword ? <FaEyeSlash /> : <FaEye />}
                  </button>
                </div>
              </AnimatedContent>

              <AnimatedContent delay={0.24}>
                <motion.button
                  type="submit"
                  disabled={loading}
                  whileHover={reduce || loading ? undefined : { y: -1 }}
                  whileTap={reduce || loading ? undefined : { scale: 0.985 }}
                  className="group relative mt-2 inline-flex h-12 w-full items-center justify-center overflow-hidden rounded-xl bg-brand-700 font-semibold text-white shadow-[0_10px_30px_-10px_rgb(24_62_51_/_0.7)] transition-[background-color,box-shadow] duration-300 hover:bg-brand-600 hover:shadow-[0_14px_36px_-10px_rgb(24_62_51_/_0.8)] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {/* light sweep on hover */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-[300%]"
                  />
                  {loading ? (
                    <span className="relative flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      Please wait…
                    </span>
                  ) : (
                    <span className="relative">Log In</span>
                  )}
                </motion.button>
              </AnimatedContent>
            </motion.form>
          )}
        </div>
      </main>
    </div>
  );
}
