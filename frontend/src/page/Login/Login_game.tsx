// src/Login.tsx
import React, { useState } from "react";
import { UserIcon, LockClosedIcon } from "@heroicons/react/20/solid";


import "./login.css";
import FlappyBirdGame from "./FlappyBirdGame";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState(0);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (score < 5) return;  // ไม่ให้ล็อกอินถ้ายังไม่ถึง 5 แต้ม
    try {
      const res = await fetch("http://localhost:3001/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: username, password }),
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      window.location.href = "/";
    } catch (err: any) {
      setError(err.message || "Login failed");
    }
  };

  return (
    <div className="relative min-h-screen bg-gradient-to-br from-[#f2f1e9] to-[#e3e2d9] flex flex-col items-center justify-center overflow-hidden">
      
      {/* ① Animated Waves (อยู่ข้างนอกการ์ด) */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Wave Layer 2 */}
        <svg
          className="absolute -top-10 left-0 w-[200%] h-[25vh] wave-animation"
          viewBox="0 0 1200 170"
          preserveAspectRatio="none"
          style={{ animationDelay: "1s" }}
        >
          <path
            d="M0 140 
               C 100 160 200 120 300 140
               C 400 160 500 120 600 140
               C 700 160 800 120 900 140
               C 1000 160 1100 120 1200 140
               L 1200 0 L 0 0 Z"
            fill="#183E33"
          />
        </svg>
        {/* Wave Layer 3 */}
        <svg
          className="absolute bottom-0 left-0 w-[200%] h-[30vh] wave-animation-reverse"
          viewBox="0 0 1200 100"
          preserveAspectRatio="none"
        >
          <path
            d="M0 50 
               C 100 30 200 70 300 50
               C 400 30 500 70 600 50
               C 700 30 800 70 900 50
               C 1000 30 1100 70 1200 50
               L 1200 165 L 0 165 Z"
            fill="#183E33"
          />
        </svg>
      </div>

      {/* ② เกม FlappyBird (เล่นก่อนล็อกอิน) */}
      {score < 5 && (
        <FlappyBirdGame
          score={score}
          onScoreUp={() => setScore((s) => Math.min(s + 1, 5))}
        />
      )}

      {/* ③ การ์ดล็อกอิน (แสดงเมื่อได้ 5 แต้มขึ้นไป) */}
      {score >= 5 && (
        <div className="relative z-10 w-full max-w-md px-4 transform transition-all duration-300 hover:scale-[1.02]">
          <div className="bg-[#FEFDF7] rounded-[40px] shadow-2xl p-8 backdrop-blur-sm bg-opacity-90 border border-white border-opacity-20">
            
            {/* Logo section */}
            <div className="flex flex-col items-center mb-6 space-y-4">
              <img
                src="/img/HYMEMO_G.png"
                alt="Logo"
                className="h-20 w-20"
              />
            </div>

            {/* Form section */}
            <div className="bg-white rounded-2xl shadow-lg p-6 backdrop-blur-sm bg-opacity-90 border border-white border-opacity-20">
              <form onSubmit={handleLogin} className="space-y-6">
                
                {/* Username */}
                <div className="relative group">
                  <div className="absolute inset-0 from-green-100 to-transparent opacity-0 group-focus-within:opacity-100 rounded-lg transition-opacity duration-300 pointer-events-none" />
                  <UserIcon className="absolute left-3 top-3 h-5 w-5 text-green-900 group-focus-within:text-green-700 transition-colors duration-300" />
                  <input
                    type="text"
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    className="w-full pl-10 pr-4 py-3 bg-transparent rounded-lg placeholder-green-800 text-green-800 transition-all duration-300"
                  />
                </div>

                {/* Password */}
                <div className="relative group">
                  <div className="absolute inset-0 from-green-100 to-transparent opacity-0 group-focus-within:opacity-100 rounded-lg transition-opacity duration-300 pointer-events-none" />
                  <LockClosedIcon className="absolute left-3 top-3 h-5 w-5 text-green-900 group-focus-within:text-green-700 transition-colors duration-300" />
                  <input
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full pl-10 pr-4 py-3 bg-transparent rounded-lg placeholder-green-800 text-green-800 focus:border-green-600 focus:ring-2 focus:ring-green-200 focus:outline-none transition-all duration-300"
                  />
                </div>

                {/* Submit button */}
                <button
                  type="submit"
                  className="w-full bg-[#183e33] text-white py-4 rounded-xl font-semibold shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all duration-300 active:scale-95"
                >
                  Log In
                </button>
              </form>

              {/* Forgot password */}
              <div className="text-center mt-6">
                <a
                  href="#"
                  className="text-green-900 text-sm font-medium hover:text-green-700 transition-colors duration-300 hover:underline underline-offset-4"
                >
                  Forgot password?
                </a>
              </div>

              {/* Error message */}
              {error && (
                <div className="mt-4 animate-slide-down">
                  <p className="text-red-500 text-center font-medium px-4 py-2 bg-red-50 rounded-lg border border-red-100">
                    {error}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
