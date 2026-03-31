import { Router, type IRouter } from "express";
import { TrackEventBody } from "../api-zod";
import { db, eventsTable, usersTable } from "../db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.post("/events", async (req, res) => {
  try {
    const authUserId = String(req.headers["x-user-id"] || "").trim();
    if (!authUserId) {
      res.status(401).json({ error: "Authentication required. Provide x-user-id header." });
      return;
    }

    const [authUser] = await db
      .select({
        id: usersTable.id,
        universityId: usersTable.universityId,
        year: usersTable.year,
        branch: usersTable.branch,
        role: usersTable.role,
      })
      .from(usersTable)
      .where(eq(usersTable.id, authUserId))
      .limit(1);

    if (!authUser) {
      res.status(401).json({ error: "Invalid user." });
      return;
    }

    // Admins can preview student flow, but must not pollute progress analytics.
    if (authUser.role === "admin") {
      res.status(200).json({ success: true, skipped: true });
      return;
    }

    const body = TrackEventBody.parse(req.body);

    await db.insert(eventsTable).values({
      userId: authUser.id,
      universityId: authUser.universityId,
      year: authUser.year,
      branch: authUser.branch,
      exam: body.exam,
      configId: body.configId,
      topicId: body.topicId,
      subtopicId: body.subtopicId,
    });

    res.status(201).json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to track event");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

