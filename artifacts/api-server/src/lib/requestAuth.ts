import type { Request } from "express";
import { verifyAccessToken, type AccessTokenPayload } from "./jwt";

export type RequestAuth = {
  userId: string;
  source: "jwt" | "header";
  claims: AccessTokenPayload | null;
};

function getBearerToken(req: Request): string {
  const authHeader = String(req.headers["authorization"] || "").trim();
  if (!authHeader.toLowerCase().startsWith("bearer ")) return "";
  return authHeader.slice(7).trim();
}

export function getRequestAuth(req: Request): RequestAuth | null {
  const bearerToken = getBearerToken(req);
  if (bearerToken) {
    const claims = verifyAccessToken(bearerToken);
    if (claims?.sub) {
      return {
        userId: claims.sub,
        source: "jwt",
        claims,
      };
    }
  }

  const headerUserId = String(req.headers["x-user-id"] || "").trim();
  if (!headerUserId) return null;

  return {
    userId: headerUserId,
    source: "header",
    claims: null,
  };
}

export function getJwtRequestAuth(req: Request): RequestAuth | null {
  const bearerToken = getBearerToken(req);
  if (!bearerToken) return null;

  const claims = verifyAccessToken(bearerToken);
  if (!claims?.sub) return null;

  return {
    userId: claims.sub,
    source: "jwt",
    claims,
  };
}
