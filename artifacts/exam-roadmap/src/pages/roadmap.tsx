import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Layers, BookOpen, FileText, MessageSquare,
  CheckCircle2, AlertCircle, ZoomIn, ZoomOut, Maximize2, X, List, Plus, Minus, Star
} from "lucide-react";
import { useGetAppMetadata, useGetConfigs, useGetNodes, useGetQuestionBank, useGetSubtopicContent, useTrackEvent } from "@/api-client";
import { buildTree, type TreeNode } from "@/lib/utils";
import { getStoredUser } from "@/lib/auth";
import { repairBrokenFormulaBullets } from "@/lib/text-format";
import { Button } from "@/components/ui/button";
import { EXAM_TYPES, SEMESTERS, UNIVERSITIES } from "@/lib/constants";

const NODE_COLORS = {
  unit: { bg: "bg-blue-500", border: "border-blue-400", light: "bg-blue-50 border-blue-200", text: "text-blue-700", line: "#3b82f6" },
  topic: { bg: "bg-violet-500", border: "border-violet-400", light: "bg-violet-50 border-violet-200", text: "text-violet-700", line: "#8b5cf6" },
  subtopic: { bg: "bg-emerald-500", border: "border-emerald-400", light: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", line: "#10b981" },
};

const NODE_W = 220;
const NODE_H = 64;
const NODE_W_TOPIC = 210;
const NODE_H_TOPIC = 58;
const NODE_W_SUBTOPIC = 190;
const NODE_H_SUBTOPIC = 52;
const V_GAP = 18;
const CANVAS_PAD = 48;
const TOPIC_GAP = 28;
const UNIT_GAP = 64;
const LAYOUT_W = 1400;
const QUESTION_BANK_LANE_H = 88;
const QUESTION_BANK_EVENT_PREFIX = "__qb__:";

function estimateSubtopicWidth(title: string, maxWidth: number): number {
  // Heuristic width estimate so longer titles can grow and use lane space.
  const desired = 140 + Math.min(title.length, 90) * 6;
  return Math.max(NODE_W_SUBTOPIC, Math.min(maxWidth, desired));
}

type AnswerSegment =
  | { type: "text"; value: string }
  | { type: "code"; language: string; code: string };

function parseAnswerSegments(answer: string): AnswerSegment[] {
  const src = String(answer || "");
  const regex = /```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
  const segments: AnswerSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(src)) !== null) {
    const before = src.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ type: "text", value: before.trim() });
    segments.push({
      type: "code",
      language: (match[1] || "text").toLowerCase(),
      code: match[2] || "",
    });
    lastIndex = regex.lastIndex;
  }

  const tail = src.slice(lastIndex);
  if (tail.trim()) segments.push({ type: "text", value: tail.trim() });

  if (segments.length === 0) {
    return [{ type: "text", value: src }];
  }
  return segments;
}

function hasCodeBlock(answer: string): boolean {
  return /```[\s\S]*?```/.test(String(answer || ""));
}

function isLikelyQuestionText(value: string): boolean {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return false;

  const informationalPatterns = [
    /^part\s*[-–]?\s*[abc]\b/i,
    /^answer\b/i,
    /^course outcomes?\b/i,
    /^knowledge level\b/i,
    /^time\b/i,
    /^marks?\b/i,
    /^q\.?\s*no\b/i,
    /^or$/i,
    /^k[1-6]\s*[-–]?\s*(remember|understand|apply|analy[sz]e|evaluate|create)\b/i,
  ];

  if (informationalPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  // Common Bloom's-level listing accidentally extracted as "questions".
  if (
    /k1\s*[-–]?\s*remember/i.test(text) &&
    /k2\s*[-–]?\s*understand/i.test(text)
  ) {
    return false;
  }

  if (/\?$/.test(text)) return true;

  return /^(what|why|how|when|which|who|whom|whose|define|explain|list|state|create|write|describe|compare|differentiate|demonstrate|show|give|mention|outline|derive|implement)\b/i.test(
    text
  );
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightCode(code: string, language: string): string {
  let html = escapeHtml(code);
  const protectedTokens = new Map<string, string>();
  const tokenChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const toToken = (idx: number) => {
    let n = idx;
    let out = "";
    do {
      out = tokenChars[n % tokenChars.length] + out;
      n = Math.floor(n / tokenChars.length) - 1;
    } while (n >= 0);
    return `¤${out}¤`;
  };
  let tokenIndex = 0;

  // Protect comments first so inner tokens are not re-highlighted.
  html = html.replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, (m) => {
    const token = toToken(tokenIndex++);
    protectedTokens.set(token, `<span class="text-slate-400">${m}</span>`);
    return token;
  });

  // Protect strings next for the same reason.
  html = html.replace(/("[^"\n]*"|'[^'\n]*'|`[^`\n]*`)/g, (m) => {
    const token = toToken(tokenIndex++);
    protectedTokens.set(token, `<span class="text-emerald-300">${m}</span>`);
    return token;
  });

  if (["js", "javascript", "ts", "typescript"].includes(language)) {
    html = html.replace(
      /\b(const|let|var|function|return|if|else|for|while|new|class|extends|import|from|export|async|await|try|catch|throw)\b/g,
      `<span class="text-sky-300">$1</span>`
    );
  } else if (["py", "python"].includes(language)) {
    html = html.replace(
      /\b(def|return|if|elif|else|for|while|import|from|as|class|try|except|finally|raise|with|lambda|pass)\b/g,
      `<span class="text-sky-300">$1</span>`
    );
  } else if (["sql"].includes(language)) {
    html = html.replace(
      /\b(SELECT|FROM|WHERE|GROUP|BY|ORDER|INSERT|INTO|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|AS|LIMIT|CREATE|TABLE)\b/gi,
      `<span class="text-sky-300">$1</span>`
    );
  }

  // Restore protected comments/strings after all other highlighting.
  for (const [token, value] of protectedTokens.entries()) {
    html = html.split(token).join(value);
  }
  return html;
}

function AnswerRenderer({ answer }: { answer: string }) {
  const segments = parseAnswerSegments(repairBrokenFormulaBullets(answer));
  return (
    <div className="space-y-3">
      {segments.map((seg, idx) => {
        if (seg.type === "text") {
          const raw = seg.value.trim();
          const hasLineBreaks = /\r?\n/.test(raw);
          const sentences = raw
            .split(/(?<=[.!?])\s+/)
            .map((s) => s.trim())
            .filter(Boolean);
          const numberedItemPattern = /(?:^|\s)(?:\d+[.)]|[ivxlcdm]+[.)])\s+/im;
          const bulletMarkerPattern = /(?:^|\n)\s*[-*•]\s+/m;
          const listCuePattern = /\b(steps?|advantages?|disadvantages?|differences?|types?|uses?|key points?|points?)\b/i;
          const listConnectorPattern = /\b(first|second|third|next|finally)\b/i;
          const explicitListSignals =
            numberedItemPattern.test(raw) ||
            bulletMarkerPattern.test(raw) ||
            (listCuePattern.test(raw) && (listConnectorPattern.test(raw) || raw.includes(":")));
          const shouldAutoBullet = !hasLineBreaks && explicitListSignals && sentences.length >= 2;
          const shouldAutoParagraph = !hasLineBreaks && !explicitListSignals && sentences.length >= 2 && raw.length > 80;

          if (shouldAutoBullet) {
            return (
              <ul key={`txt-${idx}`} className="space-y-1.5 pl-5 list-disc text-sm text-foreground/85 leading-relaxed">
                {sentences.map((line, lineIdx) => (
                  <li key={`txt-${idx}-${lineIdx}`}>{line}</li>
                ))}
              </ul>
            );
          }

          if (shouldAutoParagraph) {
            const paragraphs: string[] = [];
            for (let i = 0; i < sentences.length; i += 2) {
              paragraphs.push(sentences.slice(i, i + 2).join(" "));
            }
            return (
              <div key={`txt-${idx}`} className="space-y-2">
                {paragraphs.map((p, pIdx) => (
                  <p key={`txt-${idx}-${pIdx}`} className="text-sm text-foreground/85 leading-relaxed">
                    {p}
                  </p>
                ))}
              </div>
            );
          }

          return (
            <div
              key={`txt-${idx}`}
              className="text-sm text-foreground/85 whitespace-pre-line leading-relaxed"
            >
              {raw}
            </div>
          );
        }

        const languageLabel = (seg.language || "code").toUpperCase();
        return (
          <div key={`code-${idx}`} className="rounded-lg overflow-hidden border border-slate-700/70 bg-slate-950">
            <div className="px-3 py-1.5 text-[11px] font-semibold tracking-wide text-slate-300 bg-slate-900 border-b border-slate-700/70">
              {languageLabel}
            </div>
            <pre className="p-4 overflow-x-auto text-[13px] leading-6 font-mono text-slate-100">
              <code dangerouslySetInnerHTML={{ __html: highlightCode(seg.code, seg.language) }} />
            </pre>
          </div>
        );
      })}
    </div>
  );
}

type LayoutNode = TreeNode & {
  x: number;
  y: number;
  w: number;
  h: number;
  layoutChildren: LayoutNode[];
};

function computeLayout(units: TreeNode[]): { laid: LayoutNode[]; totalHeight: number; totalWidth: number } {
  if (units.length === 0) return { laid: [], totalHeight: 0, totalWidth: LAYOUT_W };

  const leftLaneWidth = (LAYOUT_W - CANVAS_PAD * 2) * 0.5;
  const rightLaneWidth = leftLaneWidth;
  const unitX = CANVAS_PAD + 24;
  const topicX = CANVAS_PAD + leftLaneWidth - NODE_W_TOPIC - 24;
  const subtopicX = CANVAS_PAD + leftLaneWidth + 24;
  const subtopicMaxW = rightLaneWidth - 48;

  const laidUnits: LayoutNode[] = [];
  let cursorY = CANVAS_PAD + QUESTION_BANK_LANE_H;
  let maxRight = 0;

  for (const unit of units) {
    const laidTopics: LayoutNode[] = [];
    const unitTopics = unit.children.filter((c) => c.type === "topic");

    const unitStartY = cursorY;

    if (unitTopics.length === 0) {
      laidUnits.push({
        ...unit,
        x: unitX,
        y: cursorY,
        w: NODE_W,
        h: NODE_H,
        layoutChildren: [],
        children: unit.children,
      });
      cursorY += NODE_H + UNIT_GAP;
      maxRight = Math.max(maxRight, unitX + NODE_W);
      continue;
    }

    for (const topic of unitTopics) {
      const subs = topic.children.filter((c) => c.type === "subtopic");
      const subBlockHeight =
        subs.length > 0
          ? subs.length * NODE_H_SUBTOPIC + (subs.length - 1) * V_GAP
          : NODE_H_TOPIC;

      const topicY = cursorY + (subBlockHeight - NODE_H_TOPIC) / 2;
      let subCursorY = cursorY;
      const laidSubs: LayoutNode[] = subs.map((sub) => {
        const subW = estimateSubtopicWidth(sub.title, subtopicMaxW);
        const laidSub: LayoutNode = {
          ...sub,
          x: subtopicX,
          y: subCursorY,
          w: subW,
          h: NODE_H_SUBTOPIC,
          layoutChildren: [],
          children: sub.children,
        };
        subCursorY += NODE_H_SUBTOPIC + V_GAP;
        return laidSub;
      });

      laidTopics.push({
        ...topic,
        x: topicX,
        y: topicY,
        w: NODE_W_TOPIC,
        h: NODE_H_TOPIC,
        layoutChildren: laidSubs,
        children: topic.children,
      });

      cursorY += subBlockHeight + TOPIC_GAP;
      maxRight = Math.max(maxRight, subtopicX + NODE_W_SUBTOPIC, topicX + NODE_W_TOPIC);
    }

    cursorY -= TOPIC_GAP;
    const unitBlockHeight = cursorY - unitStartY;
    const unitY = unitStartY + (unitBlockHeight - NODE_H) / 2;

    laidUnits.push({
      ...unit,
      x: unitX,
      y: unitY,
      w: NODE_W,
      h: NODE_H,
      layoutChildren: laidTopics,
      children: unit.children,
    });

    cursorY += UNIT_GAP;
    maxRight = Math.max(maxRight, unitX + NODE_W);
  }

  return {
    laid: laidUnits,
    totalHeight: cursorY + CANVAS_PAD,
    totalWidth: Math.max(LAYOUT_W, maxRight + CANVAS_PAD),
  };
}

function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  for (const n of nodes) {
    result.push(n);
    result.push(...flattenLayout(n.layoutChildren));
  }
  return result;
}

function getLines(nodes: LayoutNode[]): { x1: number; y1: number; x2: number; y2: number; color: string }[] {
  const lines: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];
  for (const n of nodes) {
    for (const child of n.layoutChildren) {
      lines.push({
        x1: n.x + n.w,
        y1: n.y + n.h / 2,
        x2: child.x,
        y2: child.y + child.h / 2,
        color: NODE_COLORS[child.type as keyof typeof NODE_COLORS]?.line || "#94a3b8",
      });
    }
    lines.push(...getLines(n.layoutChildren));
  }
  return lines;
}

function pruneTreeForCollapsedTopics(nodes: TreeNode[], collapsedTopicIds: Set<string>): TreeNode[] {
  return nodes.map((node) => {
    if (node.type === "topic" && collapsedTopicIds.has(node.id)) {
      return { ...node, children: [] };
    }
    if (node.children.length === 0) return node;
    return { ...node, children: pruneTreeForCollapsedTopics(node.children, collapsedTopicIds) };
  });
}

export default function Roadmap() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const configId = searchParams.get("configId");
  const subject = searchParams.get("subject") || "Roadmap";
  const examParam = searchParams.get("exam") || "";
  const { data: metadata } = useGetAppMetadata();
  const { data: configs } = useGetConfigs({}, { query: { enabled: !!configId } });
  const examTypes = metadata?.examTypes?.length ? metadata.examTypes : EXAM_TYPES;
  const universities = metadata?.universities?.length ? metadata.universities : UNIVERSITIES;
  const semesters = metadata?.semesters?.length ? metadata.semesters : SEMESTERS;
  const examLabel = examTypes.find(e => e.id === examParam)?.name || examParam;
  const activeConfig = useMemo(
    () => (configs ?? []).find((c) => c.id === configId),
    [configs, configId]
  );
  const universityLabel = activeConfig
    ? (universities.find((u) => u.id === activeConfig.universityId)?.name ?? activeConfig.universityId)
    : "";
  const semesterLabel = activeConfig
    ? (semesters.find((s) => s.id === activeConfig.year)?.name ?? activeConfig.year)
    : "";
  const branchLabel = activeConfig?.branch ?? "";
  const subtitleMeta = [universityLabel, branchLabel, semesterLabel, examLabel].filter(Boolean).join(" • ");

  const { data: nodes, isLoading, isError } = useGetNodes({ configId: configId! }, {
    query: { enabled: !!configId }
  });

  const tree = useMemo(() => (nodes ? buildTree(nodes) : []), [nodes]);
  const [collapsedTopicIds, setCollapsedTopicIds] = useState<Set<string>>(new Set());
  const collapseInitRef = useRef<string | null>(null);
  const allTopicIds = useMemo(() => {
    if (!nodes) return [] as string[];
    return nodes.filter((n) => n.type === "topic").map((n) => n.id);
  }, [nodes]);
  const topicChildCountById = useMemo(() => {
    const map = new Map<string, number>();
    if (!nodes) return map;
    const subtopicCounts = new Map<string, number>();
    for (const n of nodes) {
      if (n.type === "subtopic" && n.parentId) {
        subtopicCounts.set(n.parentId, (subtopicCounts.get(n.parentId) ?? 0) + 1);
      }
    }
    for (const n of nodes) {
      if (n.type === "topic") {
        map.set(n.id, subtopicCounts.get(n.id) ?? 0);
      }
    }
    return map;
  }, [nodes]);
  const mapTree = useMemo(
    () => pruneTreeForCollapsedTopics(tree, collapsedTopicIds),
    [tree, collapsedTopicIds]
  );

  const { laid, totalHeight, totalWidth } = useMemo(() => computeLayout(mapTree), [mapTree]);
  const allNodes = useMemo(() => flattenLayout(laid), [laid]);
  const lines = useMemo(() => getLines(laid), [laid]);

  const canvasW = useMemo(() => {
    const maxRight = allNodes.reduce((m, n) => Math.max(m, n.x + n.w), 0);
    return Math.max(totalWidth, maxRight + CANVAS_PAD);
  }, [allNodes, totalWidth]);
  const canvasH = Math.max(totalHeight + CANVAS_PAD * 2, 220);

  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isPinching, setIsPinching] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  );
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const pinchStart = useRef({ distance: 0, zoom: 1 });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [questionBankOpen, setQuestionBankOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "map">("map");
  const [completionVersion, setCompletionVersion] = useState(0);
  const selectedNode = allNodes.find(n => n.id === selectedNodeId);

  const completion = useMemo(() => {
    const doneSubtopics = new Set<string>();
    const subtopicsByTopic = new Map<string, string[]>();
    const topicsByUnit = new Map<string, string[]>();

    for (const n of nodes ?? []) {
      if (n.type === "subtopic") {
        if (sessionStorage.getItem(`tracked_${n.id}`)) doneSubtopics.add(n.id);
        if (n.parentId) {
          subtopicsByTopic.set(n.parentId, [...(subtopicsByTopic.get(n.parentId) ?? []), n.id]);
        }
      }
      if (n.type === "topic" && n.parentId) {
        topicsByUnit.set(n.parentId, [...(topicsByUnit.get(n.parentId) ?? []), n.id]);
      }
    }

    const doneTopics = new Set<string>();
    for (const [topicId, subIds] of subtopicsByTopic.entries()) {
      if (subIds.length > 0 && subIds.every((id) => doneSubtopics.has(id))) {
        doneTopics.add(topicId);
      }
    }

    const doneUnits = new Set<string>();
    for (const [unitId, topicIds] of topicsByUnit.entries()) {
      if (topicIds.length > 0 && topicIds.every((id) => doneTopics.has(id))) {
        doneUnits.add(unitId);
      }
    }

    return { doneSubtopics, doneTopics, doneUnits };
  }, [nodes, completionVersion]);

  const clampPan = useCallback((x: number, y: number, zoomValue: number) => {
    if (!containerRef.current) return { x, y };
    const containerW = containerRef.current.clientWidth;
    const containerH = containerRef.current.clientHeight;
    const scaledW = canvasW * zoomValue;
    const scaledH = canvasH * zoomValue;
    const margin = 24;

    let clampedX = x;
    let clampedY = y;

    if (scaledW <= containerW) {
      clampedX = (containerW - scaledW) / 2;
    } else {
      const minX = containerW - scaledW - margin;
      const maxX = margin;
      clampedX = Math.min(maxX, Math.max(minX, x));
    }

    if (scaledH <= containerH) {
      clampedY = (containerH - scaledH) / 2;
    } else {
      const minY = containerH - scaledH - margin;
      const maxY = margin;
      clampedY = Math.min(maxY, Math.max(minY, y));
    }

    return { x: clampedX, y: clampedY };
  }, [canvasW, canvasH]);

  useEffect(() => {
    if (selectedNodeId && !allNodes.some((n) => n.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, allNodes]);

  const toggleTopicCollapse = useCallback((topicId: string) => {
    setCollapsedTopicIds((prev) => {
      const next = new Set(prev);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  }, []);

  const collapseAllTopics = useCallback(() => {
    setCollapsedTopicIds(new Set(allTopicIds));
  }, [allTopicIds]);

  const expandAllTopics = useCallback(() => {
    setCollapsedTopicIds(new Set());
  }, []);

  const fitToWidth = useCallback(() => {
    if (!containerRef.current || allNodes.length === 0) return;
    const containerW = containerRef.current.clientWidth;
    const fitZoom = Math.max(0.2, Math.min(2, containerW / (canvasW + 32)));
    setZoom(fitZoom);
    setPan({
      x: (containerW - canvasW * fitZoom) / 2,
      y: 20,
    });
  }, [allNodes.length, canvasW]);

  const fitToViewport = useCallback(() => {
    if (!containerRef.current || allNodes.length === 0) return;
    const containerW = containerRef.current.clientWidth;
    const containerH = containerRef.current.clientHeight;
    const mobilePad = isMobileViewport ? 28 : 60;
    const scaleX = containerW / (canvasW + mobilePad);
    const scaleY = containerH / (canvasH + mobilePad);
    const fitZoom = Math.max(0.2, Math.min(1.6, Math.min(scaleX, scaleY)));
    setZoom(fitZoom);
    setPan({
      x: (containerW - canvasW * fitZoom) / 2,
      y: (containerH - canvasH * fitZoom) / 2,
    });
  }, [allNodes.length, canvasW, canvasH, isMobileViewport]);

  const getMinVisibleZoom = useCallback(() => {
    if (!containerRef.current || allNodes.length === 0) return 0.2;
    const containerW = containerRef.current.clientWidth;
    const containerH = containerRef.current.clientHeight;
    const scaleX = containerW / (canvasW + 60);
    const scaleY = containerH / (canvasH + 60);
    return Math.max(0.2, Math.min(1, Math.min(scaleX, scaleY)));
  }, [allNodes.length, canvasW, canvasH]);

  useEffect(() => {
    if (viewMode === "map") {
      if (isMobileViewport) fitToViewport();
      else fitToWidth();
    }
    // Intentionally exclude fitToWidth so expand/collapse layout updates
    // don't retrigger auto-fit and jump the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, configId, isMobileViewport, fitToViewport]);

  useEffect(() => {
    const onResize = () => setIsMobileViewport(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!configId) return;
    if (collapseInitRef.current === configId) return;
    if (allTopicIds.length === 0) return;
    setCollapsedTopicIds(new Set(allTopicIds));
    collapseInitRef.current = configId;
  }, [configId, allTopicIds]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-node]")) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan(
      clampPan(
        dragStart.current.panX + (e.clientX - dragStart.current.x),
        dragStart.current.panY + (e.clientY - dragStart.current.y),
        zoom
      )
    );
  }, [isDragging, clampPan, zoom]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest("[data-node]")) return;
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const dx = b.clientX - a.clientX;
      const dy = b.clientY - a.clientY;
      pinchStart.current = { distance: Math.hypot(dx, dy), zoom };
      setIsPinching(true);
      setIsDragging(false);
      return;
    }
    const touch = e.touches[0];
    setIsDragging(true);
    dragStart.current = { x: touch.clientX, y: touch.clientY, panX: pan.x, panY: pan.y };
  }, [pan, zoom]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (isPinching && e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const dx = b.clientX - a.clientX;
      const dy = b.clientY - a.clientY;
      const distance = Math.hypot(dx, dy);
      const ratio = pinchStart.current.distance > 0 ? distance / pinchStart.current.distance : 1;
      const minZoom = getMinVisibleZoom();
      const nextZoom = Math.max(minZoom, Math.min(2.2, pinchStart.current.zoom * ratio));
      setZoom(nextZoom);
      return;
    }

    if (!isDragging) return;
    const touch = e.touches[0];
    setPan(
      clampPan(
        dragStart.current.panX + (touch.clientX - dragStart.current.x),
        dragStart.current.panY + (touch.clientY - dragStart.current.y),
        zoom
      )
    );
  }, [isDragging, isPinching, clampPan, zoom, getMinVisibleZoom]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2 && isPinching) {
      setIsPinching(false);
    }
    if (e.touches.length === 0) {
      setIsDragging(false);
    }
  }, [isPinching]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    // Wheel only pans. Zoom is controlled via +/- buttons.
    setPan((prev) => clampPan(prev.x - e.deltaX, prev.y - e.deltaY, zoom));
  }, [clampPan, zoom]);

  const resetView = useCallback(() => {
    if (containerRef.current && allNodes.length > 0) {
      const containerW = containerRef.current.clientWidth;
      const containerH = containerRef.current.clientHeight;
      const scaleX = containerW / (canvasW + 60);
      const scaleY = containerH / (canvasH + 60);
      const fitZoom = Math.min(scaleX, scaleY, 1);
      setZoom(fitZoom);
      setPan({
        x: (containerW - canvasW * fitZoom) / 2,
        y: (containerH - canvasH * fitZoom) / 2,
      });
    }
  }, [allNodes.length, canvasW, canvasH]);

  const handleZoomOut = useCallback(() => {
    const minZoom = getMinVisibleZoom();
    const nextZoom = zoom / 1.2;
    if (nextZoom <= minZoom) {
      resetView();
      return;
    }
    setZoom(nextZoom);
  }, [zoom, getMinVisibleZoom, resetView]);

  useEffect(() => {
    setPan((prev) => {
      const clamped = clampPan(prev.x, prev.y, zoom);
      if (clamped.x === prev.x && clamped.y === prev.y) return prev;
      return clamped;
    });
  }, [zoom, canvasW, canvasH, clampPan]);

  if (!configId) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground mb-4">No configuration selected.</p>
        <Button onClick={() => setLocation("/home")}>Go Back</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="px-4 sm:px-6 py-3 border-b border-border bg-card shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setLocation("/home")}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-display font-bold text-foreground truncate flex items-center gap-2">
                <Layers className="w-5 h-5 text-primary shrink-0" />
                {subject}
              </h1>
              {subtitleMeta && <p className="text-xs text-muted-foreground truncate">{subtitleMeta}</p>}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant={viewMode === "list" ? "default" : "outline"}
              size="sm"
              className="h-8 px-3 gap-1.5"
              onClick={() => setViewMode("list")}
            >
              <List className="w-3.5 h-3.5" />
              List
            </Button>
            <Button
              variant={viewMode === "map" ? "default" : "outline"}
              size="sm"
              className="h-8 px-3 gap-1.5"
              onClick={() => setViewMode("map")}
            >
              <Layers className="w-3.5 h-3.5" />
              Map
            </Button>
          </div>
        </div>

        {viewMode === "map" && (
          <div className="hidden sm:flex items-center gap-1 mt-3">
            <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" onClick={expandAllTopics}>
              Expand all
            </Button>
            <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" onClick={collapseAllTopics}>
              Collapse topics
            </Button>
            <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" onClick={fitToWidth}>
              Fit width
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setZoom(z => Math.min(2, z * 1.2))}>
              <ZoomIn className="w-3.5 h-3.5" />
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleZoomOut}>
              <ZoomOut className="w-3.5 h-3.5" />
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={resetView}>
              <Maximize2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}
      </div>

      {viewMode === "list" ? (
        <div className="flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6">
          {isLoading ? (
            <div className="h-full flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div className="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                <p className="text-sm text-muted-foreground">Loading roadmap...</p>
              </div>
            </div>
          ) : isError ? (
            <div className="h-full flex items-center justify-center p-4">
              <div className="p-6 bg-destructive/10 text-destructive rounded-xl border border-destructive/20 text-center max-w-sm">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-60" />
                <p className="font-medium">Failed to load roadmap</p>
              </div>
            </div>
          ) : tree.length === 0 ? (
            <div className="h-full flex items-center justify-center p-4 text-center">
              <div>
                <Layers className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-20" />
                <p className="text-muted-foreground">No content available yet.</p>
              </div>
            </div>
          ) : (
            <div className="max-w-6xl mx-auto space-y-4">
              {tree.map((unit) => {
                const topicCount = unit.children.length;
                const subtopicCount = unit.children.reduce((acc, t) => acc + t.children.length, 0);
                return (
                  <section key={unit.id} className="bg-card border border-border rounded-2xl p-4 sm:p-5 shadow-sm">
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h2 className="text-base sm:text-lg font-semibold text-foreground">{unit.title}</h2>
                          {completion.doneUnits.has(unit.id) && (
                            <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {topicCount} topics | {subtopicCount} subtopics
                        </p>
                      </div>
                      <span className="text-[10px] sm:text-xs uppercase tracking-wider px-2 py-1 rounded-md bg-blue-50 text-blue-700 border border-blue-200">
                        Unit
                      </span>
                    </div>

                    <div className="space-y-3">
                      {unit.children.map((topic) => (
                        <div key={topic.id} className="rounded-xl border border-border bg-secondary/20 p-3">
                          <div className="flex items-center justify-between gap-3 mb-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <h3 className="text-sm font-semibold text-foreground">{topic.title}</h3>
                              {completion.doneTopics.has(topic.id) && (
                                <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                              )}
                            </div>
                            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md bg-violet-50 text-violet-700 border border-violet-200">
                              Topic
                            </span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {topic.children.map((sub) => {
                              const done = completion.doneSubtopics.has(sub.id);
                              return (
                                <button
                                  key={sub.id}
                                  type="button"
                                  onClick={() => setSelectedNodeId(sub.id)}
                                  className="text-left rounded-lg border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 transition-colors p-2.5"
                                >
                                  <div className="flex items-start gap-2">
                                    <FileText className="w-3.5 h-3.5 text-emerald-700 mt-0.5 shrink-0" />
                                    <span className="text-xs font-medium text-emerald-800 leading-snug flex-1 break-words">
                                      {sub.title}
                                    </span>
                                    {done && <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div
          ref={containerRef}
          className="flex-1 overflow-hidden bg-[#f8fafc] relative select-none"
          style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onWheel={handleWheel}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle,#e2e8f0_1px,transparent_1px)] bg-[length:24px_24px] opacity-50" />

          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div className="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                <p className="text-sm text-muted-foreground">Loading roadmap...</p>
              </div>
            </div>
          ) : isError ? (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="p-6 bg-destructive/10 text-destructive rounded-xl border border-destructive/20 text-center max-w-sm">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-60" />
                <p className="font-medium">Failed to load roadmap</p>
              </div>
            </div>
          ) : allNodes.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="text-center">
                <Layers className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-20" />
                <p className="text-muted-foreground">No content available yet.</p>
              </div>
            </div>
          ) : (
            <div
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "0 0",
                width: canvasW,
                height: canvasH,
                position: "relative",
              }}
            >
              <svg
                width={canvasW}
                height={canvasH}
                className="absolute inset-0 pointer-events-none"
              >
                {lines.map((line, i) => {
                  const elbow1 = line.x1 + 18;
                  const elbow2 = line.x2 - 18;
                  return (
                    <path
                      key={i}
                      d={`M ${line.x1} ${line.y1} L ${elbow1} ${line.y1} L ${elbow2} ${line.y2} L ${line.x2} ${line.y2}`}
                      fill="none"
                      stroke={line.color}
                      strokeWidth={1.8}
                      strokeOpacity={0.55}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  );
                })}
              </svg>

              {allNodes.map(node => {
                const colors = NODE_COLORS[node.type as keyof typeof NODE_COLORS] || NODE_COLORS.topic;
                const isDone =
                  node.type === "subtopic"
                    ? completion.doneSubtopics.has(node.id)
                    : node.type === "topic"
                      ? completion.doneTopics.has(node.id)
                      : completion.doneUnits.has(node.id);
                const isClickable = node.type === "topic" || node.type === "subtopic";
                const isTopic = node.type === "topic";
                const isCollapsed = isTopic && collapsedTopicIds.has(node.id);
                const subtopicCount = topicChildCountById.get(node.id) ?? 0;

                return (
                  <div
                    key={node.id}
                    data-node
                    className={`
                    absolute rounded-xl border-2 flex items-center gap-2 px-3 transition-all duration-150
                    ${colors.light}
                    ${isClickable ? 'cursor-pointer hover:shadow-lg hover:scale-105' : ''}
                    ${selectedNodeId === node.id ? 'ring-2 ring-primary ring-offset-2 shadow-lg' : 'shadow-sm'}
                  `}
                    style={{
                      left: node.x,
                      top: node.y,
                      width: node.w,
                      height: node.h,
                    }}
                    onClick={() => isClickable && setSelectedNodeId(node.id)}
                  >
                    <div className={`w-6 h-6 rounded-md ${colors.bg} flex items-center justify-center shrink-0`}>
                      {node.type === "unit" && <Layers className="w-3.5 h-3.5 text-white" />}
                      {node.type === "topic" && <BookOpen className="w-3.5 h-3.5 text-white" />}
                      {node.type === "subtopic" && <FileText className="w-3.5 h-3.5 text-white" />}
                    </div>
                    <span
                      className={`text-xs font-semibold ${colors.text} whitespace-normal break-words leading-tight flex-1 overflow-hidden`}
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {node.title}
                    </span>
                    {isTopic && subtopicCount > 0 && (
                      <button
                        type="button"
                        className="h-5 w-5 rounded-full border border-violet-300 bg-white/90 text-violet-700 flex items-center justify-center shrink-0 hover:bg-violet-50"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleTopicCollapse(node.id);
                        }}
                        title={isCollapsed ? "Expand subtopics" : "Collapse subtopics"}
                      >
                        {isCollapsed ? <Plus className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                      </button>
                    )}
                    {isDone && <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />}
                  </div>
                );
              })}

              <div
                data-node
                className="absolute rounded-xl border-2 flex items-center gap-2 px-3 transition-all duration-150 bg-blue-50 border-blue-300 cursor-pointer hover:shadow-lg hover:scale-105 shadow-sm"
                style={{
                  left: Math.max(CANVAS_PAD, canvasW / 2 - 110),
                  top: CANVAS_PAD,
                  width: 220,
                  height: 58,
                }}
                onClick={() => setQuestionBankOpen(true)}
              >
                <div className="w-6 h-6 rounded-md bg-blue-500 flex items-center justify-center shrink-0">
                  <MessageSquare className="w-3.5 h-3.5 text-white" />
                </div>
                <span className="text-xs font-semibold text-blue-700 whitespace-normal break-words leading-tight flex-1 overflow-hidden">
                  Question Bank
                </span>
              </div>
            </div>
          )}

          {viewMode === "map" && (
            <div className="sm:hidden absolute right-3 bottom-3 z-20 flex flex-col gap-2 rounded-xl border border-border/80 bg-card/95 backdrop-blur p-2 shadow-lg">
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={() => setZoom((z) => Math.min(2.2, z * 1.2))}
                title="Zoom in"
              >
                <ZoomIn className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={handleZoomOut}
                title="Zoom out"
              >
                <ZoomOut className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={resetView}
                title="Reset view"
              >
                <Maximize2 className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2 text-[10px]"
                onClick={fitToViewport}
                title="Fit map"
              >
                Fit
              </Button>
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {selectedNode && (
          <ContentModal
            node={selectedNode}
            configId={configId}
            examParam={examParam}
            onTracked={() => setCompletionVersion((v) => v + 1)}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {questionBankOpen && (
          <QuestionBankModal
            configId={configId}
            examParam={examParam}
            onClose={() => setQuestionBankOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ContentModal({
  node,
  configId,
  examParam,
  onTracked,
  onClose,
}: {
  node: LayoutNode;
  configId: string;
  examParam: string;
  onTracked?: () => void;
  onClose: () => void;
}) {
  const isTopic = node.type === "topic";
  const isSubtopic = node.type === "subtopic";

  const { data: content, isLoading } = useGetSubtopicContent(node.id, {
    query: { enabled: isSubtopic }
  });

  const user = getStoredUser();
  const trackEventMutation = useTrackEvent();
  const [isTracked, setIsTracked] = useState(!!sessionStorage.getItem(`tracked_${node.id}`));
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isSubtopic || !content || !user || (user.role !== "student" && user.role !== "super_student") || isTracked) return;
    const el = scrollRef.current;
    if (!el) return;
    let bottomTimer: ReturnType<typeof setTimeout> | null = null;

    const track = () => {
      if (sessionStorage.getItem(`tracked_${node.id}`)) return;
      trackEventMutation.mutate({
        data: {
          userId: user.id,
          universityId: user.universityId,
          year: user.year,
          branch: user.branch,
          exam: examParam,
          configId,
          topicId: node.parentId || "",
          subtopicId: node.id,
        }
      }, {
        onSuccess: () => {
          sessionStorage.setItem(`tracked_${node.id}`, "true");
          setIsTracked(true);
          onTracked?.();
        }
      });
    };

    const checkBottom = () => {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      if (atBottom) {
        if (!bottomTimer) {
          bottomTimer = setTimeout(() => {
            track();
            bottomTimer = null;
          }, 3000);
        }
      } else if (bottomTimer) {
        clearTimeout(bottomTimer);
        bottomTimer = null;
      }
    };

    el.addEventListener("scroll", checkBottom, { passive: true });
    // Handle short content where bottom is already visible.
    checkBottom();

    return () => {
      el.removeEventListener("scroll", checkBottom);
      if (bottomTimer) clearTimeout(bottomTimer);
    };
  }, [content, node.id, user, isTracked, isSubtopic, trackEventMutation, configId, examParam, node.parentId, onTracked]);

  const colors = NODE_COLORS[node.type as keyof typeof NODE_COLORS] || NODE_COLORS.topic;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <motion.div
        initial={{ opacity: 0, y: 40, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 40, scale: 0.97 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="relative bg-card rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl h-[92dvh] sm:h-auto max-h-[92dvh] sm:max-h-[80vh] min-h-[55vh] sm:min-h-[40vh] flex flex-col shadow-2xl border border-border overflow-hidden pb-[max(env(safe-area-inset-bottom),0.5rem)]"
      >
        <div className={`flex items-center justify-between px-5 sm:px-6 py-4 border-b border-border shrink-0 ${colors.light}`}>
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-8 h-8 rounded-lg ${colors.bg} flex items-center justify-center shrink-0`}>
              {isTopic ? <BookOpen className="w-4 h-4 text-white" /> : <FileText className="w-4 h-4 text-white" />}
            </div>
            <div className="min-w-0">
              <h2 className="font-display font-bold text-foreground truncate text-base sm:text-lg">{node.title}</h2>
              <p className="text-xs text-muted-foreground capitalize">{node.type}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isTracked && (
              <span className="text-xs font-semibold text-green-600 bg-green-50 px-2 py-1 rounded-full border border-green-200 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Done
              </span>
            )}
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
          {isTopic && (
            <div className="prose prose-sm sm:prose-base prose-slate max-w-none">
              {node.explanation ? (
                <AnswerRenderer answer={node.explanation} />
              ) : (
                <p className="text-muted-foreground italic">No explanation available for this topic.</p>
              )}
            </div>
          )}

          {isSubtopic && (
            <>
              {isLoading ? (
                <div className="space-y-4">
                  <div className="h-6 bg-muted animate-pulse rounded w-1/2" />
                  <div className="h-24 bg-muted animate-pulse rounded-xl" />
                  <div className="h-40 bg-muted animate-pulse rounded-xl" />
                </div>
              ) : content ? (
                <>
                  <section>
                    <div className="flex items-center gap-2 mb-3">
                      <BookOpen className="w-4 h-4 text-primary" />
                      <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Explanation</h3>
                    </div>
                    <div className="prose prose-sm prose-slate max-w-none bg-secondary/30 rounded-xl p-4 border border-border">
                      <AnswerRenderer answer={content.explanation} />
                    </div>
                  </section>

                  <div className="h-6 w-full flex items-center justify-center">
                    <div className="w-1/2 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
                  </div>
                </>
              ) : (
                <div className="text-center py-8">
                  <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-40" />
                  <p className="text-muted-foreground text-sm">Content not available.</p>
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function QuestionCard({ label, question, answer }: { label: string; question: string; answer: string }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="p-4 border-b border-border bg-secondary/20">
        <div className="flex items-start gap-2">
          <span className="shrink-0 px-2 py-0.5 rounded-md bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-wider">
            {label}
          </span>
          <p className="text-sm font-semibold text-foreground leading-snug">{question}</p>
        </div>
      </div>
      <div className="p-4">
        <div className="text-sm text-foreground/80 whitespace-pre-line leading-relaxed">{answer}</div>
      </div>
    </div>
  );
}

function QuestionBankModal({
  configId,
  examParam,
  onClose,
}: {
  configId: string;
  examParam: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useGetQuestionBank(configId);
  const validQuestions = useMemo(
    () => (data?.questions ?? []).filter((q) => isLikelyQuestionText(q.question)),
    [data?.questions]
  );
  const seededHash = useCallback((value: string) => {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }, []);

  const distributeStarred = useCallback(
    <T extends { id: number; isStarred?: boolean }>(items: T[]): T[] => {
      if (items.length <= 2) return items;

      const starred = items
        .filter((q) => !!q.isStarred)
        .slice()
        .sort((a, b) => seededHash(`${configId}:${a.id}`) - seededHash(`${configId}:${b.id}`));
      const nonStarred = items
        .filter((q) => !q.isStarred)
        .slice()
        .sort((a, b) => seededHash(`${configId}:${a.id}`) - seededHash(`${configId}:${b.id}`));

      if (starred.length === 0 || nonStarred.length === 0) {
        return [...items].sort(
          (a, b) => seededHash(`${configId}:${a.id}`) - seededHash(`${configId}:${b.id}`),
        );
      }

      const total = items.length;
      const out: T[] = new Array(total);
      const starredSlots = new Set<number>();
      for (let i = 0; i < starred.length; i++) {
        const slot = Math.min(total - 1, Math.floor(((i + 0.5) * total) / starred.length));
        let s = slot;
        while (starredSlots.has(s) && s < total - 1) s++;
        while (starredSlots.has(s) && s > 0) s--;
        starredSlots.add(s);
      }

      let si = 0;
      let ni = 0;
      for (let i = 0; i < total; i++) {
        if (starredSlots.has(i) && si < starred.length) {
          out[i] = starred[si++];
        } else if (ni < nonStarred.length) {
          out[i] = nonStarred[ni++];
        } else if (si < starred.length) {
          out[i] = starred[si++];
        }
      }
      return out.filter(Boolean);
    },
    [configId, seededHash],
  );

  const foundational = useMemo(
    () => distributeStarred(validQuestions.filter((q) => q.markType === "Foundational")),
    [validQuestions, distributeStarred],
  );
  const applied = useMemo(
    () => distributeStarred(validQuestions.filter((q) => q.markType === "Applied")),
    [validQuestions, distributeStarred],
  );
  const foundationalNumberById = useMemo(
    () => new Map(foundational.map((q, idx) => [q.id, idx + 1])),
    [foundational]
  );
  const appliedNumberById = useMemo(
    () => new Map(applied.map((q, idx) => [q.id, idx + 1])),
    [applied]
  );
  const [selectedQuestion, setSelectedQuestion] = useState<{
    id: number;
    number: number;
    label: string;
    starred: boolean;
    hasCodeBlock: boolean;
    question: string;
    context: string;
    answer: string;
    subtopicId: string;
  } | null>(null);
  const user = getStoredUser();
  const trackEventMutation = useTrackEvent();
  const answerTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const [questionInteractionVersion, setQuestionInteractionVersion] = useState(0);

  const questionSessionKey = useCallback(
    (questionId: number) => `tracked_qb_${configId}_${questionId}`,
    [configId]
  );

  const hasQuestionInteraction = useCallback(
    (questionId: number) => !!sessionStorage.getItem(questionSessionKey(questionId)),
    [questionSessionKey, questionInteractionVersion]
  );

  useEffect(() => {
    return () => {
      for (const timer of answerTimersRef.current.values()) {
        clearTimeout(timer);
      }
      answerTimersRef.current.clear();
    };
  }, []);

  const clearQuestionInteractionTrack = (questionId: number) => {
    const timer = answerTimersRef.current.get(questionId);
    if (timer) {
      clearTimeout(timer);
      answerTimersRef.current.delete(questionId);
    }
  };

  const scheduleQuestionInteractionTrack = (
    questionId: number,
    subtopicId: string,
    delayMs: number = 10000
  ) => {
    if (!user || (user.role !== "student" && user.role !== "super_student") || !subtopicId) return;
    const sessionKey = questionSessionKey(questionId);
    if (sessionStorage.getItem(sessionKey)) return;
    if (answerTimersRef.current.has(questionId)) return;

    const timer = setTimeout(() => {
      answerTimersRef.current.delete(questionId);
      if (sessionStorage.getItem(sessionKey)) return;

      trackEventMutation.mutate(
        {
          data: {
            userId: user.id,
            universityId: user.universityId,
            year: user.year,
            branch: user.branch,
            exam: examParam,
            configId,
            topicId: `${QUESTION_BANK_EVENT_PREFIX}${questionId}`,
            subtopicId,
          },
        },
        {
          onSuccess: () => {
            sessionStorage.setItem(sessionKey, "true");
            setQuestionInteractionVersion((v) => v + 1);
          },
        },
      );
    }, delayMs);

    answerTimersRef.current.set(questionId, timer);
  };

  useEffect(() => {
    if (!selectedQuestion) return;
    scheduleQuestionInteractionTrack(selectedQuestion.id, selectedQuestion.subtopicId, 5000);
    return () => {
      clearQuestionInteractionTrack(selectedQuestion.id);
    };
  }, [selectedQuestion]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <motion.div
        initial={{ opacity: 0, y: 40, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 40, scale: 0.97 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="relative bg-card rounded-t-2xl sm:rounded-2xl w-full sm:max-w-4xl h-[92dvh] sm:h-auto max-h-[92dvh] sm:max-h-[88vh] min-h-[55vh] flex flex-col shadow-2xl border border-border overflow-hidden pb-[max(env(safe-area-inset-bottom),0.5rem)]"
      >
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-border shrink-0 bg-blue-50">
          <div className="min-w-0">
            <h2 className="font-display font-bold text-foreground truncate text-base sm:text-lg flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-blue-600" />
              Question Bank
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              {data ? `${validQuestions.length} total questions` : "Loading questions..."}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
          {selectedQuestion ? (
            <section className="space-y-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => setSelectedQuestion(null)}
              >
                {"<- Back to Question List"}
              </Button>
              <div className="relative bg-card border border-blue-200 rounded-xl overflow-hidden shadow-sm">
                {selectedQuestion.hasCodeBlock && (
                  <div
                    className="absolute top-0 right-0 z-20 bg-rose-200 text-black text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-bl-md"
                    title="Contains code example"
                  >
                    Code
                  </div>
                )}
                <div className="p-4 border-b border-blue-100 bg-blue-50/60">
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[10px] font-bold uppercase tracking-wider">
                      Q{selectedQuestion.number}
                    </span>
                    <div className="shrink-0 flex flex-col items-start gap-1">
                      <span className="px-2 py-0.5 rounded-md bg-blue-100 text-blue-700 text-[10px] font-bold uppercase tracking-wider">
                        {selectedQuestion.label}
                      </span>
                      {hasQuestionInteraction(selectedQuestion.id) && (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase tracking-wider">
                          Interacted
                        </span>
                      )}
                    </div>
                    {selectedQuestion.starred && (
                      <Star
                        className="shrink-0 w-4 h-4 mt-0.5 text-amber-500 fill-amber-400"
                        aria-label="Starred question"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground leading-snug">{selectedQuestion.question}</p>
                      <p className="text-xs text-muted-foreground mt-1">{selectedQuestion.context}</p>
                    </div>
                  </div>
                </div>
                <div className="p-4">
                  <AnswerRenderer answer={selectedQuestion.answer} />
                </div>
              </div>
            </section>
          ) : (
          isLoading ? (
            <div className="space-y-4">
              <div className="h-6 bg-muted animate-pulse rounded w-1/3" />
              <div className="h-24 bg-muted animate-pulse rounded-xl" />
              <div className="h-24 bg-muted animate-pulse rounded-xl" />
            </div>
          ) : isError ? (
            <div className="text-center py-8">
              <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-40" />
              <p className="text-muted-foreground text-sm">Failed to load question bank.</p>
            </div>
          ) : validQuestions.length ? (
            <>
              {foundational.length > 0 && (
                <section className="space-y-3">
                  <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Foundational Questions</h3>
                  {foundational.map((q) => (
                    <QuestionBankCard
                      key={q.id}
                      onOpenDetail={() => {
                        setSelectedQuestion({
                          id: q.id,
                          number: foundationalNumberById.get(q.id) ?? 0,
                          label: "Foundational",
                          starred: !!q.isStarred,
                          hasCodeBlock: hasCodeBlock(q.answer),
                          question: q.question,
                          context: `${q.unitTitle} -> ${q.topicTitle} -> ${q.subtopicTitle}`,
                          answer: q.answer,
                          subtopicId: q.subtopicId,
                        });
                      }}
                      questionNumber={foundationalNumberById.get(q.id) ?? 0}
                      interacted={hasQuestionInteraction(q.id)}
                      label="Foundational"
                      starred={!!q.isStarred}
                      hasCodeBlock={hasCodeBlock(q.answer)}
                      question={q.question}
                      context={`${q.unitTitle} -> ${q.topicTitle} -> ${q.subtopicTitle}`}
                    />
                  ))}
                </section>
              )}

              {applied.length > 0 && (
                <section className="space-y-3">
                  <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Applied Questions</h3>
                  {applied.map((q) => (
                    <QuestionBankCard
                      key={q.id}
                      onOpenDetail={() => {
                        setSelectedQuestion({
                          id: q.id,
                          number: appliedNumberById.get(q.id) ?? 0,
                          label: "Applied",
                          starred: !!q.isStarred,
                          hasCodeBlock: hasCodeBlock(q.answer),
                          question: q.question,
                          context: `${q.unitTitle} -> ${q.topicTitle} -> ${q.subtopicTitle}`,
                          answer: q.answer,
                          subtopicId: q.subtopicId,
                        });
                      }}
                      questionNumber={appliedNumberById.get(q.id) ?? 0}
                      interacted={hasQuestionInteraction(q.id)}
                      label="Applied"
                      starred={!!q.isStarred}
                      hasCodeBlock={hasCodeBlock(q.answer)}
                      question={q.question}
                      context={`${q.unitTitle} -> ${q.topicTitle} -> ${q.subtopicTitle}`}
                    />
                  ))}
                </section>
              )}
            </>
          ) : (
            <div className="text-center py-8">
              <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-40" />
              <p className="text-muted-foreground text-sm">No questions generated yet for this roadmap.</p>
            </div>
          )
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function QuestionBankCard({
  questionNumber,
  interacted,
  label,
  starred,
  hasCodeBlock,
  question,
  context,
  onOpenDetail,
}: {
  questionNumber: number;
  interacted: boolean;
  label: string;
  starred?: boolean;
  hasCodeBlock?: boolean;
  question: string;
  context: string;
  onOpenDetail: () => void;
}) {
  return (
    <div className="relative bg-card border border-blue-200 rounded-xl overflow-hidden shadow-sm">
      {hasCodeBlock && (
        <div
          className="absolute top-0 right-0 z-20 bg-rose-200 text-black text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-bl-md"
          title="Contains code example"
        >
          Code
        </div>
      )}
      <div className="p-4 border-b border-blue-100 bg-blue-50/60">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            <span className="shrink-0 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[10px] font-bold uppercase tracking-wider">
              Q{questionNumber}
            </span>
            <div className="shrink-0 flex flex-col items-start gap-1">
              <span className="px-2 py-0.5 rounded-md bg-blue-100 text-blue-700 text-[10px] font-bold uppercase tracking-wider">
                {label}
              </span>
              {interacted && (
                <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase tracking-wider">
                  Interacted
                </span>
              )}
            </div>
            {starred && (
              <Star
                className="shrink-0 w-4 h-4 mt-0.5 text-amber-500 fill-amber-400"
                aria-label="Starred question"
              />
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground leading-snug">{question}</p>
              <p className="text-xs text-muted-foreground mt-1">{context}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs shrink-0 self-end"
            onClick={onOpenDetail}
            title="Open answer in focused view"
          >
            Show Answer
          </Button>
        </div>
      </div>
    </div>
  );
}




