import { Router, type IRouter } from "express";
import { TrackEventBody } from "@workspace/api-zod";
import { db, eventsTable } from "@workspace/db";

const router: IRouter = Router();

router.post("/events", async (req, res) => {
  try {
    const body = TrackEventBody.parse(req.body);

    await db.insert(eventsTable).values({
      userId: body.userId,
      universityId: body.universityId,
      year: body.year,
      branch: body.branch,
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
