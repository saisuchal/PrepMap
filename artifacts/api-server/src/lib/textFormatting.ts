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

    if (current.prefix) {
      out.push(`${current.prefix}${current.content}`);
    } else {
      out.push(trimmed);
    }
  }

  return out.join("\n").trim();
}
