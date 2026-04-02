import { Router, type IRouter } from "express";
import { GetConfigsQueryParams, GetConfigsResponse } from "../api-zod";
import { db, configsTable, nodesTable, subtopicQuestionsTable, usersTable } from "../db";
import { eq, and, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { requireAdmin } from "../middleware/adminAuth";

const router: IRouter = Router();

function normalizeToken(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function parseYearNumber(value: string | null | undefined): number | null {
  const token = normalizeToken(value);
  const yearMatch = token.match(/year[^0-9]*([1-4])/);
  if (yearMatch) return Number(yearMatch[1]);
  const plainMatch = token.match(/^([1-4])$/);
  if (plainMatch) return Number(plainMatch[1]);
  return null;
}

function parseSemesterNumber(value: string | null | undefined): number | null {
  const token = normalizeToken(value);
  const semMatch = token.match(/sem(?:ester)?[^0-9]*([1-8])/);
  if (semMatch) return Number(semMatch[1]);
  const sMatch = token.match(/^s([1-8])$/);
  if (sMatch) return Number(sMatch[1]);
  const plainMatch = token.match(/^([1-8])$/);
  if (plainMatch) return Number(plainMatch[1]);
  return null;
}

function getAllowedConfigYearTokensForStudentYear(userYear: string | null | undefined): string[] {
  const normalized = normalizeToken(userYear);
  if (!normalized) return [];

  const tokens = new Set<string>();
  tokens.add(normalized);

  const yearNum = parseYearNumber(userYear);
  if (yearNum) {
    const sem1 = yearNum * 2 - 1;
    const sem2 = yearNum * 2;
    tokens.add(String(yearNum));
    tokens.add(`year${yearNum}`);
    tokens.add(`sem${sem1}`);
    tokens.add(`sem${sem2}`);
    tokens.add(`semester${sem1}`);
    tokens.add(`semester${sem2}`);
  }

  const semNum = parseSemesterNumber(userYear);
  if (semNum) {
    const mappedYear = Math.ceil(semNum / 2);
    tokens.add(`sem${semNum}`);
    tokens.add(`semester${semNum}`);
    tokens.add(String(mappedYear));
    tokens.add(`year${mappedYear}`);
  }

  return Array.from(tokens);
}

function doesStudentYearMatchConfigYear(
  userYear: string | null | undefined,
  configYear: string | null | undefined,
): boolean {
  const configToken = normalizeToken(configYear);
  if (!configToken) return false;
  const allowed = getAllowedConfigYearTokensForStudentYear(userYear);
  if (allowed.length === 0) return false;
  return allowed.includes(configToken);
}

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
        const allowedYearTokens = getAllowedConfigYearTokensForStudentYear(userYear);
        if (allowedYearTokens.length > 0) {
          const normalizedConfigYear = sql<string>`regexp_replace(lower(${configsTable.year}), '\\s+', '', 'g')`;
          conditions.push(
            or(
              ...allowedYearTokens.map((token) => sql`${normalizedConfigYear} = ${token}`),
            ) as SQL,
          );
        }
        const normalizedUserBranch = normalizeToken(userBranch);
        if (normalizedUserBranch) {
          const normalizedConfigBranch = sql<string>`regexp_replace(lower(${configsTable.branch}), '\\s+', '', 'g')`;
          conditions.push(sql`${normalizedConfigBranch} = ${normalizedUserBranch}`);
        }
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
        const branchMismatch = normalizeToken(user.branch) !== normalizeToken(config.branch);
        if (
          !isSuperStudent &&
          (!doesStudentYearMatchConfigYear(user.year, config.year) || branchMismatch)
        ) {
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

