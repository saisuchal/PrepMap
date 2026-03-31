import { Router, type IRouter } from "express";
import { GetConfigsQueryParams, GetConfigsResponse } from "../api-zod";
import { db, configsTable, nodesTable, subtopicQuestionsTable, usersTable } from "../db";
import { eq, and, inArray, ne, type SQL } from "drizzle-orm";
import { requireAdmin } from "../middleware/adminAuth";

const router: IRouter = Router();

router.get("/configs", async (req, res) => {
  try {
    const { universityId, status } = GetConfigsQueryParams.parse(req.query);

    const userId = req.headers["x-user-id"] as string | undefined;
    let isAdmin = false;
    let isSuperStudent = false;
    let userUniversityId: string | null = null;
    let userYear: string | null = null;
    let userBranch: string | null = null;
    if (userId) {
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      isAdmin = user?.role === "admin";
      isSuperStudent = (user?.role || "").toLowerCase() === "super_student";
      userUniversityId = user?.universityId ?? null;
      userYear = user?.year ?? null;
      userBranch = user?.branch ?? null;
    }

    const conditions: SQL[] = [];
    if (!isAdmin && userUniversityId) {
      conditions.push(eq(configsTable.universityId, userUniversityId));
      if (!isSuperStudent) {
        if (userYear) conditions.push(eq(configsTable.year, userYear));
        if (userBranch) conditions.push(eq(configsTable.branch, userBranch));
      }
    } else if (universityId) {
      conditions.push(eq(configsTable.universityId, universityId));
    }
    if (isAdmin && status) {
      conditions.push(eq(configsTable.status, status));
    } else if (!isAdmin) {
      conditions.push(eq(configsTable.status, "live"));
    } else {
      conditions.push(ne(configsTable.status, "deleted"));
      conditions.push(ne(configsTable.status, "disabled"));
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

router.get("/configs/:id/question-bank", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ error: "Config id is required" });
      return;
    }

    const [config] = await db
      .select({
        id: configsTable.id,
        subject: configsTable.subject,
        universityId: configsTable.universityId,
        year: configsTable.year,
        branch: configsTable.branch,
        status: configsTable.status,
      })
      .from(configsTable)
      .where(eq(configsTable.id, id))
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
      // Unauthenticated users can only see live content.
      res.status(403).json({ error: "Access denied." });
      return;
    }

    const configNodes = await db
      .select({
        id: nodesTable.id,
        title: nodesTable.title,
        type: nodesTable.type,
        parentId: nodesTable.parentId,
      })
      .from(nodesTable)
      .where(eq(nodesTable.configId, id));

    const nodeById = new Map(configNodes.map((n) => [n.id, n]));

    const nodeIds = configNodes
      .filter((n) => n.type === "subtopic")
      .map((n) => n.id);

    const questions = nodeIds.length
      ? await db
          .select({
            id: subtopicQuestionsTable.id,
            nodeId: subtopicQuestionsTable.nodeId,
            markType: subtopicQuestionsTable.markType,
            question: subtopicQuestionsTable.question,
            answer: subtopicQuestionsTable.answer,
            isStarred: subtopicQuestionsTable.isStarred,
            starSource: subtopicQuestionsTable.starSource,
          })
          .from(subtopicQuestionsTable)
          .where(inArray(subtopicQuestionsTable.nodeId, nodeIds))
      : [];

    const filtered = questions
      .filter((q) => nodeById.has(q.nodeId))
      .map((q) => {
        const subtopic = nodeById.get(q.nodeId);
        const topic = subtopic?.parentId ? nodeById.get(subtopic.parentId) : undefined;
        const unit = topic?.parentId ? nodeById.get(topic.parentId) : undefined;
        return {
          id: q.id,
          markType: q.markType === "2" ? "Foundational" : q.markType === "5" ? "Applied" : q.markType,
          question: q.question,
          answer: q.answer,
          isStarred: q.isStarred ?? false,
          starSource: q.starSource ?? "none",
          subtopicId: q.nodeId,
          subtopicTitle: subtopic?.title ?? "",
          topicTitle: topic?.title ?? "",
          unitTitle: unit?.title ?? "",
        };
      })
      .sort((a, b) => {
        const starCmp = Number(b.isStarred) - Number(a.isStarred);
        if (starCmp !== 0) return starCmp;
        const markRank = (v: string) => (v === "Foundational" ? 0 : v === "Applied" ? 1 : 2);
        const markCmp = markRank(a.markType) - markRank(b.markType);
        if (markCmp !== 0) return markCmp;
        return a.id - b.id;
      });

    res.json({
      configId: id,
      subject: config.subject,
      total: filtered.length,
      questions: filtered,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch config question bank");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/configs/:configId/question-bank/questions/:questionId/star", requireAdmin, async (req, res) => {
  try {
    const configId = String(req.params.configId || "").trim();
    const questionId = Number(req.params.questionId);
    const isStarred = Boolean(req.body?.isStarred);

    if (!configId || !Number.isFinite(questionId)) {
      res.status(400).json({ error: "Invalid configId or questionId" });
      return;
    }

    const [question] = await db
      .select({
        id: subtopicQuestionsTable.id,
        nodeId: subtopicQuestionsTable.nodeId,
      })
      .from(subtopicQuestionsTable)
      .where(eq(subtopicQuestionsTable.id, questionId))
      .limit(1);

    if (!question) {
      res.status(404).json({ error: "Question not found" });
      return;
    }

    const [node] = await db
      .select({
        id: nodesTable.id,
        configId: nodesTable.configId,
      })
      .from(nodesTable)
      .where(eq(nodesTable.id, question.nodeId))
      .limit(1);

    if (!node || node.configId !== configId) {
      res.status(400).json({ error: "Question does not belong to this config" });
      return;
    }

    await db
      .update(subtopicQuestionsTable)
      .set({
        isStarred,
        starSource: isStarred ? "manual" : "none",
      })
      .where(eq(subtopicQuestionsTable.id, questionId));

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to update question star");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

