import { Router, type IRouter } from "express";
import {
  GetSubtopicContentParams,
  GetSubtopicContentResponse,
  UpdateSubtopicContentParams,
  UpdateSubtopicContentBody,
} from "../api-zod";
import { db, subtopicContentsTable, subtopicQuestionsTable, nodesTable, configsTable, usersTable } from "../db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middleware/adminAuth";

const router: IRouter = Router();

router.get("/subtopics/:id", async (req, res) => {
  try {
    const { id } = GetSubtopicContentParams.parse(req.params);
    const [node] = await db
      .select({
        id: nodesTable.id,
        configId: nodesTable.configId,
      })
      .from(nodesTable)
      .where(eq(nodesTable.id, id))
      .limit(1);

    if (!node) {
      res.status(404).json({ error: "Subtopic not found" });
      return;
    }

    const [config] = await db
      .select({
        id: configsTable.id,
        universityId: configsTable.universityId,
        year: configsTable.year,
        branch: configsTable.branch,
        status: configsTable.status,
      })
      .from(configsTable)
      .where(eq(configsTable.id, node.configId))
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

    const [content] = await db
      .select()
      .from(subtopicContentsTable)
      .where(eq(subtopicContentsTable.nodeId, id))
      .limit(1);

    if (!content) {
      res.status(404).json({ error: "Subtopic not found" });
      return;
    }

    const questions = await db
      .select()
      .from(subtopicQuestionsTable)
      .where(eq(subtopicQuestionsTable.nodeId, id));

    const response = GetSubtopicContentResponse.parse({
      id: content.id,
      nodeId: content.nodeId,
      explanation: content.explanation,
      questions: questions.map((q) => ({
        id: q.id,
        markType: q.markType === "2" ? "Foundational" : q.markType === "5" ? "Applied" : q.markType,
        question: q.question,
        answer: q.answer,
        isStarred: q.isStarred,
        starSource: q.starSource,
      })),
    });

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch subtopic content");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/subtopics/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = UpdateSubtopicContentParams.parse(req.params);
    const body = UpdateSubtopicContentBody.parse(req.body);

    const [content] = await db
      .select()
      .from(subtopicContentsTable)
      .where(eq(subtopicContentsTable.nodeId, id))
      .limit(1);

    if (!content) {
      res.status(404).json({ error: "Subtopic not found" });
      return;
    }

    await db
      .update(subtopicContentsTable)
      .set({ explanation: body.explanation })
      .where(eq(subtopicContentsTable.nodeId, id));

    await db
      .delete(subtopicQuestionsTable)
      .where(eq(subtopicQuestionsTable.nodeId, id));

    if (body.questions.length > 0) {
      await db.insert(subtopicQuestionsTable).values(
        body.questions.map((q) => ({
          nodeId: id,
          markType: q.markType === "2" ? "Foundational" : q.markType === "5" ? "Applied" : q.markType,
          question: q.question,
          answer: q.answer,
          isStarred: q.isStarred ?? false,
          starSource: q.starSource ?? (q.isStarred ? "manual" : "none"),
        }))
      );
    }

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to update subtopic content");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

