import { Router, type IRouter } from "express";
import { GetConfigsQueryParams, GetConfigsResponse } from "@workspace/api-zod";
import { db, configsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

router.get("/configs", async (req, res) => {
  try {
    const { universityId, status } = GetConfigsQueryParams.parse(req.query);

    const conditions = [eq(configsTable.universityId, universityId)];
    if (status) {
      conditions.push(eq(configsTable.status, status));
    } else {
      conditions.push(eq(configsTable.status, "live"));
    }

    const configs = await db
      .select()
      .from(configsTable)
      .where(and(...conditions));

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
      }))
    );

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch configs");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
