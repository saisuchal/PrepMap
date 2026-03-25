import type { LoginResponse } from "@workspace/api-client-react";

const AUTH_KEY = "exam_roadmap_user";

export function getStoredUser(): LoginResponse | null {
  try {
    const stored = localStorage.getItem(AUTH_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user: LoginResponse) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(user));
}

export function removeStoredUser() {
  localStorage.removeItem(AUTH_KEY);
}
