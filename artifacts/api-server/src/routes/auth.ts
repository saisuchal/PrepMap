import { Router, type IRouter } from "express";
import {
  LoginBody,
  LoginResponse,
  ResetPasswordBody,
  CompleteFirstLoginSetupBody,
  ForgotPasswordBySecurityBody,
} from "../api-zod";
import { db, usersTable } from "../db";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";

const router: IRouter = Router();
const normalizeSecurityAnswer = (value: string) => value.trim().toLowerCase();

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

    const response = LoginResponse.parse({
      id: user.id,
      universityId: user.universityId,
      branch: user.branch,
      year: user.year,
      role: user.role,
      mustResetPassword: !!(user as any).mustResetPassword,
      securityQuestionSet: !!(user as any).securityQuestion,
      onboardingRequired:
        (user.role === "student" || user.role === "super_student") &&
        (!!(user as any).mustResetPassword || !(user as any).securityQuestion),
    });

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

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Security-password reset failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

