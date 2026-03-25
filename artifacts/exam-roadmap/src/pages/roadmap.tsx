import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Layers, BookOpen, FileText, MessageSquare,
  CheckCircle2, AlertCircle, ZoomIn, ZoomOut, Maximize2, X
} from "lucide-react";
import { useGetNodes, useGetSubtopicContent, useTrackEvent } from "@workspace/api-client-react";
import { buildTree, type TreeNode } from "@/lib/utils";
import { getStoredUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { EXAM_TYPES } from "@/lib/constants";

const NODE_COLORS = {
  unit: { bg: "bg-blue-500", border: "border-blue-400", light: "bg-blue-50 border-blue-200", text: "text-blue-700", line: "#3b82f6" },
  topic: { bg: "bg-violet-500", border: "border-violet-400", light: "bg-violet-50 border-violet-200", text: "text-violet-700", line: "#8b5cf6" },
  subtopic: { bg: "bg-emerald-500", border: "border-emerald-400", light: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", line: "#10b981" },
};

const NODE_W = 200;
const NODE_H = 52;
const H_GAP = 24;
const V_GAP = 80;

type LayoutNode = TreeNode & {
  x: number;
  y: number;
  w: number;
  h: number;
  layoutChildren: LayoutNode[];
};

function computeLayout(nodes: TreeNode[], depth: number = 0, xOffset: number = 0): { laid: LayoutNode[]; totalWidth: number } {
  if (nodes.length === 0) return { laid: [], totalWidth: 0 };

  const results: LayoutNode[] = [];
  let cursor = xOffset;

  for (const node of nodes) {
    const { laid: childLaid, totalWidth: childrenWidth } = computeLayout(node.children, depth + 1, cursor);
    const selfWidth = Math.max(NODE_W, childrenWidth);
    const x = cursor + selfWidth / 2 - NODE_W / 2;
    const y = depth * (NODE_H + V_GAP);

    results.push({
      ...node,
      x,
      y,
      w: NODE_W,
      h: NODE_H,
      layoutChildren: childLaid,
      children: node.children,
    });

    cursor += selfWidth + H_GAP;
  }

  const totalWidth = cursor - xOffset - (nodes.length > 0 ? H_GAP : 0);
  return { laid: results, totalWidth };
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
        x1: n.x + n.w / 2,
        y1: n.y + n.h,
        x2: child.x + child.w / 2,
        y2: child.y,
        color: NODE_COLORS[child.type as keyof typeof NODE_COLORS]?.line || "#94a3b8",
      });
    }
    lines.push(...getLines(n.layoutChildren));
  }
  return lines;
}

export default function Roadmap() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const configId = searchParams.get("configId");
  const subject = searchParams.get("subject") || "Roadmap";
  const examParam = searchParams.get("exam") || "";
  const examLabel = EXAM_TYPES.find(e => e.id === examParam)?.name || examParam;

  const { data: nodes, isLoading, isError } = useGetNodes({ configId: configId! }, {
    query: { enabled: !!configId }
  });

  const tree = useMemo(() => (nodes ? buildTree(nodes) : []), [nodes]);

  const { laid, totalWidth } = useMemo(() => computeLayout(tree), [tree]);
  const allNodes = useMemo(() => flattenLayout(laid), [laid]);
  const lines = useMemo(() => getLines(laid), [laid]);

  const maxDepth = useMemo(() => {
    let d = 0;
    for (const n of allNodes) {
      const nd = Math.round(n.y / (NODE_H + V_GAP));
      if (nd > d) d = nd;
    }
    return d;
  }, [allNodes]);

  const canvasW = totalWidth + 100;
  const canvasH = (maxDepth + 1) * (NODE_H + V_GAP) + 100;

  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNode = allNodes.find(n => n.id === selectedNodeId);

  useEffect(() => {
    if (containerRef.current && totalWidth > 0) {
      const containerW = containerRef.current.clientWidth;
      const containerH = containerRef.current.clientHeight;
      const scaleX = containerW / (canvasW + 60);
      const scaleY = containerH / (canvasH + 60);
      const fitZoom = Math.min(scaleX, scaleY, 1);
      setZoom(fitZoom);
      setPan({
        x: (containerW - canvasW * fitZoom) / 2,
        y: 30,
      });
    }
  }, [totalWidth, canvasW, canvasH]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-node]")) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    });
  }, [isDragging]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest("[data-node]")) return;
    const touch = e.touches[0];
    setIsDragging(true);
    dragStart.current = { x: touch.clientX, y: touch.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    setPan({
      x: dragStart.current.panX + (touch.clientX - dragStart.current.x),
      y: dragStart.current.panY + (touch.clientY - dragStart.current.y),
    });
  }, [isDragging]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(z => Math.max(0.2, Math.min(2, z * delta)));
  }, []);

  const resetView = useCallback(() => {
    if (containerRef.current && totalWidth > 0) {
      const containerW = containerRef.current.clientWidth;
      const containerH = containerRef.current.clientHeight;
      const scaleX = containerW / (canvasW + 60);
      const scaleY = containerH / (canvasH + 60);
      const fitZoom = Math.min(scaleX, scaleY, 1);
      setZoom(fitZoom);
      setPan({ x: (containerW - canvasW * fitZoom) / 2, y: 30 });
    }
  }, [totalWidth, canvasW, canvasH]);

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
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => setLocation("/home")}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-display font-bold text-foreground truncate flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary shrink-0" />
              {subject}
            </h1>
            {examLabel && <p className="text-xs text-muted-foreground truncate">{examLabel}</p>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setZoom(z => Math.min(2, z * 1.2))}>
            <ZoomIn className="w-3.5 h-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setZoom(z => Math.max(0.2, z / 1.2))}>
            <ZoomOut className="w-3.5 h-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={resetView}>
            <Maximize2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-hidden bg-[#f8fafc] relative select-none"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleMouseUp}
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
                const midY = (line.y1 + line.y2) / 2;
                return (
                  <path
                    key={i}
                    d={`M ${line.x1} ${line.y1} C ${line.x1} ${midY}, ${line.x2} ${midY}, ${line.x2} ${line.y2}`}
                    fill="none"
                    stroke={line.color}
                    strokeWidth={2}
                    strokeOpacity={0.5}
                  />
                );
              })}
            </svg>

            {allNodes.map(node => {
              const colors = NODE_COLORS[node.type as keyof typeof NODE_COLORS] || NODE_COLORS.topic;
              const isTracked = node.type === "subtopic" && sessionStorage.getItem(`tracked_${node.id}`);
              const isClickable = node.type === "topic" || node.type === "subtopic";

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
                  <span className={`text-xs font-semibold ${colors.text} truncate flex-1`}>
                    {node.title}
                  </span>
                  {isTracked && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AnimatePresence>
        {selectedNode && (
          <ContentModal
            node={selectedNode}
            configId={configId}
            examParam={examParam}
            onClose={() => setSelectedNodeId(null)}
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
  onClose,
}: {
  node: LayoutNode;
  configId: string;
  examParam: string;
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
  const observerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isSubtopic || !content || !user || isTracked) return;

    let timeoutId: NodeJS.Timeout;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        timeoutId = setTimeout(() => {
          if (!sessionStorage.getItem(`tracked_${node.id}`)) {
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
              }
            });
          }
        }, 2000);
      } else {
        clearTimeout(timeoutId);
      }
    }, { threshold: 0.5 });

    if (observerRef.current) observer.observe(observerRef.current);
    return () => { observer.disconnect(); clearTimeout(timeoutId); };
  }, [content, node.id, user, isTracked, isSubtopic, trackEventMutation, configId, examParam, node.parentId]);

  const twoMarkQuestions = content?.questions?.filter(q => q.markType === "2") || [];
  const fiveMarkQuestions = content?.questions?.filter(q => q.markType === "5") || [];
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
        className="relative bg-card rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[85vh] sm:max-h-[80vh] min-h-[50vh] sm:min-h-[40vh] flex flex-col shadow-2xl border border-border overflow-hidden"
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

        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
          {isTopic && (
            <div className="prose prose-sm sm:prose-base prose-slate max-w-none">
              {node.explanation ? (
                <div className="whitespace-pre-line text-foreground/80 leading-relaxed">{node.explanation}</div>
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
                      <div className="whitespace-pre-line text-foreground/80 leading-relaxed">{content.explanation}</div>
                    </div>
                  </section>

                  {(twoMarkQuestions.length > 0 || fiveMarkQuestions.length > 0) && (
                    <section className="space-y-4">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="w-4 h-4 text-primary" />
                        <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Questions & Answers</h3>
                      </div>

                      {twoMarkQuestions.map((q) => (
                        <QuestionCard key={q.id} label="2 Marks" question={q.question} answer={q.answer} />
                      ))}
                      {fiveMarkQuestions.map((q) => (
                        <QuestionCard key={q.id} label="5 Marks" question={q.question} answer={q.answer} />
                      ))}
                    </section>
                  )}

                  <div ref={observerRef} className="h-6 w-full flex items-center justify-center">
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
