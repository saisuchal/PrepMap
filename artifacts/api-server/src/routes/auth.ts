import { Router, type IRouter } from "express";
import { LoginBody, LoginResponse, ResetPasswordBody } from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";

const router: IRouter = Router();

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

    const response = LoginResponse.parse({
      id: user.id,
      universityId: user.universityId,
      branch: user.branch,
      year: user.year,
      role: user.role,
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
      .set({ password: hashedNew })
      .where(eq(usersTable.id, body.collegeId));

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Password reset failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
