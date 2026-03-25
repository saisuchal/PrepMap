import { Router, type IRouter } from "express";
import { GetAdminStatsResponse } from "@workspace/api-zod";
import { db, eventsTable, nodesTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { requireAdmin } from "../middleware/adminAuth";

const router: IRouter = Router();

router.get("/admin/stats", requireAdmin, async (req, res) => {
  try {
    const stats = await db
      .select({
        subtopicId: nodesTable.id,
        subtopicTitle: nodesTable.title,
        eventCount: count(eventsTable.id),
      })
      .from(nodesTable)
      .leftJoin(eventsTable, eq(nodesTable.id, eventsTable.subtopicId))
      .where(eq(nodesTable.type, "subtopic"))
      .groupBy(nodesTable.id, nodesTable.title);

    const response = GetAdminStatsResponse.parse(
      stats.map((s) => ({
        subtopicId: s.subtopicId,
        subtopicTitle: s.subtopicTitle,
        eventCount: Number(s.eventCount),
      }))
    );

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch admin stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
