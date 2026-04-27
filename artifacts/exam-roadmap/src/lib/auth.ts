import type { LoginResponse } from "@/api-client";

const AUTH_KEY = "prepmap_user";

export type StoredUser = LoginResponse;

export function getStoredUser(): StoredUser | null {
  try {
    const stored = localStorage.getItem(AUTH_KEY);
    if (!stored) return null;
    const user = JSON.parse(stored);
    const accessToken = String(user?.accessToken || "").trim();
    const refreshToken = String(user?.refreshToken || "").trim();
    if (!accessToken && !refreshToken) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

export function setStoredUser(user: StoredUser) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(user));
  try {
    sessionStorage.removeItem("events_tracking_blocked_401");
  } catch {}
}

export function getStoredAccessToken(): string | null {
  const user = getStoredUser();
  const token = String(user?.accessToken || "").trim();
  return token || null;
}

export function getStoredRefreshToken(): string | null {
  const user = getStoredUser();
  const token = String(user?.refreshToken || "").trim();
  return token || null;
}

export function removeStoredUser() {
  localStorage.removeItem(AUTH_KEY);
  try {
    sessionStorage.removeItem("events_tracking_blocked_401");
  } catch {}
}

export function isAdmin(): boolean {
  const user = getStoredUser();
  return user?.role === "admin";
}

export function isStudent(): boolean {
  const user = getStoredUser();
  return user?.role === "student" || user?.role === "super_student";
}


