import { Router, type IRouter } from "express";
import {
  CreateConfigBody,
  UploadConfigFilesBody,
  UploadConfigFilesParams,
  TriggerGenerationParams,
  GetGenerationStatusParams,
  GetGenerationStatusResponse,
  PublishConfigParams,
} from "@workspace/api-zod";
import { db, configsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { runGeneration, getProgress } from "../lib/generator";
import { requireAdmin } from "../middleware/adminAuth";

const router: IRouter = Router();

router.post("/configs", requireAdmin, async (req, res) => {
  try {
    const body = CreateConfigBody.parse(req.body);
    const userId = (req as any).userId as string;
    const id = randomUUID().substring(0, 8);

    await db.insert(configsTable).values({
      id,
      universityId: body.universityId,
      year: body.year,
      branch: body.branch,
      subject: body.subject,
      exam: body.exam,
      status: "draft",
      createdBy: userId,
    });

    const [config] = await db
      .select()
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    res.status(201).json({
      id: config.id,
      universityId: config.universityId,
      year: config.year,
      branch: config.branch,
      subject: config.subject,
      exam: config.exam,
      status: config.status,
      createdBy: config.createdBy,
      createdAt: config.createdAt?.toISOString(),
      syllabusFileUrl: config.syllabusFileUrl ?? null,
      paperFileUrls: config.paperFileUrls ?? null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to create config");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/configs/:id/upload", requireAdmin, async (req, res) => {
  try {
    const { id } = UploadConfigFilesParams.parse(req.params);
    const body = UploadConfigFilesBody.parse(req.body);

    if (!body.syllabusFileUrl.startsWith("/objects/")) {
      res.status(400).json({ error: "syllabusFileUrl must be a valid object path starting with /objects/" });
      return;
    }
    for (const url of body.paperFileUrls) {
      if (!url.startsWith("/objects/")) {
        res.status(400).json({ error: "paperFileUrls must be valid object paths starting with /objects/" });
        return;
      }
    }

    const [config] = await db
      .select()
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    await db
      .update(configsTable)
      .set({
        syllabusFileUrl: body.syllabusFileUrl,
        paperFileUrls: body.paperFileUrls,
      })
      .where(eq(configsTable.id, id));

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to upload config files");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/configs/:id/generate", requireAdmin, async (req, res) => {
  try {
    const { id } = TriggerGenerationParams.parse(req.params);

    const [config] = await db
      .select()
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    if (!config.syllabusFileUrl) {
      res.status(400).json({ error: "No syllabus file uploaded" });
      return;
    }

    runGeneration(id).catch((err) => {
      req.log.error({ err, configId: id }, "Background generation failed");
    });

    res.status(202).json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to trigger generation");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/configs/:id/generation-status", async (req, res) => {
  try {
    const { id } = GetGenerationStatusParams.parse(req.params);
    const progress = getProgress(id);

    const response = GetGenerationStatusResponse.parse({
      configId: progress.configId,
      status: progress.status,
      progress: progress.progress,
      total: progress.total,
      currentStep: progress.currentStep,
      error: progress.error,
    });

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Failed to get generation status");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/configs/:id/publish", requireAdmin, async (req, res) => {
  try {
    const { id } = PublishConfigParams.parse(req.params);

    const [config] = await db
      .select()
      .from(configsTable)
      .where(eq(configsTable.id, id))
      .limit(1);

    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    await db
      .update(configsTable)
      .set({ status: "live" })
      .where(eq(configsTable.id, id));

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to publish config");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
