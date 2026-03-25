import { Router, type IRouter } from "express";
import { LoginBody, LoginResponse } from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const HARDCODED_PASSWORD = "1234567890";

router.post("/auth/login", async (req, res) => {
  try {
    const body = LoginBody.parse(req.body);

    if (body.password !== HARDCODED_PASSWORD) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, body.collegeId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const response = LoginResponse.parse({
      id: user.id,
      universityId: user.universityId,
      branch: user.branch,
      year: user.year,
    });

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Login failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
