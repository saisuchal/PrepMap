import { Router, type IRouter } from "express";
import { GetSubtopicContentParams, GetSubtopicContentResponse } from "@workspace/api-zod";
import { db, subtopicContentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/subtopics/:id", async (req, res) => {
  try {
    const { id } = GetSubtopicContentParams.parse(req.params);

    const [content] = await db
      .select()
      .from(subtopicContentsTable)
      .where(eq(subtopicContentsTable.nodeId, id))
      .limit(1);

    if (!content) {
      res.status(404).json({ error: "Subtopic not found" });
      return;
    }

    const response = GetSubtopicContentResponse.parse({
      id: content.id,
      nodeId: content.nodeId,
      explanation: content.explanation,
      twoMarkQuestion: content.twoMarkQuestion,
      twoMarkAnswer: content.twoMarkAnswer,
      fiveMarkQuestion: content.fiveMarkQuestion,
      fiveMarkAnswer: content.fiveMarkAnswer,
    });

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch subtopic content");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
