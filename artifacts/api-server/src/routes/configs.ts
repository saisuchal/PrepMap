import { Router, type IRouter } from "express";
import { GetConfigsQueryParams, GetConfigsResponse } from "@workspace/api-zod";
import { db, configsTable } from "@workspace/db";
import { eq, and, type SQL } from "drizzle-orm";
import { requireAdmin } from "../middleware/adminAuth";

const router: IRouter = Router();

router.get("/configs", async (req, res) => {
  try {
    const { universityId, status } = GetConfigsQueryParams.parse(req.query);

    const userId = req.headers["x-user-id"] as string | undefined;
    let isAdmin = false;
    if (userId) {
      const { usersTable } = await import("@workspace/db");
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      isAdmin = user?.role === "admin";
    }

    const conditions: SQL[] = [];
    if (universityId) {
      conditions.push(eq(configsTable.universityId, universityId));
    }
    if (status) {
      conditions.push(eq(configsTable.status, status));
    } else if (!isAdmin) {
      conditions.push(eq(configsTable.status, "live"));
    }

    const configs = await db
      .select()
      .from(configsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const response = GetConfigsResponse.parse(
      configs.map((c) => ({
        id: c.id,
        universityId: c.universityId,
        year: c.year,
        branch: c.branch,
        subject: c.subject,
        exam: c.exam,
        status: c.status,
        createdBy: c.createdBy,
        createdAt: c.createdAt?.toISOString(),
        syllabusFileUrl: c.syllabusFileUrl ?? null,
        paperFileUrls: c.paperFileUrls ?? null,
      }))
    );

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch configs");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
