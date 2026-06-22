// src/lib/api.ts
import axios from "axios";
import type { AxiosError, AxiosResponse } from "axios";
import { broadcastMemoDashboardRefresh } from "./memoDashboardEvents";

export const BASE_URL =
  import.meta.env.VITE_BACKEND_API_URL ||
  `${window.location.origin.replace(/:\d+$/, ":3001")}`;

export const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
});

export function isAuthError(err: unknown): boolean {
  const axErr = err as AxiosError | undefined;
  return Boolean(axErr?.response?.status === 401);
}

function getApiPath(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url, BASE_URL).pathname;
  } catch {
    return url;
  }
}

function shouldRefreshMemoDashboard(res: AxiosResponse): boolean {
  const method = (res.config.method ?? "get").toLowerCase();
  if (!["post", "put", "patch", "delete"].includes(method)) return false;

  const path = getApiPath(res.config.url);
  if (!path.startsWith("/api/memos")) return false;

  return (
    !path.startsWith("/api/memos/search") &&
    !path.endsWith("/users-delegation-info")
  );
}

function notifyMemoDashboard(res: AxiosResponse): AxiosResponse {
  if (shouldRefreshMemoDashboard(res)) {
    broadcastMemoDashboardRefresh({
      method: res.config.method?.toUpperCase(),
      url: getApiPath(res.config.url),
      reason: "memo-mutated",
    });
  }
  return res;
}

axios.interceptors.response.use(
  (res) => notifyMemoDashboard(res),
  (err) => Promise.reject(err)
);

// (ไม่ redirect อัตโนมัติ ให้หน้า caller ตัดสินใจ)
api.interceptors.response.use(
  (res) => notifyMemoDashboard(res),
  async (err: AxiosError) => {
    if (err.response) {
      const { status, data } = err.response;
      if (status === 403 && (data as any)?.error === "ACCOUNT_ARCHIVED") {
        // Account was archived while user was logged in — force logout
        try {
          await axios.post(`${BASE_URL}/api/auth/logout`, {}, { withCredentials: true });
        } catch {
          // ignore logout errors
        }
        window.location.href = "/login?reason=archived";
        return;
      }
      if (status === 401) {
        console.warn("⚠️ Unauthorized (401) – maybe session expired.");
      } else {
        console.error(`API error ${status}:`, data ?? err.message);
      }
    } else if (err.request) {
      console.error("🌐 Network/CORS error:", err.message);
    } else {
      console.error("❌ Unexpected axios error:", err);
    }
    return Promise.reject(err);
  }
);
