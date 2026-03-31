import type { LoginResponse } from "@/api-client";

const AUTH_KEY = "prepmap_user";
const LEGACY_AUTH_KEY = "gpmax_user";

export type StoredUser = LoginResponse;

export function getStoredUser(): StoredUser | null {
  try {
    const stored = localStorage.getItem(AUTH_KEY) ?? localStorage.getItem(LEGACY_AUTH_KEY);
    if (!stored) return null;
    const user = JSON.parse(stored);
    // Migrate legacy key to new key lazily on first read.
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
    if (localStorage.getItem(LEGACY_AUTH_KEY)) {
      localStorage.removeItem(LEGACY_AUTH_KEY);
    }
    return user;
  } catch {
    return null;
  }
}

export function setStoredUser(user: StoredUser) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(user));
}

export function removeStoredUser() {
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(LEGACY_AUTH_KEY);
}

export function isAdmin(): boolean {
  const user = getStoredUser();
  return user?.role === "admin";
}

export function isStudent(): boolean {
  const user = getStoredUser();
  return user?.role === "student" || user?.role === "super_student";
}


