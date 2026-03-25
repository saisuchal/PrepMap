import { Router, type IRouter } from "express";
import { GetNodesQueryParams, GetNodesResponse } from "@workspace/api-zod";
import { db, nodesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/nodes", async (req, res) => {
  try {
    const { configId } = GetNodesQueryParams.parse(req.query);

    const nodes = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.configId, configId));

    const response = GetNodesResponse.parse(
      nodes.map((n) => ({
        id: n.id,
        configId: n.configId,
        title: n.title,
        type: n.type,
        parentId: n.parentId,
        explanation: n.explanation,
        sortOrder: n.sortOrder,
      }))
    );

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch nodes");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
