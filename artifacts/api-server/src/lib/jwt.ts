import crypto from "node:crypto";

export type AccessTokenPayload = {
  sub: string;
  role: string;
  universityId: string;
  branch: string;
  year: string;
  type: "access";
  iat: number;
  exp: number;
};

const ACCESS_TOKEN_TTL_SECONDS = Number(process.env["JWT_ACCESS_TTL_SECONDS"] || "900");

function getJwtSecret(): string {
  const secret = String(process.env["JWT_SECRET"] || "").trim();
  if (!secret) {
    throw new Error("JWT_SECRET must be set");
  }
  return secret;
}

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
}

function signHmacSha256(value: string, secret: string): string {
  return toBase64Url(crypto.createHmac("sha256", secret).update(value).digest());
}

export function issueAccessToken(claims: {
  userId: string;
  role: string;
  universityId: string;
  branch: string;
  year: string;
}): { token: string; payload: AccessTokenPayload } {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(ACCESS_TOKEN_TTL_SECONDS) && ACCESS_TOKEN_TTL_SECONDS > 0
    ? ACCESS_TOKEN_TTL_SECONDS
    : 900;

  const payload: AccessTokenPayload = {
    sub: claims.userId,
    role: claims.role,
    universityId: claims.universityId,
    branch: claims.branch,
    year: claims.year,
    type: "access",
    iat: now,
    exp: now + ttl,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = signHmacSha256(unsignedToken, getJwtSecret());

  return {
    token: `${unsignedToken}.${signature}`,
    payload,
  };
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  const raw = String(token || "").trim();
  if (!raw) return null;

  const parts = raw.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) return null;

  const expected = signHmacSha256(`${encodedHeader}.${encodedPayload}`, getJwtSecret());
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);

  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
    return null;
  }

  try {
    const header = JSON.parse(fromBase64Url(encodedHeader).toString("utf8")) as { alg?: string; typ?: string };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;

    const payload = JSON.parse(fromBase64Url(encodedPayload).toString("utf8")) as Partial<AccessTokenPayload>;
    const now = Math.floor(Date.now() / 1000);
    if (payload.type !== "access") return null;
    if (!payload.sub || !payload.role || !payload.universityId || !payload.branch || !payload.year) return null;
    if (!payload.exp || !payload.iat) return null;
    if (payload.exp <= now) return null;

    return payload as AccessTokenPayload;
  } catch {
    return null;
  }
}
