import { db, configsTable, nodesTable, subtopicContentsTable, subtopicQuestionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { askClaude, askClaudeWithImage } from "./claude";
import { extractTextFromPdf, isImageMimeType, isPdfMimeType } from "./pdfExtractor";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";
import { randomUUID } from "crypto";

interface GenerationProgress {
  configId: string;
  status: "idle" | "parsing" | "generating" | "complete" | "error";
  progress: number;
  total: number;
  currentStep: string;
  error: string | null;
}

const progressMap = new Map<string, GenerationProgress>();

export function getProgress(configId: string): GenerationProgress {
  return (
    progressMap.get(configId) || {
      configId,
      status: "idle",
      progress: 0,
      total: 0,
      currentStep: "Not started",
      error: null,
    }
  );
}

function setProgress(configId: string, updates: Partial<GenerationProgress>) {
  const current = getProgress(configId);
  progressMap.set(configId, { ...current, ...updates });
}

interface ParsedTopic {
  title: string;
  subtopics: string[];
}

interface ParsedSyllabus {
  units: {
    title: string;
    topics: ParsedTopic[];
  }[];
}

async function fetchFileContent(
  objectPath: string
): Promise<{ text?: string; imageBase64?: string; mediaType?: string }> {
  const storageService = new ObjectStorageService();
  const file = await storageService.getObjectEntityFile(objectPath);
  const [metadata] = await file.getMetadata();
  const contentType = (metadata.contentType as string) || "application/octet-stream";

  const [buffer] = await file.download();

  if (isPdfMimeType(contentType)) {
    const text = await extractTextFromPdf(Buffer.from(buffer));
    return { text };
  }

  if (isImageMimeType(contentType)) {
    const base64 = Buffer.from(buffer).toString("base64");
    return { imageBase64: base64, mediaType: contentType };
  }

  return { text: Buffer.from(buffer).toString("utf-8") };
}

async function extractSyllabusText(config: {
  syllabusFileUrl: string | null;
}): Promise<string> {
  if (!config.syllabusFileUrl) throw new Error("No syllabus file URL");

  const content = await fetchFileContent(config.syllabusFileUrl);

  if (content.text) return content.text;

  if (content.imageBase64 && content.mediaType) {
    return askClaudeWithImage(
      "You are an OCR assistant. Extract all text from this image of a syllabus document. Return only the extracted text, preserving structure.",
      "Extract all text from this syllabus image.",
      content.imageBase64,
      content.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    );
  }

  throw new Error("Could not extract text from syllabus file");
}

async function extractPaperText(paperFileUrls: string[]): Promise<string> {
  const texts: string[] = [];
  for (const url of paperFileUrls) {
    try {
      const content = await fetchFileContent(url);
      if (content.text) {
        texts.push(content.text);
      } else if (content.imageBase64 && content.mediaType) {
        const text = await askClaudeWithImage(
          "You are an OCR assistant. Extract all text from this image of an exam question paper. Return only the extracted text.",
          "Extract all text from this question paper image.",
          content.imageBase64,
          content.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        );
        texts.push(text);
      }
    } catch (err) {
      logger.warn({ err, url }, "Failed to extract text from paper file");
    }
  }
  return texts.join("\n\n---\n\n");
}

async function parseSyllabus(
  syllabusText: string,
  subject: string
): Promise<ParsedSyllabus> {
  const prompt = `You are a syllabus parser for college exam prep. Given a syllabus for the subject "${subject}", extract its structure into units, topics, and subtopics.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "units": [
    {
      "title": "Unit 1: <unit title>",
      "topics": [
        {
          "title": "<topic title>",
          "subtopics": ["<subtopic 1>", "<subtopic 2>"]
        }
      ]
    }
  ]
}

Rules:
- Preserve the original unit structure from the syllabus
- Each topic should have 2-5 meaningful subtopics
- Subtopics should be specific, learnable concepts
- Order topics and subtopics in a logical learning progression
- If the syllabus is vague, infer reasonable subtopics for the subject`;

  const response = await askClaude(prompt, syllabusText, 4000);
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse syllabus structure from AI response");
  return JSON.parse(jsonMatch[0]);
}

async function generateSubtopicContent(
  subject: string,
  unitTitle: string,
  topicTitle: string,
  subtopicTitle: string,
  paperContext: string
): Promise<{
  explanation: string;
  questions: { markType: "2" | "5"; question: string; answer: string }[];
}> {
  const prompt = `You are an expert exam prep content creator for the subject "${subject}".

Generate study content for: ${subtopicTitle} (under ${topicTitle}, ${unitTitle}).

Return ONLY valid JSON (no markdown, no explanation):
{
  "explanation": "<detailed explanation of the concept, 200-400 words, covering key definitions, principles, and examples>",
  "questions": [
    {"markType": "2", "question": "<short answer question>", "answer": "<concise answer, 50-80 words>"},
    {"markType": "2", "question": "<another short answer question>", "answer": "<concise answer>"},
    {"markType": "5", "question": "<detailed/essay question>", "answer": "<comprehensive answer, 150-250 words with structure>"},
    {"markType": "5", "question": "<another detailed question>", "answer": "<comprehensive answer>"}
  ]
}

Rules:
- Explanation should be clear, exam-focused, and cover the core concept
- Generate exactly 2 two-mark questions and 2 five-mark questions
- 2-mark questions: definition/comparison/list type, brief answers
- 5-mark questions: explain/compare/algorithm/diagram type, detailed answers
- Mix questions inspired by the paper patterns below with original relevant questions so it's not obvious which came from papers
- Answers should be exam-ready: structured, with key points highlighted

${paperContext ? `Previous exam paper context for reference:\n${paperContext.substring(0, 2000)}` : "No previous papers available - generate standard exam questions."}`;

  const response = await askClaude(
    "You are an expert college exam prep content generator. Always respond with valid JSON only.",
    prompt,
    4000
  );
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to parse content for ${subtopicTitle}`);
  return JSON.parse(jsonMatch[0]);
}

export async function runGeneration(configId: string) {
  try {
    setProgress(configId, {
      configId,
      status: "parsing",
      progress: 0,
      total: 1,
      currentStep: "Fetching config...",
      error: null,
    });

    const [config] = await db
      .select()
      .from(configsTable)
      .where(eq(configsTable.id, configId))
      .limit(1);

    if (!config) throw new Error(`Config ${configId} not found`);

    setProgress(configId, { currentStep: "Extracting syllabus text..." });
    const syllabusText = await extractSyllabusText(config);

    let paperText = "";
    if (config.paperFileUrls && config.paperFileUrls.length > 0) {
      setProgress(configId, { currentStep: "Extracting paper text..." });
      paperText = await extractPaperText(config.paperFileUrls);
    }

    setProgress(configId, { currentStep: "Parsing syllabus structure..." });
    const parsed = await parseSyllabus(syllabusText, config.subject);

    const existingNodes = await db
      .select({ id: nodesTable.id })
      .from(nodesTable)
      .where(eq(nodesTable.configId, configId));

    if (existingNodes.length > 0) {
      const nodeIds = existingNodes.map((n) => n.id);
      for (const nid of nodeIds) {
        await db.delete(subtopicQuestionsTable).where(eq(subtopicQuestionsTable.nodeId, nid));
        await db.delete(subtopicContentsTable).where(eq(subtopicContentsTable.nodeId, nid));
      }
      await db.delete(nodesTable).where(eq(nodesTable.configId, configId));
    }

    let totalSubtopics = 0;
    for (const unit of parsed.units) {
      for (const topic of unit.topics) {
        totalSubtopics += topic.subtopics.length;
      }
    }

    setProgress(configId, {
      status: "generating",
      progress: 0,
      total: totalSubtopics,
      currentStep: "Creating node tree...",
    });

    let subtopicCount = 0;

    for (let ui = 0; ui < parsed.units.length; ui++) {
      const unit = parsed.units[ui];
      const unitId = `${configId}_u${ui + 1}`;

      await db.insert(nodesTable).values({
        id: unitId,
        configId,
        title: unit.title,
        type: "unit",
        parentId: null,
        sortOrder: String(ui + 1),
      });

      for (let ti = 0; ti < unit.topics.length; ti++) {
        const topic = unit.topics[ti];
        const topicId = `${configId}_u${ui + 1}_t${ti + 1}`;

        await db.insert(nodesTable).values({
          id: topicId,
          configId,
          title: topic.title,
          type: "topic",
          parentId: unitId,
          sortOrder: String(ti + 1),
        });

        for (let si = 0; si < topic.subtopics.length; si++) {
          const subtopicTitle = topic.subtopics[si];
          const subtopicId = `${configId}_u${ui + 1}_t${ti + 1}_s${si + 1}`;

          await db.insert(nodesTable).values({
            id: subtopicId,
            configId,
            title: subtopicTitle,
            type: "subtopic",
            parentId: topicId,
            sortOrder: String(si + 1),
          });

          setProgress(configId, {
            progress: subtopicCount,
            currentStep: `Generating: ${subtopicTitle}`,
          });

          try {
            const content = await generateSubtopicContent(
              config.subject,
              unit.title,
              topic.title,
              subtopicTitle,
              paperText
            );

            const contentId = randomUUID();
            await db.insert(subtopicContentsTable).values({
              id: contentId,
              nodeId: subtopicId,
              explanation: content.explanation,
            });

            for (const q of content.questions) {
              await db.insert(subtopicQuestionsTable).values({
                nodeId: subtopicId,
                markType: q.markType,
                question: q.question,
                answer: q.answer,
              });
            }
          } catch (err) {
            logger.error({ err, subtopicTitle }, "Failed to generate content for subtopic");
          }

          subtopicCount++;
        }
      }
    }

    setProgress(configId, {
      status: "complete",
      progress: totalSubtopics,
      total: totalSubtopics,
      currentStep: "Generation complete!",
    });

    logger.info({ configId, subtopicCount: totalSubtopics }, "Generation complete");
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, configId }, "Generation failed");
    setProgress(configId, {
      status: "error",
      currentStep: "Generation failed",
      error: errorMsg,
    });
  }
}
