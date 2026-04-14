import { Router, type IRouter } from "express";
import { GetNodesQueryParams, GetNodesResponse } from "../api-zod";
import { db, nodesTable, configsTable, usersTable } from "../db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

function parseStructuredExplanation(rawText: string | null | undefined): {
  coreExplanation: string | null;
  learningGoal: string | null;
  exampleBlock: string | null;
  supportNote: string | null;
} {
  const text = String(rawText || "").trim();
  if (!text) {
    return {
      coreExplanation: null,
      learningGoal: null,
      exampleBlock: null,
      supportNote: null,
    };
  }

  const sections: Record<"core" | "goal" | "example" | "note", string[]> = {
    core: [],
    goal: [],
    example: [],
    note: [],
  };

  let current: keyof typeof sections = "core";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      sections[current].push("");
      continue;
    }

    const headingRules: Array<{ key: keyof typeof sections; re: RegExp }> = [
      { key: "core", re: /^\s*core idea\s*:?\s*(.*)$/i },
      { key: "goal", re: /^\s*learning goal\s*:?\s*(.*)$/i },
      { key: "example", re: /^\s*quick example\s*:?\s*(.*)$/i },
      { key: "note", re: /^\s*(?:helper note|helpful note|support note)\s*:?\s*(.*)$/i },
    ];

    let matched = false;
    for (const rule of headingRules) {
      const m = trimmed.match(rule.re);
      if (m) {
        current = rule.key;
        const tail = String(m[1] || "").trim();
        if (tail) sections[current].push(tail);
        matched = true;
        break;
      }
    }
    if (!matched) sections[current].push(trimmed);
  }

  const clean = (value: string) => value.trim() || null;
  return {
    coreExplanation: clean(sections.core.join("\n")) ?? text,
    learningGoal: clean(sections.goal.join("\n")),
    exampleBlock: clean(sections.example.join("\n")),
    supportNote: clean(sections.note.join("\n")),
  };
}

function toOrder(value: string | null | undefined): number {
  const n = Number(String(value || "").trim());
  return Number.isFinite(n) ? n : 0;
}

function parseTextArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v || "").trim()).filter(Boolean);
  }
  const text = String(raw ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v || "").trim()).filter(Boolean);
    }
  } catch {
    // fall through
  }
  if (text.includes(",")) {
    return text.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return [text];
}

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

router.get("/nodes", async (req, res) => {
  try {
    const { configId } = GetNodesQueryParams.parse(req.query);
    const [config] = await db
      .select({
        id: configsTable.id,
        universityId: configsTable.universityId,
        year: configsTable.year,
        branch: configsTable.branch,
        status: configsTable.status,
      })
      .from(configsTable)
      .where(eq(configsTable.id, configId))
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
        const yearMismatch = !doesStudentYearMatchConfigYear(user.year, config.year);
        const branchMismatch = normalizeToken(user.branch) !== normalizeToken(config.branch);
        if (!isSuperStudent && (yearMismatch || branchMismatch)) {
          res.status(403).json({ error: "Access denied." });
          return;
        }
      }
    } else if (config.status !== "live") {
      res.status(403).json({ error: "Access denied." });
      return;
    }

    const nodes = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.configId, configId));

    const siblingMap = new Map<string, typeof nodes>();
    for (const n of nodes) {
      const key = String(n.parentId || "__root__");
      const arr = siblingMap.get(key) || [];
      arr.push(n);
      siblingMap.set(key, arr);
    }
    for (const [key, arr] of siblingMap.entries()) {
      arr.sort((a, b) => {
        const byOrder = toOrder(a.sortOrder) - toOrder(b.sortOrder);
        if (byOrder !== 0) return byOrder;
        return String(a.title || "").localeCompare(String(b.title || ""));
      });
      siblingMap.set(key, arr);
    }

    const response = GetNodesResponse.parse(
      nodes.map((n) => {
        const structured = parseStructuredExplanation(n.explanation);
        const siblings = siblingMap.get(String(n.parentId || "__root__")) || [];
        const idx = siblings.findIndex((s) => s.id === n.id);
        const prev = idx > 0 ? siblings[idx - 1] : null;
        const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
        const explicitPrereqTitles = parseTextArray((n as any).prerequisiteTitles);
        const explicitPrereqNodeIds = parseTextArray((n as any).prerequisiteNodeIds);
        const explicitNextTitles = parseTextArray((n as any).nextRecommendedTitles);
        const explicitNextNodeIds = parseTextArray((n as any).nextRecommendedNodeIds);
        return {
          id: n.id,
          configId: n.configId,
          title: n.title,
          type: n.type,
          parentId: n.parentId,
          explanation: structured.coreExplanation,
          learningGoal: String((n as any).learningGoal || "").trim() || structured.learningGoal,
          exampleBlock: String((n as any).exampleBlock || "").trim() || structured.exampleBlock,
          supportNote: String((n as any).supportNote || "").trim() || structured.supportNote,
          prerequisiteTitles: explicitPrereqTitles.length > 0 ? explicitPrereqTitles : prev ? [prev.title] : [],
          prerequisiteNodeIds: explicitPrereqNodeIds.length > 0 ? explicitPrereqNodeIds : prev ? [prev.id] : [],
          nextRecommendedTitles: explicitNextTitles.length > 0 ? explicitNextTitles : next ? [next.title] : [],
          nextRecommendedNodeIds: explicitNextNodeIds.length > 0 ? explicitNextNodeIds : next ? [next.id] : [],
          sortOrder: n.sortOrder,
        };
      })
    );

    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Failed to fetch nodes");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

