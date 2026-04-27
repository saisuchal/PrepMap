import { Router, type IRouter } from "express";
import {
  LoginBody,
  LoginResponse,
  ResetPasswordBody,
  CompleteFirstLoginSetupBody,
  ForgotPasswordBySecurityBody,
} from "../api-zod";
import { authSessionsTable, db, usersTable } from "../db";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { issueAccessToken } from "../lib/jwt";
import crypto from "node:crypto";
import { z } from "zod/v4";
import { getJwtRequestAuth } from "../lib/requestAuth";

const router: IRouter = Router();
const normalizeSecurityAnswer = (value: string) => value.trim().toLowerCase();
const REFRESH_INACTIVITY_TTL_SECONDS = Number(process.env["JWT_INACTIVITY_TTL_SECONDS"] || "604800");
const REFRESH_MAX_LIFETIME_SECONDS = Number(process.env["JWT_REFRESH_MAX_LIFETIME_SECONDS"] || "2592000");
const RefreshBody = z.object({
  refreshToken: z.string().trim().min(20),
});
const LogoutBody = z.object({
  refreshToken: z.string().trim().optional().nullable(),
});

function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

function getRefreshInactivityMs(): number {
  const ttl = Number.isFinite(REFRESH_INACTIVITY_TTL_SECONDS) && REFRESH_INACTIVITY_TTL_SECONDS > 0
    ? REFRESH_INACTIVITY_TTL_SECONDS
    : 604800;
  return ttl * 1000;
}

function getRefreshLifetimeMs(): number {
  const ttl = Number.isFinite(REFRESH_MAX_LIFETIME_SECONDS) && REFRESH_MAX_LIFETIME_SECONDS > 0
    ? REFRESH_MAX_LIFETIME_SECONDS
    : 2592000;
  return ttl * 1000;
}

async function issueSessionTokens(user: {
  id: string;
  role: string;
  universityId: string;
  branch: string;
  year: string;
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + getRefreshLifetimeMs());
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);

  await db.insert(authSessionsTable).values({
    id: crypto.randomUUID(),
    userId: user.id,
    refreshTokenHash,
    lastActivityAt: now,
    expiresAt,
    updatedAt: now,
  });

  const { token } = issueAccessToken({
    userId: user.id,
    role: user.role,
    universityId: user.universityId,
    branch: user.branch,
    year: user.year,
  });

  return { accessToken: token, refreshToken };
}

function buildLoginLikeResponse(user: any, tokens: { accessToken: string; refreshToken: string }) {
  return LoginResponse.parse({
    id: user.id,
    universityId: user.universityId,
    branch: user.branch,
    year: user.year,
    role: user.role,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    mustResetPassword: !!user.mustResetPassword,
    securityQuestionSet: !!user.securityQuestion,
    onboardingRequired:
      (user.role === "student" || user.role === "super_student") &&
      (!!user.mustResetPassword || !user.securityQuestion),
  });
}

router.post("/auth/login", async (req, res) => {
  try {
    const body = LoginBody.parse(req.body);

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, body.collegeId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const passwordValid = await bcrypt.compare(body.password, user.password);
    if (!passwordValid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    await db
      .update(usersTable)
      .set({ lastSuccessfulLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));

    const tokens = await issueSessionTokens(user);
    const response = buildLoginLikeResponse(user, tokens);

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Login failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/auth/reset-password", async (req, res) => {
  try {
    const body = ResetPasswordBody.parse(req.body);

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, body.collegeId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const passwordValid = await bcrypt.compare(body.currentPassword, user.password);
    if (!passwordValid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const hashedNew = await bcrypt.hash(body.newPassword, 10);
    await db
      .update(usersTable)
      .set({
        password: hashedNew,
        mustResetPassword: false,
        lastPasswordResetAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, body.collegeId));

    await db.delete(authSessionsTable).where(eq(authSessionsTable.userId, body.collegeId));

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Password reset failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/auth/complete-first-login-setup", async (req, res) => {
  try {
    const body = CompleteFirstLoginSetupBody.parse(req.body);

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, body.collegeId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const passwordValid = await bcrypt.compare(body.currentPassword, user.password);
    if (!passwordValid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const hashedNew = await bcrypt.hash(body.newPassword, 10);
    const hashedAnswer = await bcrypt.hash(normalizeSecurityAnswer(body.securityAnswer), 10);
    await db
      .update(usersTable)
      .set({
        password: hashedNew,
        securityQuestion: body.securityQuestion.trim(),
        securityAnswerHash: hashedAnswer,
        mustResetPassword: false,
        lastPasswordResetAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, body.collegeId));

    await db.delete(authSessionsTable).where(eq(authSessionsTable.userId, body.collegeId));

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "First login setup failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/auth/security-question", async (req, res) => {
  try {
    const collegeId = String(req.query.collegeId || "").trim();
    if (!collegeId) {
      res.status(400).json({ error: "collegeId is required" });
      return;
    }

    const [user] = await db
      .select({
        id: usersTable.id,
        securityQuestion: usersTable.securityQuestion,
      })
      .from(usersTable)
      .where(eq(usersTable.id, collegeId))
      .limit(1);

    if (!user || !user.securityQuestion) {
      res.status(404).json({ error: "Security question not set for this account" });
      return;
    }

    res.json({ collegeId, securityQuestion: user.securityQuestion });
  } catch (error) {
    req.log.error({ err: error }, "Get security question failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/auth/reset-password-with-security", async (req, res) => {
  try {
    const body = ForgotPasswordBySecurityBody.parse(req.body);

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, body.collegeId))
      .limit(1);

    if (!user || !(user as any).securityAnswerHash) {
      res.status(401).json({ error: "Account does not have security setup" });
      return;
    }

    const answerValid = await bcrypt.compare(
      normalizeSecurityAnswer(body.securityAnswer),
      (user as any).securityAnswerHash,
    );
    if (!answerValid) {
      res.status(401).json({ error: "Security answer is incorrect" });
      return;
    }

    const hashedNew = await bcrypt.hash(body.newPassword, 10);
    await db
      .update(usersTable)
      .set({
        password: hashedNew,
        mustResetPassword: false,
        lastPasswordResetAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, body.collegeId));

    await db.delete(authSessionsTable).where(eq(authSessionsTable.userId, body.collegeId));

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Security-password reset failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/auth/refresh", async (req, res) => {
  try {
    const body = RefreshBody.parse(req.body);
    const tokenHash = hashRefreshToken(body.refreshToken);
    const [session] = await db
      .select()
      .from(authSessionsTable)
      .where(eq(authSessionsTable.refreshTokenHash, tokenHash))
      .limit(1);

    if (!session) {
      res.status(401).json({ error: "Invalid session." });
      return;
    }

    const now = new Date();
    const inactivityMs = now.getTime() - new Date(session.lastActivityAt).getTime();
    if (new Date(session.expiresAt).getTime() <= now.getTime() || inactivityMs > getRefreshInactivityMs()) {
      await db.delete(authSessionsTable).where(eq(authSessionsTable.id, session.id));
      res.status(401).json({ error: "Session expired. Please login again." });
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, session.userId))
      .limit(1);
    if (!user) {
      await db.delete(authSessionsTable).where(eq(authSessionsTable.id, session.id));
      res.status(401).json({ error: "Invalid session user." });
      return;
    }

    const nextRefreshToken = generateRefreshToken();
    const nextRefreshTokenHash = hashRefreshToken(nextRefreshToken);
    await db
      .update(authSessionsTable)
      .set({
        refreshTokenHash: nextRefreshTokenHash,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(authSessionsTable.id, session.id));

    const { token: accessToken } = issueAccessToken({
      userId: user.id,
      role: user.role,
      universityId: user.universityId,
      branch: user.branch,
      year: user.year,
    });

    const response = buildLoginLikeResponse(user, { accessToken, refreshToken: nextRefreshToken });
    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Token refresh failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/auth/logout", async (req, res) => {
  try {
    const body = LogoutBody.safeParse(req.body);
    const refreshToken = body.success ? String(body.data.refreshToken || "").trim() : "";
    const auth = getJwtRequestAuth(req);

    if (refreshToken) {
      const refreshTokenHash = hashRefreshToken(refreshToken);
      await db.delete(authSessionsTable).where(eq(authSessionsTable.refreshTokenHash, refreshTokenHash));
    } else if (auth?.userId) {
      await db.delete(authSessionsTable).where(eq(authSessionsTable.userId, auth.userId));
    }

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Logout failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

