function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripBulletPrefix(line: string): { prefix: string; content: string } {
  const match = line.match(/^(\s*(?:[-*]|•)\s+)(.*)$/);
  if (!match) return { prefix: "", content: line.trim() };
  return { prefix: match[1], content: match[2].trim() };
}

function looksFormulaLike(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/[=/*×^()!]/.test(text)) return true;
  if (/\b\d+\s*[A-Za-z]\s*\d+\b/.test(text)) return true;
  if (/\b\d+\s*[CcPp]\s*\d+\b/.test(text)) return true;
  return false;
}

function isContinuationFragment(current: string, previous: string): boolean {
  const c = current.trim();
  const p = previous.trim();
  if (!c || !p) return false;

  if (/^(?:[/×x*+\-)=]|(?:x|X)\s)/.test(c)) return true;
  if (/^[)\]}.,;:]+$/.test(c)) return true;

  const previousEndsLikePendingMath = /(?:=|\/|×|x|\*|\+|\-|\(|\bformula\b|\bexample\b)\s*$/i.test(p);
  if (previousEndsLikePendingMath && looksFormulaLike(c)) return true;

  const shortFormulaFragment = c.length <= 48 && looksFormulaLike(c) && !/[a-z]{4,}/i.test(c);
  if (shortFormulaFragment && looksFormulaLike(p)) return true;

  return false;
}

function mergeLineContent(previous: string, current: string): string {
  return collapseSpaces(`${previous} ${current}`);
}

export function repairBrokenFormulaBullets(text: string): string {
  const source = String(text || "");
  if (!source.trim()) return source;

  const lines = source.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const raw = line.replace(/\s+$/g, "");
    const trimmed = raw.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }

    const current = stripBulletPrefix(raw);
    const previousIndex = out.length - 1;
    const hasPrevious = previousIndex >= 0 && out[previousIndex].trim().length > 0;

    if (hasPrevious) {
      const prevRaw = out[previousIndex];
      const prev = stripBulletPrefix(prevRaw);
      if (isContinuationFragment(current.content, prev.content)) {
        const merged = mergeLineContent(prev.content, current.content);
        out[previousIndex] = prev.prefix ? `${prev.prefix}${merged}` : merged;
        continue;
      }
    }

    out.push(current.prefix ? `${current.prefix}${current.content}` : trimmed);
  }

  return out.join("\n").trim();
}

export type StructuredExplanationParts = {
  coreExplanation: string;
  learningGoal: string;
  exampleBlock: string;
  supportNote: string;
};

function cleanHeadingPrefix(text: string): string {
  return String(text || "")
    .replace(/^\s*(core idea|learning goal|quick example|helper note|helpful note|support note)\s*:\s*/i, "")
    .trim();
}

export function parseStructuredExplanation(
  rawText: string,
  fallback?: Partial<StructuredExplanationParts>,
): StructuredExplanationParts {
  const raw = String(rawText || "");
  const text = repairBrokenFormulaBullets(raw);
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

    let matched = false;
    const candidates: Array<{
      key: keyof typeof sections;
      re: RegExp;
    }> = [
      { key: "core", re: /^\s*core idea\s*:?\s*(.*)$/i },
      { key: "goal", re: /^\s*learning goal\s*:?\s*(.*)$/i },
      { key: "example", re: /^\s*quick example\s*:?\s*(.*)$/i },
      { key: "note", re: /^\s*(?:help(?:er|ful)\s+note|support note)\s*:?\s*(.*)$/i },
    ];

    for (const c of candidates) {
      const m = trimmed.match(c.re);
      if (m) {
        current = c.key;
        const tail = String(m[1] || "").trim();
        if (tail) sections[current].push(tail);
        matched = true;
        break;
      }
    }

    if (!matched) {
      sections[current].push(trimmed);
    }
  }

  const coreFromText = sections.core.join("\n").trim();
  const goalFromText = sections.goal.join("\n").trim();
  const exampleFromText = sections.example.join("\n").trim();
  const noteFromText = sections.note.join("\n").trim();

  return {
    coreExplanation: cleanHeadingPrefix(coreFromText || fallback?.coreExplanation || raw),
    learningGoal: cleanHeadingPrefix(goalFromText || fallback?.learningGoal || ""),
    exampleBlock: cleanHeadingPrefix(exampleFromText || fallback?.exampleBlock || ""),
    supportNote: cleanHeadingPrefix(noteFromText || fallback?.supportNote || ""),
  };
}
