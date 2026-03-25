import type { LoginResponse } from "@workspace/api-client-react";

const AUTH_KEY = "gpmax_user";

export type StoredUser = LoginResponse;

export function getStoredUser(): StoredUser | null {
  try {
    const stored = localStorage.getItem(AUTH_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user: StoredUser) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(user));
}

export function removeStoredUser() {
  localStorage.removeItem(AUTH_KEY);
}

export function isAdmin(): boolean {
  const user = getStoredUser();
  return user?.role === "admin";
}

export function isStudent(): boolean {
  const user = getStoredUser();
  return user?.role === "student";
}
