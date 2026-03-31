import { Router, type IRouter } from "express";
import { GetNodesQueryParams, GetNodesResponse } from "../api-zod";
import { db, nodesTable, configsTable, usersTable } from "../db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/nodes", async (req, res) => {
  try {
    const { configId } = GetNodesQueryParams.parse(req.query);
    const [config] = await db
      .select({
        id: configsTable.id,
        universityId: configsTable.universityId,
        year: configsTable.year,
        branch: configsTable.branch,
        status: configsTable.status,
      })
      .from(configsTable)
      .where(eq(configsTable.id, configId))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    const userId = String(req.headers["x-user-id"] || "").trim();
    if (userId) {
      const [user] = await db
        .select({
          id: usersTable.id,
          role: usersTable.role,
          universityId: usersTable.universityId,
          year: usersTable.year,
          branch: usersTable.branch,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);

      if (!user) {
        res.status(401).json({ error: "Invalid user." });
        return;
      }

      if (user.role !== "admin") {
        if (config.status !== "live") {
          res.status(403).json({ error: "Access denied." });
          return;
        }
        if (user.universityId !== config.universityId) {
          res.status(403).json({ error: "Access denied." });
          return;
        }
        const isSuperStudent = (user.role || "").toLowerCase() === "super_student";
        if (!isSuperStudent && (user.year !== config.year || user.branch !== config.branch)) {
          res.status(403).json({ error: "Access denied." });
          return;
        }
      }
    } else if (config.status !== "live") {
      res.status(403).json({ error: "Access denied." });
      return;
    }

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

