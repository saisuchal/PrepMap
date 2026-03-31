import { Router, type IRouter } from "express";
import { db, subjectsTable, unitLibraryTable, configUnitLinksTable, configsTable, subjectReadingMaterialsTable } from "../db";
import { and, eq, inArray } from "drizzle-orm";
import { requireAdmin } from "../middleware/adminAuth";
import { randomUUID } from "crypto";
import { askAI } from "../lib/ai";
import { parseFirstModelJsonObject } from "../lib/parseModelJson";

const router: IRouter = Router();

type UnitTopicInput = {
  title: string;
  subtopics: string[];
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUploadedObjectPath(rawPath: string): string {
  let path = String(rawPath || "").trim();
  if (path.startsWith("objects/")) {
    path = `/${path}`;
  }
  path = path.replace(/^\/objects\/+objects\//, "/objects/");
  path = path.replace(/^\/supabase\/+supabase\//, "/supabase/");
  return path;
}

function isSupportedStoragePath(path: string): boolean {
  return path.startsWith("/objects/") || path.startsWith("/supabase/");
}

function sanitizeTopics(input: unknown): UnitTopicInput[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((t) => ({
      title: typeof (t as any)?.title === "string" ? (t as any).title.trim() : "",
      subtopics: Array.isArray((t as any)?.subtopics)
        ? (t as any).subtopics
            .filter((s: unknown) => typeof s === "string")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [],
    }))
    .filter((t) => t.title.length > 0);
}

type BatchMaterialInput = {
  materialId: string;
  explicitTitle: string | null;
  titleHint: string;
  readingText: string;
};

function createFallbackUnitTitle(): string {
  return `unit-${Math.floor(10000 + Math.random() * 90000)}`;
}

type ExtractedMaterialStructure = {
  unitTitle: string;
  topics: UnitTopicInput[];
};

async function extractTopicsForMaterialsBatch(
  subjectName: string,
  materials: BatchMaterialInput[],
): Promise<Map<string, ExtractedMaterialStructure>> {
  const capped = materials.slice(0, 3).map((m) => ({
    materialId: m.materialId,
    explicitTitle: m.explicitTitle,
    titleHint: m.titleHint,
    readingText: m.readingText.slice(0, 18000),
  }));

  const normalizedSubject = normalizeText(subjectName);
  const isAptitudeLike =
    /(aptitude|numerical|quant|reasoning|probability|time and work|permutation|combination|pipes|cistern|man chain|wages)/i.test(
      normalizedSubject,
    );
  const subjectGuidance = isAptitudeLike
    ? `SUBJECT PROFILE: aptitude / numerical ability.
- Make topic titles chapter-like and method-specific (not generic labels).
- Avoid standalone vague topics: "Overview", "Concepts", "Methods", "Examples", "Rules and Tricks", "Practice".
- If source has a generic section, fold it into a concrete topic.
- Subtopics should be formula/rule/procedure/problem-pattern oriented and exam-solvable.
- Keep wording simple and direct for beginners.`
    : `SUBJECT PROFILE: general.
- Keep topic titles specific and exam-relevant.
- Avoid vague placeholders unless explicitly present as true headings in source.`;

  const prompt = `You are a syllabus structure extractor for "${subjectName}".

Extract exactly one unit structure for each reading material.

Return ONLY valid JSON:
{
  "materials": [
    {
      "materialId": "same id from input",
      "unitTitle": "single unit title for this material",
      "topics": [
        { "title": "Topic title", "subtopics": ["Subtopic 1", "Subtopic 2"] }
      ]
    }
  ]
}

STRICT RULES:
- Each materialId must appear exactly once.
- Exactly one unit per material. Never split one material into multiple units.
- Never merge materials.
- If explicitTitle is provided for a material, use it exactly as unitTitle.
- If explicitTitle is empty, choose a concise unitTitle from the material content.
- If unsure for a material with no explicitTitle, use its titleHint.
- Keep 2-8 topics per material when possible.
- Keep 2-6 subtopics per topic when possible.
- Use concise exam-relevant wording.
- Topic titles must be specific and informative.
- Subtopics must be concrete enough to generate exam questions directly.

${subjectGuidance}`;

  const response = await askAI(
    "You extract topic/subtopic structures and return strict JSON only.",
    `${prompt}

MATERIALS:
${JSON.stringify(capped, null, 2)}`,
    6500,
    { requireJson: true },
  );

  const parsed = parseFirstModelJsonObject<{
    materials?: Array<{
      materialId?: string;
      unitTitle?: string;
      topics?: Array<{ title?: string; subtopics?: string[] }>;
    }>;
  }>(response);

  const out = new Map<string, ExtractedMaterialStructure>();
  for (const row of parsed.materials ?? []) {
    const materialId = String(row?.materialId || "").trim();
    if (!materialId) continue;
    const unitTitle = String(row?.unitTitle || "").trim();
    const topics = (row.topics ?? [])
      .map((t) => ({
        title: String(t?.title || "").trim(),
        subtopics: Array.isArray(t?.subtopics)
          ? t.subtopics.map((s) => String(s).trim()).filter(Boolean)
          : [],
      }))
      .filter((t) => t.title.length > 0);
    out.set(materialId, {
      unitTitle,
      topics,
    });
  }

  return out;
}

router.get("/admin/library/subjects", requireAdmin, async (req, res) => {
  try {
    const subjects = await db
      .select({
        id: subjectsTable.id,
        name: subjectsTable.name,
        normalizedName: subjectsTable.normalizedName,
        createdAt: subjectsTable.createdAt,
        updatedAt: subjectsTable.updatedAt,
      })
      .from(subjectsTable);

    subjects.sort((a, b) => a.name.localeCompare(b.name));
    res.json(
      subjects.map((s) => ({
        ...s,
        createdAt: s.createdAt?.toISOString() ?? null,
        updatedAt: s.updatedAt?.toISOString() ?? null,
      })),
    );
  } catch (error) {
    req.log.error({ err: error }, "Failed to list library subjects");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/library/subjects", requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const normalizedName = normalizeText(name);
    if (!normalizedName) {
      res.status(400).json({ error: "name is invalid" });
      return;
    }

    const [existing] = await db
      .select({ id: subjectsTable.id, name: subjectsTable.name })
      .from(subjectsTable)
      .where(eq(subjectsTable.normalizedName, normalizedName))
      .limit(1);

    const userId = String((req as any).userId || "admin");

    if (existing) {
      await db
        .update(subjectsTable)
        .set({
          name,
          updatedAt: new Date(),
        })
        .where(eq(subjectsTable.id, existing.id));

      res.json({ id: existing.id, name, normalizedName });
      return;
    }

    const id = `sub_${randomUUID().substring(0, 8)}`;
    await db.insert(subjectsTable).values({
      id,
      name,
      normalizedName,
      createdBy: userId,
    });

    res.status(201).json({ id, name, normalizedName });
  } catch (error) {
    req.log.error({ err: error }, "Failed to upsert library subject");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/library/units", requireAdmin, async (req, res) => {
  try {
    const subjectId = String(req.query.subjectId || "").trim();
    if (!subjectId) {
      res.status(400).json({ error: "subjectId is required" });
      return;
    }

    const units = await db
      .select({
        id: unitLibraryTable.id,
        subjectId: unitLibraryTable.subjectId,
        unitTitle: unitLibraryTable.unitTitle,
        normalizedUnitTitle: unitLibraryTable.normalizedUnitTitle,
        topics: unitLibraryTable.topics,
        sourceText: unitLibraryTable.sourceText,
        createdBy: unitLibraryTable.createdBy,
        createdAt: unitLibraryTable.createdAt,
        updatedAt: unitLibraryTable.updatedAt,
      })
      .from(unitLibraryTable)
      .where(eq(unitLibraryTable.subjectId, subjectId));

    units.sort((a, b) => a.unitTitle.localeCompare(b.unitTitle));
    res.json(
      units.map((u) => ({
        ...u,
        createdAt: u.createdAt?.toISOString() ?? null,
        updatedAt: u.updatedAt?.toISOString() ?? null,
      })),
    );
  } catch (error) {
    req.log.error({ err: error }, "Failed to list library units");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/library/reading-materials", requireAdmin, async (req, res) => {
  try {
    const subjectId = String(req.query.subjectId || "").trim();
    if (!subjectId) {
      res.status(400).json({ error: "subjectId is required" });
      return;
    }

    const rows = await db
      .select()
      .from(subjectReadingMaterialsTable)
      .where(eq(subjectReadingMaterialsTable.subjectId, subjectId));

    rows.sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0));

    res.json(
      rows.map((r) => ({
        ...r,
        createdAt: r.createdAt?.toISOString() ?? null,
        updatedAt: r.updatedAt?.toISOString() ?? null,
      })),
    );
  } catch (error) {
    req.log.error({ err: error }, "Failed to list subject reading materials");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/library/reading-materials", requireAdmin, async (req, res) => {
  try {
    const subjectId = String(req.body?.subjectId || "").trim();
    const title = String(req.body?.title || "").trim();
    const materialType = String(req.body?.materialType || "reference").trim() || "reference";
    const fileUrl = normalizeUploadedObjectPath(req.body?.fileUrl || "");
    const sourceOrderRaw = Number(req.body?.sourceOrder ?? 0);
    const sourceOrder = Number.isFinite(sourceOrderRaw) ? Math.max(0, Math.trunc(sourceOrderRaw)) : 0;

    if (!subjectId || !title || !fileUrl) {
      res.status(400).json({ error: "subjectId, title and fileUrl are required" });
      return;
    }
    if (!isSupportedStoragePath(fileUrl)) {
      res.status(400).json({ error: "fileUrl must start with /objects/ or /supabase/" });
      return;
    }

    const [subject] = await db
      .select({ id: subjectsTable.id })
      .from(subjectsTable)
      .where(eq(subjectsTable.id, subjectId))
      .limit(1);
    if (!subject) {
      res.status(404).json({ error: "Subject not found" });
      return;
    }

    const userId = String((req as any).userId || "admin");
    const id = `rm_${randomUUID().substring(0, 10)}`;

    await db.insert(subjectReadingMaterialsTable).values({
      id,
      subjectId,
      title,
      materialType,
      fileUrl,
      sourceOrder,
      isActive: true,
      createdBy: userId,
    });

    const [row] = await db
      .select()
      .from(subjectReadingMaterialsTable)
      .where(eq(subjectReadingMaterialsTable.id, id))
      .limit(1);

    res.status(201).json({
      ...row,
      createdAt: row.createdAt?.toISOString() ?? null,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to create subject reading material");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/library/reading-materials/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }

    const patch: {
      title?: string;
      materialType?: string;
      sourceOrder?: number;
      isActive?: boolean;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (typeof req.body?.title === "string") {
      const title = req.body.title.trim();
      if (!title) {
        res.status(400).json({ error: "title cannot be empty" });
        return;
      }
      patch.title = title;
    }
    if (typeof req.body?.materialType === "string" && req.body.materialType.trim()) {
      patch.materialType = req.body.materialType.trim();
    }
    if (req.body?.sourceOrder !== undefined) {
      const raw = Number(req.body.sourceOrder);
      patch.sourceOrder = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
    }
    if (req.body?.isActive !== undefined) {
      patch.isActive = Boolean(req.body.isActive);
    }

    await db
      .update(subjectReadingMaterialsTable)
      .set(patch)
      .where(eq(subjectReadingMaterialsTable.id, id));

    const [row] = await db
      .select()
      .from(subjectReadingMaterialsTable)
      .where(eq(subjectReadingMaterialsTable.id, id))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Reading material not found" });
      return;
    }

    res.json({
      ...row,
      createdAt: row.createdAt?.toISOString() ?? null,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to update subject reading material");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/library/reading-materials/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }

    await db
      .delete(subjectReadingMaterialsTable)
      .where(eq(subjectReadingMaterialsTable.id, id));

    res.json({ success: true });
  } catch (error) {
    req.log.error({ err: error }, "Failed to delete subject reading material");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/library/units/extract-from-text", requireAdmin, async (req, res) => {
  try {
    const subjectId = String(req.body?.subjectId || "").trim();
    const materialsInput = Array.isArray(req.body?.materials)
      ? req.body.materials
      : [];
    const fallbackReadingText = String(req.body?.readingText || "").trim();
    const fallbackTitle = String(req.body?.materialTitle || "").trim();

    if (!subjectId) {
      res.status(400).json({ error: "subjectId is required" });
      return;
    }

    const [subject] = await db
      .select({ id: subjectsTable.id, name: subjectsTable.name })
      .from(subjectsTable)
      .where(eq(subjectsTable.id, subjectId))
      .limit(1);
    if (!subject) {
      res.status(404).json({ error: "Subject not found" });
      return;
    }

    const materials: BatchMaterialInput[] = (
      materialsInput.length > 0
        ? materialsInput
        : [{ id: "legacy-1", title: fallbackTitle, readingText: fallbackReadingText }]
    )
      .map((m: any, idx: number) => {
        const readingText = String(m?.readingText || "").trim();
        const explicitTitle = String(m?.title || "").trim();
        const materialId = String(m?.id || `material-${idx + 1}`).trim() || `material-${idx + 1}`;
        return {
          materialId,
          explicitTitle: explicitTitle || null,
          titleHint: createFallbackUnitTitle(),
          readingText,
        };
      })
      .filter((m: BatchMaterialInput) => m.readingText.length > 0);

    if (materials.length === 0) {
      res.status(400).json({ error: "At least one non-empty reading material is required" });
      return;
    }
    if (materials.length > 3) {
      res.status(400).json({ error: "You can extract up to 3 reading materials at once" });
      return;
    }

    const userId = String((req as any).userId || "admin");
    const extractedByMaterial = await extractTopicsForMaterialsBatch(subject.name, materials);
    const upserted: Array<{ id: string; unitTitle: string }> = [];

    for (const material of materials) {
      const extracted = extractedByMaterial.get(material.materialId);
      const resolvedUnitTitle = (
        material.explicitTitle ||
        extracted?.unitTitle ||
        material.titleHint
      ).trim();
      const topics = extracted?.topics ?? [];
      const normalizedTopics = topics.length > 0
        ? topics
        : [{ title: "Overview", subtopics: ["Introduction"] }];

      const normalizedUnitTitle = normalizeText(resolvedUnitTitle);
      if (!normalizedUnitTitle) continue;
      const [existing] = await db
        .select({
          id: unitLibraryTable.id,
          unitTitle: unitLibraryTable.unitTitle,
          topics: unitLibraryTable.topics,
          sourceText: unitLibraryTable.sourceText,
        })
        .from(unitLibraryTable)
        .where(and(
          eq(unitLibraryTable.subjectId, subjectId),
          eq(unitLibraryTable.normalizedUnitTitle, normalizedUnitTitle),
        ))
        .limit(1);

      if (existing) {
        const existingTopics = Array.isArray(existing.topics) ? existing.topics : [];
        const hasExistingTopics = existingTopics.length > 0;
        const hasExistingSource = Boolean((existing.sourceText ?? "").trim());
        const patch: {
          unitTitle?: string;
          topics?: UnitTopicInput[];
          sourceText?: string;
          updatedAt: Date;
        } = { updatedAt: new Date() };
        let shouldUpdate = false;

        // Preserve existing extracted/edited content. Only fill missing values.
        if (!String(existing.unitTitle || "").trim()) {
          patch.unitTitle = resolvedUnitTitle;
          shouldUpdate = true;
        }
        if (!hasExistingTopics) {
          patch.topics = normalizedTopics;
          shouldUpdate = true;
        }
        if (!hasExistingSource) {
          patch.sourceText = material.readingText;
          shouldUpdate = true;
        }

        if (shouldUpdate) {
          await db
            .update(unitLibraryTable)
            .set(patch)
            .where(eq(unitLibraryTable.id, existing.id));
        }

        upserted.push({ id: existing.id, unitTitle: existing.unitTitle || resolvedUnitTitle });
        continue;
      }

      const id = `unit_${randomUUID().substring(0, 8)}`;
      await db.insert(unitLibraryTable).values({
        id,
        subjectId,
        unitTitle: resolvedUnitTitle,
        normalizedUnitTitle,
        topics: normalizedTopics,
        sourceText: material.readingText,
        createdBy: userId,
      });
      upserted.push({ id, unitTitle: resolvedUnitTitle });
    }

    res.json({
      success: true,
      subjectId,
      extractedCount: upserted.length,
      units: upserted,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to extract units from text");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/library/units/upsert", requireAdmin, async (req, res) => {
  try {
    const subjectId = String(req.body?.subjectId || "").trim();
    const unitTitle = String(req.body?.unitTitle || "").trim();
    const sourceText = req.body?.sourceText ? String(req.body.sourceText) : null;
    const topics = sanitizeTopics(req.body?.topics);

    if (!subjectId || !unitTitle) {
      res.status(400).json({ error: "subjectId and unitTitle are required" });
      return;
    }

    const [subject] = await db
      .select({ id: subjectsTable.id })
      .from(subjectsTable)
      .where(eq(subjectsTable.id, subjectId))
      .limit(1);
    if (!subject) {
      res.status(404).json({ error: "Subject not found" });
      return;
    }

    const normalizedUnitTitle = normalizeText(unitTitle);
    if (!normalizedUnitTitle) {
      res.status(400).json({ error: "unitTitle is invalid" });
      return;
    }

    const [existing] = await db
      .select({ id: unitLibraryTable.id })
      .from(unitLibraryTable)
      .where(and(
        eq(unitLibraryTable.subjectId, subjectId),
        eq(unitLibraryTable.normalizedUnitTitle, normalizedUnitTitle),
      ))
      .limit(1);

    const userId = String((req as any).userId || "admin");

    if (existing) {
      await db
        .update(unitLibraryTable)
        .set({
          unitTitle,
          topics,
          sourceText,
          updatedAt: new Date(),
        })
        .where(eq(unitLibraryTable.id, existing.id));

      res.json({
        id: existing.id,
        subjectId,
        unitTitle,
        normalizedUnitTitle,
        topics,
        sourceText,
      });
      return;
    }

    const id = `unit_${randomUUID().substring(0, 8)}`;
    await db.insert(unitLibraryTable).values({
      id,
      subjectId,
      unitTitle,
      normalizedUnitTitle,
      topics,
      sourceText,
      createdBy: userId,
    });

    res.status(201).json({
      id,
      subjectId,
      unitTitle,
      normalizedUnitTitle,
      topics,
      sourceText,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to upsert library unit");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/library/units/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }

    const [existing] = await db
      .select({
        id: unitLibraryTable.id,
        subjectId: unitLibraryTable.subjectId,
      })
      .from(unitLibraryTable)
      .where(eq(unitLibraryTable.id, id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Unit not found" });
      return;
    }

    const nextUnitTitleRaw = req.body?.unitTitle;
    const nextTopicsRaw = req.body?.topics;
    const nextSourceRaw = req.body?.sourceText;

    const patch: {
      unitTitle?: string;
      normalizedUnitTitle?: string;
      topics?: UnitTopicInput[];
      sourceText?: string | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (typeof nextUnitTitleRaw === "string") {
      const unitTitle = nextUnitTitleRaw.trim();
      if (!unitTitle) {
        res.status(400).json({ error: "unitTitle cannot be empty" });
        return;
      }
      const normalized = normalizeText(unitTitle);
      const [duplicate] = await db
        .select({ id: unitLibraryTable.id })
        .from(unitLibraryTable)
        .where(and(
          eq(unitLibraryTable.subjectId, existing.subjectId),
          eq(unitLibraryTable.normalizedUnitTitle, normalized),
        ))
        .limit(1);

      if (duplicate && duplicate.id !== id) {
        res.status(409).json({ error: "A unit with this title already exists for the subject" });
        return;
      }

      patch.unitTitle = unitTitle;
      patch.normalizedUnitTitle = normalized;
    }

    if (nextTopicsRaw !== undefined) {
      patch.topics = sanitizeTopics(nextTopicsRaw);
    }

    if (nextSourceRaw !== undefined) {
      patch.sourceText = nextSourceRaw ? String(nextSourceRaw) : null;
    }

    await db
      .update(unitLibraryTable)
      .set(patch)
      .where(eq(unitLibraryTable.id, id));

    const [updated] = await db
      .select()
      .from(unitLibraryTable)
      .where(eq(unitLibraryTable.id, id))
      .limit(1);

    res.json({
      ...updated,
      createdAt: updated.createdAt?.toISOString() ?? null,
      updatedAt: updated.updatedAt?.toISOString() ?? null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to update library unit");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/library/config-units", requireAdmin, async (req, res) => {
  try {
    const configId = String(req.query.configId || "").trim();
    if (!configId) {
      res.status(400).json({ error: "configId is required" });
      return;
    }

    const links = await db
      .select({
        unitLibraryId: configUnitLinksTable.unitLibraryId,
        sortOrder: configUnitLinksTable.sortOrder,
      })
      .from(configUnitLinksTable)
      .where(eq(configUnitLinksTable.configId, configId));

    links.sort((a, b) => (a.sortOrder || "").localeCompare(b.sortOrder || ""));
    res.json({
      configId,
      unitIds: links.map((l) => l.unitLibraryId),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch config unit links");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/library/config-units/:configId", requireAdmin, async (req, res) => {
  try {
    const configId = String(req.params.configId || "").trim();
    const unitIds = Array.isArray(req.body?.unitIds)
      ? req.body.unitIds.filter((v: unknown) => typeof v === "string").map((v: string) => v.trim()).filter(Boolean)
      : [];

    if (!configId) {
      res.status(400).json({ error: "configId is required" });
      return;
    }

    const [config] = await db
      .select({ id: configsTable.id })
      .from(configsTable)
      .where(eq(configsTable.id, configId))
      .limit(1);
    if (!config) {
      res.status(404).json({ error: "Config not found" });
      return;
    }

    if (unitIds.length > 0) {
      const existingUnits = await db
        .select({ id: unitLibraryTable.id })
        .from(unitLibraryTable)
        .where(inArray(unitLibraryTable.id, unitIds));
      const existingSet = new Set(existingUnits.map((u) => u.id));
      const missing = unitIds.filter((id) => !existingSet.has(id));
      if (missing.length > 0) {
        res.status(400).json({ error: `Unknown unit ids: ${missing.join(", ")}` });
        return;
      }
    }

    await db
      .delete(configUnitLinksTable)
      .where(eq(configUnitLinksTable.configId, configId));

    for (let i = 0; i < unitIds.length; i++) {
      await db.insert(configUnitLinksTable).values({
        id: `cul_${randomUUID().substring(0, 10)}`,
        configId,
        unitLibraryId: unitIds[i],
        sortOrder: String(i + 1),
      });
    }

    res.json({ success: true, configId, unitIds });
  } catch (error) {
    req.log.error({ err: error }, "Failed to update config unit links");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
