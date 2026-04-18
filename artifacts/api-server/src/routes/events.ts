import { Router, type IRouter } from "express";
import { db, eventsTable, usersTable } from "../db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";

const router: IRouter = Router();
const TOPIC_INTERACTION_PREFIX = "__topic__:";
const QUESTION_BANK_EVENT_PREFIX = "__qb__:";

const TrackEventBody = z
  .object({
    userId: z.string().trim().min(1),
    universityId: z.string().trim().min(1),
    year: z.string().trim().min(1),
    branch: z.string().trim().min(1),
    exam: z.string().trim().min(1),
    configId: z.string().trim().min(1),
    topicId: z.string().trim().optional().nullable(),
    subtopicId: z.string().trim().optional().nullable(),
    questionId: z.string().trim().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    const questionId = String(value.questionId || "").trim();
    const topicId = String(value.topicId || "").trim();
    const subtopicId = String(value.subtopicId || "").trim();

    if (questionId) {
      return;
    }

    if (!topicId || !subtopicId) {
      ctx.addIssue({
        code: "custom",
        message: "topicId and subtopicId are required when questionId is not provided.",
      });
    }
  });

router.get("/configs/:configId/latest-interaction-state", async (req, res) => {
  try {
    const authUserId = String(req.headers["x-user-id"] || "").trim();
    if (!authUserId) {
      res.status(401).json({ error: "Authentication required. Provide x-user-id header." });
      return;
    }

    const configId = String(req.params.configId || "").trim();
    if (!configId) {
      res.status(400).json({ error: "configId is required." });
      return;
    }

    const latestEvents = await db
      .select({
        topicId: eventsTable.topicId,
        subtopicId: eventsTable.subtopicId,
        questionId: eventsTable.questionId,
        timestamp: eventsTable.timestamp,
      })
      .from(eventsTable)
      .where(and(eq(eventsTable.userId, authUserId), eq(eventsTable.configId, configId)))
      .orderBy(desc(eventsTable.timestamp))
      .limit(25);

    const row = latestEvents[0];
    const latest = latestEvents.find((e) => (
      !!String(e.questionId || "").trim() || !!String(e.subtopicId || "").trim()
    )) || null;
    const rawSubtopicId = String(latest?.subtopicId || "").trim();
    const rawQuestionId = String(latest?.questionId || "").trim();
    const isTopicInteraction = rawSubtopicId.startsWith(TOPIC_INTERACTION_PREFIX);
    const derivedTopicFromPrefix = isTopicInteraction
      ? rawSubtopicId.slice(TOPIC_INTERACTION_PREFIX.length).trim()
      : "";
    const mapNodeId = isTopicInteraction
      ? (derivedTopicFromPrefix || String(latest?.topicId || "").trim() || null)
      : null;
    const qbSubtopicId = isTopicInteraction ? null : (rawSubtopicId || null);
    const qbQuestionIdFromTopic = String(latest?.topicId || "").trim().startsWith(QUESTION_BANK_EVENT_PREFIX)
      ? Number(String(latest?.topicId || "").trim().slice(QUESTION_BANK_EVENT_PREFIX.length))
      : null;
    const qbQuestionId = rawQuestionId ? Number(rawQuestionId) : qbQuestionIdFromTopic;

    res.status(200).json({
      configId,
      userId: authUserId,
      mapNodeId,
      qbSubtopicId,
      qbQuestionId: Number.isFinite(qbQuestionId) ? qbQuestionId : null,
      eventAt: latest?.timestamp ? new Date(latest.timestamp).toISOString() : null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch latest interaction state");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/configs/:configId/completion-state", async (req, res) => {
  try {
    const authUserId = String(req.headers["x-user-id"] || "").trim();
    if (!authUserId) {
      res.status(401).json({ error: "Authentication required. Provide x-user-id header." });
      return;
    }

    const configId = String(req.params.configId || "").trim();
    if (!configId) {
      res.status(400).json({ error: "configId is required." });
      return;
    }

    const rows = await db
      .select({
        subtopicId: eventsTable.subtopicId,
        topicId: eventsTable.topicId,
      })
      .from(eventsTable)
      .where(and(eq(eventsTable.userId, authUserId), eq(eventsTable.configId, configId)));

    const doneSubtopicIds = Array.from(
      new Set(
        rows
          .map((r) => ({
            subtopicId: String(r.subtopicId || "").trim(),
            topicId: String(r.topicId || "").trim(),
          }))
          .filter((r) => {
            const id = r.subtopicId;
            const topicId = r.topicId;
            if (!id) return false;
            if (id.startsWith(TOPIC_INTERACTION_PREFIX)) return false;
            if (topicId.startsWith(QUESTION_BANK_EVENT_PREFIX)) return false;
            return true;
          })
          .map((r) => r.subtopicId),
      ),
    );

    res.status(200).json({
      configId,
      userId: authUserId,
      doneSubtopicIds,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch completion state");
    res.status(500).json({ error: "Internal server error" });
  }
});

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
    const topicId = String(body.topicId || "").trim();
    const subtopicId = String(body.subtopicId || "").trim();
    const questionId = String(body.questionId || "").trim();

    const isQuestionEvent = !!questionId;
    const persistedTopicId = isQuestionEvent ? (topicId || `${QUESTION_BANK_EVENT_PREFIX}${questionId}`) : topicId;
    const persistedSubtopicId = isQuestionEvent ? (subtopicId || null) : subtopicId;

    await db.insert(eventsTable).values({
      userId: authUser.id,
      universityId: authUser.universityId,
      year: authUser.year,
      branch: authUser.branch,
      exam: body.exam,
      configId: body.configId,
      topicId: persistedTopicId || null,
      subtopicId: persistedSubtopicId || null,
      questionId: questionId || null,
    });

    res.status(201).json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to track event");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

