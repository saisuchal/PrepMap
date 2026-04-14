import { Router, type IRouter } from "express";
import { TrackEventBody } from "../api-zod";
import { db, eventsTable, usersTable } from "../db";
import { and, desc, eq } from "drizzle-orm";

const router: IRouter = Router();
const TOPIC_INTERACTION_PREFIX = "__topic__:";

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
        timestamp: eventsTable.timestamp,
      })
      .from(eventsTable)
      .where(and(eq(eventsTable.userId, authUserId), eq(eventsTable.configId, configId)))
      .orderBy(desc(eventsTable.timestamp))
      .limit(25);

    const row = latestEvents[0];
    const latest = latestEvents.find((e) => String(e.subtopicId || "").trim()) || null;
    const rawSubtopicId = String(latest?.subtopicId || "").trim();
    const isTopicInteraction = rawSubtopicId.startsWith(TOPIC_INTERACTION_PREFIX);
    const derivedTopicFromPrefix = isTopicInteraction
      ? rawSubtopicId.slice(TOPIC_INTERACTION_PREFIX.length).trim()
      : "";
    const mapNodeId = isTopicInteraction
      ? (derivedTopicFromPrefix || String(latest?.topicId || "").trim() || null)
      : null;
    const qbSubtopicId = isTopicInteraction ? null : (rawSubtopicId || null);

    res.status(200).json({
      configId,
      userId: authUserId,
      mapNodeId,
      qbSubtopicId,
      qbQuestionId: null,
      eventAt: latest?.timestamp ? new Date(latest.timestamp).toISOString() : null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch latest interaction state");
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

