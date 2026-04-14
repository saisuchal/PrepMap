import { useState, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import {
  useGetConfigs,
  useUploadConfigFiles,
  useTriggerGeneration,
  useGetGenerationStatus,
  useGetAppMetadata,
  usePublishConfig,
  useRequestUploadUrl,
  useGetNodes,
  useGetSubtopicContent,
  useUpdateSubtopicContent,
  useGetLibrarySubjects,
  useUpsertLibrarySubject,
  useGetLibraryUnits,
  useUpsertLibraryUnit,
  useUpdateLibraryUnit,
  useGetConfigUnitLinks,
  useSaveConfigUnitLinks,
  useExtractUnitsFromText,
  useGenerateCheapLaneA,
  useStartCheapLaneBImport,
  useGetCheapLaneBImportStatus,
} from "@/api-client";
import { UNIVERSITIES, EXAM_TYPES, SEMESTERS } from "@/lib/constants";
import {
  ArrowLeft, Upload, Sparkles, Globe, FileText, CheckCircle2,
  Clock, AlertCircle, Loader2, ChevronDown, ChevronRight,
  BookOpen, HelpCircle, Pencil, Save, Plus, Trash2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";

const ACCEPTED_FILE_TYPES = ".pdf,.png,.jpg,.jpeg,.webp,.txt,.md";
type UnitTopicInput = { title: string; subtopics: string[] };

function normalizeObjectPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("/objects/")) return trimmed;
  if (trimmed.startsWith("objects/")) return `/${trimmed}`;
  return trimmed;
}

function FileUploadSection({
  configId,
  hasFiles,
  paperUrls,
  onUploaded,
}: {
  configId: string;
  hasFiles: boolean;
  paperUrls: string[] | null | undefined;
  onUploaded: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [syllabusText, setSyllabusText] = useState("");
  const [syllabusFile, setSyllabusFile] = useState<File | null>(null);
  const [paperFile, setPaperFile] = useState<File | null>(null);
  const [replicaText, setReplicaText] = useState("");
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({});
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const requestUrl = useRequestUploadUrl();
  const uploadFiles = useUploadConfigFiles();
  const { toast } = useToast();

  const fileKey = (file: File) => `${file.name}_${file.size}_${file.lastModified}`;

  useEffect(() => {
    let cancelled = false;

    async function buildPreviews() {
      const entries = await Promise.all(
        [syllabusFile, paperFile].filter((file): file is File => !!file && file.type.startsWith("image/")).map(
          (file) =>
            new Promise<[string, string]>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve([fileKey(file), String(reader.result || "")]);
              reader.onerror = () => resolve([fileKey(file), ""]);
              reader.readAsDataURL(file);
            })
        )
      );

      if (!cancelled) {
        setImagePreviews(Object.fromEntries(entries.filter(([, src]) => !!src)));
      }
    }

    if (!paperFile && !syllabusFile) {
      setImagePreviews({});
      return () => {
        cancelled = true;
      };
    }

    buildPreviews();
    return () => {
      cancelled = true;
    };
  }, [paperFile, syllabusFile]);

  const uploadSingleFile = async (file: File): Promise<string> => {
    const contentType = file.type || "application/octet-stream";
    const uploadResult = await requestUrl.mutateAsync({
      data: { name: file.name, size: file.size, contentType },
    });
    const uploadInfo = (
      uploadResult &&
      typeof uploadResult === "object" &&
      "data" in uploadResult &&
      (uploadResult as { data?: { uploadURL?: string; objectPath?: string } }).data
    )
      ? (uploadResult as { data: { uploadURL: string; objectPath: string } }).data
      : (uploadResult as { uploadURL?: string; objectPath?: string });

    if (!uploadInfo?.uploadURL || !uploadInfo?.objectPath) {
      throw new Error("Upload URL response is invalid. Check API upload endpoint configuration.");
    }

    const isSupabaseSignedUpload = uploadInfo.uploadURL.includes("/storage/v1/object/upload/sign/");
    const uploadResponse = await fetch(uploadInfo.uploadURL, {
      method: "PUT",
      body: file,
      headers: {
        "Content-Type": contentType,
        ...(isSupabaseSignedUpload ? { "x-upsert": "true" } : {}),
      },
    });
    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload ${file.name} (${uploadResponse.status})`);
    }
    return uploadInfo.objectPath;
  };

  const handleUpload = async () => {
    const trimmedSyllabus = syllabusText.trim();
    if (!trimmedSyllabus && !syllabusFile) return;
    const trimmedReplicaText = replicaText.trim();
    if (syllabusFile && trimmedSyllabus) {
      toast({
        title: "Choose one syllabus input",
        description: "Use either syllabus file or pasted syllabus text, not both.",
        variant: "destructive",
      });
      return;
    }
    if (paperFile && trimmedReplicaText) {
      toast({
        title: "Choose one replica input",
        description: "Use either replica file or pasted replica text, not both.",
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const syllabusPath = syllabusFile
        ? await uploadSingleFile(syllabusFile)
        : await uploadSingleFile(
            new File([new Blob([trimmedSyllabus], { type: "text/plain" })], "syllabus.txt", { type: "text/plain" })
          );
      let paperPaths: string[] = [];
      if (paperFile) {
        paperPaths = [await uploadSingleFile(paperFile)];
      } else if (trimmedReplicaText) {
        const replicaBlob = new Blob([trimmedReplicaText], { type: "text/plain" });
        const replicaFile = new File([replicaBlob], "replica-paper.txt", { type: "text/plain" });
        paperPaths = [await uploadSingleFile(replicaFile)];
      }

      await uploadFiles.mutateAsync({
        id: configId,
        data: {
          syllabusFileUrl: normalizeObjectPath(syllabusPath),
          paperFileUrls: paperPaths.map((p) => normalizeObjectPath(p)),
        },
      });
      setSyllabusText("");
      setSyllabusFile(null);
      setPaperFile(null);
      setReplicaText("");
      onUploaded();
      toast({
        title: "Content uploaded",
        description: hasFiles
          ? "Existing content was replaced. Run Generate Content to refresh roadmap and question bank."
          : "Syllabus text and replica paper saved successfully.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
      toast({ title: "Upload failed", description: message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border p-6">
      <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
        <Upload className="w-5 h-5 text-primary" />
        Files
      </h3>

      {hasFiles && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-xl text-sm text-green-700 dark:text-green-400 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <div>
            Syllabus uploaded
            {paperUrls && paperUrls.length > 0 && ` + ${paperUrls.length} paper(s)`}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border p-4 bg-secondary/10 space-y-3">
            <p className="text-sm font-semibold text-foreground">Syllabus Input</p>
            <Textarea
              value={syllabusText}
              onChange={(e) => setSyllabusText(e.target.value)}
              rows={8}
              placeholder="Paste full syllabus text..."
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">{syllabusText.trim().length} characters</p>
            <label className="inline-flex items-center gap-2 border border-border rounded-lg px-3 py-2 cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-all">
              <input
                type="file"
                accept={ACCEPTED_FILE_TYPES}
                className="hidden"
                onChange={(e) => {
                  const next = e.target.files?.[0] ?? null;
                  setSyllabusFile(next);
                }}
              />
              <FileText className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {syllabusFile ? "Change syllabus file" : "Choose syllabus file"}
              </span>
            </label>
            <p className="text-xs text-muted-foreground">Image, PDF, or text file.</p>
            <p className="text-xs text-foreground">
              Using: {syllabusFile ? `File - ${syllabusFile.name}` : syllabusText.trim() ? "Pasted text" : "Not set"}
            </p>
            {syllabusFile && (
              <div className="rounded-lg border border-border p-2 bg-background">
                {(() => {
                  const key = fileKey(syllabusFile);
                  const previewSrc = imagePreviews[key];
                  return previewSrc ? (
                    <button type="button" className="w-full" onClick={() => setPreviewImage({ src: previewSrc, name: syllabusFile.name })}>
                      <img src={previewSrc} alt={syllabusFile.name} className="w-full h-28 object-cover rounded-md border border-border" />
                      <p className="text-[11px] text-primary mt-1">Click for larger preview</p>
                    </button>
                  ) : (
                    <p className="text-xs text-muted-foreground">{syllabusFile.name}</p>
                  );
                })()}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border p-4 bg-secondary/10 space-y-3">
            <p className="text-sm font-semibold text-foreground">Replica Input</p>
            <Textarea
              value={replicaText}
              onChange={(e) => setReplicaText(e.target.value)}
              rows={8}
              placeholder="Paste replica/sample paper text..."
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">{replicaText.trim().length} characters</p>
            <label className="inline-flex items-center gap-2 border border-border rounded-lg px-3 py-2 cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-all">
              <input
                type="file"
                accept={ACCEPTED_FILE_TYPES}
                className="hidden"
                onChange={(e) => {
                  const next = e.target.files?.[0] ?? null;
                  setPaperFile(next);
                }}
              />
              <FileText className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {paperFile ? "Change replica file" : "Choose replica file"}
              </span>
            </label>
            <p className="text-xs text-muted-foreground">Image, PDF, or text file. New upload overrides old replica.</p>
            <p className="text-xs text-foreground">
              Using: {paperFile ? `File - ${paperFile.name}` : replicaText.trim() ? "Pasted text" : "Not set (optional)"}
            </p>
            {paperFile && (
              <div className="rounded-lg border border-border p-2 bg-background">
                {(() => {
                  const key = fileKey(paperFile);
                  const previewSrc = imagePreviews[key];
                  return previewSrc ? (
                    <button type="button" className="w-full" onClick={() => setPreviewImage({ src: previewSrc, name: paperFile.name })}>
                      <img src={previewSrc} alt={paperFile.name} className="w-full h-28 object-cover rounded-md border border-border" />
                      <p className="text-[11px] text-primary mt-1">Click for larger preview</p>
                    </button>
                  ) : (
                    <p className="text-xs text-muted-foreground">{paperFile.name}</p>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        <Button onClick={handleUpload} disabled={(!syllabusText.trim() && !syllabusFile) || uploading} className="w-full gap-2">
          {uploading ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Uploading...</>
          ) : (
            <><Upload className="w-4 h-4" /> {hasFiles ? "Replace Content" : "Upload Content"}</>
          )}
        </Button>
      </div>

      {previewImage && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="bg-card rounded-xl p-3 max-w-4xl w-full border border-border"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium truncate">{previewImage.name}</p>
              <Button variant="ghost" size="sm" onClick={() => setPreviewImage(null)}>
                Close
              </Button>
            </div>
            <img
              src={previewImage.src}
              alt={previewImage.name}
              className="w-full max-h-[75vh] object-contain rounded-md border border-border bg-background"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function GenerationSection({
  configId,
  hasFiles,
}: {
  configId: string;
  hasFiles: boolean;
}) {
  const [polling, setPolling] = useState(false);
  const triggerGen = useTriggerGeneration();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: status, refetch: refetchStatus } = useGetGenerationStatus(configId, {
    query: {
      refetchInterval: polling ? 3000 : false,
    },
  });

  useEffect(() => {
    if (status?.status === "generating" || status?.status === "parsing") {
      setPolling(true);
    } else {
      setPolling(false);
    }
  }, [status?.status]);

  useEffect(() => {
    if (status?.status === "complete") {
      queryClient.invalidateQueries({ queryKey: ["/api/nodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/configs"] });
    }
  }, [status?.status, queryClient]);

  const handleGenerate = () => {
    triggerGen.mutate({ id: configId }, {
      onSuccess: () => {
        setPolling(true);
        refetchStatus();
        toast({ title: "Generation started", description: "AI is generating content. This may take a few minutes." });
      },
      onError: () => {
        toast({ title: "Generation failed", description: "Could not start content generation.", variant: "destructive" });
      },
    });
  };

  const isActive = status?.status === "generating" || status?.status === "parsing";
  const progressPct = status?.total && status.total > 0 ? (status.progress / status.total) * 100 : 0;

  return (
    <div className="bg-card rounded-2xl border border-border p-6">
      <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
        <Sparkles className="w-5 h-5 text-primary" />
        AI Generation
      </h3>

      {status?.status === "complete" && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-xl text-sm text-green-700 dark:text-green-400 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          Content generated successfully
        </div>
      )}

      {status?.status === "error" && (
        <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-xl text-sm text-destructive flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Generation failed</p>
            {status.error && <p className="text-xs mt-1 opacity-80">{status.error}</p>}
          </div>
        </div>
      )}

      {isActive && (
        <div className="mb-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{status?.currentStep}</span>
            <span className="font-medium text-foreground">
              {status?.progress}/{status?.total}
            </span>
          </div>
          <Progress value={progressPct} className="h-2" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            Generating content... this may take a few minutes
          </div>
        </div>
      )}

      <Button
        onClick={handleGenerate}
        disabled={!hasFiles || isActive || triggerGen.isPending}
        className="w-full gap-2"
        variant={status?.status === "complete" ? "outline" : "default"}
      >
        {isActive ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> Generating...</>
        ) : status?.status === "complete" ? (
          <><Sparkles className="w-4 h-4" /> Regenerate Content</>
        ) : (
          <><Sparkles className="w-4 h-4" /> Generate Content</>
        )}
      </Button>

      {!hasFiles && (
        <p className="text-xs text-muted-foreground text-center mt-2">Upload files first before generating</p>
      )}
    </div>
  );
}

function PublishSection({
  configId,
  status,
  hasContent,
  onPublished,
}: {
  configId: string;
  status: string;
  hasContent: boolean;
  onPublished: () => void;
}) {
  const publishConfig = usePublishConfig();
  const { toast } = useToast();

  const isLive = status === "live";

  const handleToggle = () => {
    publishConfig.mutate({ id: configId }, {
      onSuccess: () => {
        onPublished();
        toast({
          title: isLive ? "Unpublished" : "Published",
          description: isLive
            ? "Config is now a draft and hidden from students."
            : "Config is now live and visible to students.",
        });
      },
      onError: () => {
        toast({
          title: isLive ? "Unpublish failed" : "Publish failed",
          description: "Could not update config status.",
          variant: "destructive",
        });
      },
    });
  };

  return (
    <div className="bg-card rounded-2xl border border-border p-6">
      <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
        <Globe className="w-5 h-5 text-primary" />
        Publish
      </h3>

      <div className="flex items-center gap-3 mb-4">
        <Badge variant={isLive ? "default" : "secondary"} className="text-sm px-3 py-1">
          {isLive ? (
            <><CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Live</>
          ) : (
            <><Clock className="w-3.5 h-3.5 mr-1.5" /> Draft</>
          )}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {isLive ? "Visible to students" : "Not visible to students"}
        </span>
      </div>

      {isLive ? (
        <Button
          onClick={handleToggle}
          disabled={publishConfig.isPending}
          variant="outline"
          className="w-full gap-2 text-destructive hover:text-destructive"
        >
          {publishConfig.isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Unpublishing...</>
          ) : (
            <><Clock className="w-4 h-4" /> Unpublish (Revert to Draft)</>
          )}
        </Button>
      ) : (
        <>
          <Button
            onClick={handleToggle}
            disabled={!hasContent || publishConfig.isPending}
            className="w-full gap-2"
          >
            {publishConfig.isPending ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Publishing...</>
            ) : (
              <><Globe className="w-4 h-4" /> Publish to Students</>
            )}
          </Button>
          {!hasContent && (
            <p className="text-xs text-muted-foreground text-center mt-2">Generate content first before publishing</p>
          )}
        </>
      )}
    </div>
  );
}

interface EditableQuestion {
  id: number | null;
  markType: "Foundational" | "Applied";
  question: string;
  answer: string;
  isStarred?: boolean;
  starSource?: "none" | "auto" | "manual";
}

function CheapGenerationSection({ configId }: { configId: string }) {
  const [masterPrompt, setMasterPrompt] = useState("");
  const [laneBJson, setLaneBJson] = useState("");
  const [laneAStructure, setLaneAStructure] = useState<Array<{
    title: string;
    topics: Array<{ title: string; subtopics: string[] }>;
  }>>([]);
  const [laneAReplicaQuestions, setLaneAReplicaQuestions] = useState<Array<{
    markType: "Foundational" | "Applied";
    question: string;
    answer: string;
    unitTitle: string;
    topicTitle: string;
    subtopicTitle: string;
    isStarred: boolean;
  }>>([]);
  const [laneAWarnings, setLaneAWarnings] = useState<string[]>([]);
  const [laneAReplicaExtraction, setLaneAReplicaExtraction] = useState<{
    hasReplicaFile: boolean;
    extractedPaperTextLength: number;
    extractionMethod: "model" | "heuristic" | "none";
  } | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [laneAResult, setLaneAResult] = useState<{
    totalQuestionTarget: number;
    totalStarTarget: number;
    remainingQuestionsNeeded: number;
    remainingStarsNeeded: number;
  } | null>(null);
  const generateLaneA = useGenerateCheapLaneA();
  const startImportLaneB = useStartCheapLaneBImport();
  const [importPolling, setImportPolling] = useState(false);
  const [expectedImportQuestionCount, setExpectedImportQuestionCount] = useState(0);
  const { data: importStatus } = useGetCheapLaneBImportStatus(configId, {
    query: {
      refetchInterval: importPolling ? 1000 : false,
    },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleCopyPrompt = async () => {
    if (!masterPrompt.trim()) return;
    try {
      await navigator.clipboard.writeText(masterPrompt);
      toast({ title: "Copied", description: "Master prompt copied to clipboard." });
    } catch {
      toast({ title: "Copy failed", description: "Could not copy prompt.", variant: "destructive" });
    }
  };

  const handleDownloadPrompt = () => {
    if (!masterPrompt.trim()) return;
    const blob = new Blob([masterPrompt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cheap-lane-a-${configId}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleValidateLaneB = () => {
    try {
      const parsed = JSON.parse(laneBJson);
      const units = Array.isArray((parsed as any)?.units) ? (parsed as any).units.length : 0;
      const questions = Array.isArray((parsed as any)?.questions) ? (parsed as any).questions : [];
      const questionCount = questions.length;
      const starCount = questions.filter((q: any) => !!q?.isStarred).length;
      const mandatoryKeys = new Set(laneAReplicaQuestions.map((q) => normalizeText(q.question)));
      const presentMandatory = questions.filter((q: any) => mandatoryKeys.has(normalizeText(String(q?.question || "")))).length;
      const expectedQuestions = laneAResult?.totalQuestionTarget ?? null;
      const expectedStars = laneAResult?.totalStarTarget ?? null;
      const expectedMandatory = laneAReplicaQuestions.length;

      const issues: string[] = [];
      if (expectedQuestions != null && questionCount !== expectedQuestions) {
        issues.push(`questions ${questionCount}/${expectedQuestions}`);
      }
      if (expectedStars != null && starCount !== expectedStars) {
        issues.push(`stars ${starCount}/${expectedStars}`);
      }
      if (presentMandatory < expectedMandatory) {
        issues.push(`mandatory replica ${presentMandatory}/${expectedMandatory}`);
      }

      if (issues.length > 0) {
        toast({
          title: "JSON valid but checks failed",
          description: issues.join(" | "),
          variant: "destructive",
        });
      } else {
        toast({
          title: "JSON valid",
          description: `Found ${units} unit(s), ${questionCount} question(s), ${starCount} starred, mandatory ${presentMandatory}/${expectedMandatory}.`,
        });
      }
    } catch {
      toast({ title: "Invalid JSON", description: "Please fix JSON syntax before import.", variant: "destructive" });
    }
  };

  const handleLaneA = () => {
    generateLaneA.mutate(
      { configId },
      {
        onSuccess: (data) => {
          setMasterPrompt(data.masterPrompt);
          setLaneAStructure(data.structure);
          setLaneAReplicaQuestions(data.replicaQuestions);
          setLaneAWarnings(data.warnings || []);
          setLaneAReplicaExtraction(data.replicaExtraction || null);
          setImportWarnings([]);
          setLaneAResult({
            totalQuestionTarget: data.totalQuestionTarget,
            totalStarTarget: data.totalStarTarget,
            remainingQuestionsNeeded: data.remainingQuestionsNeeded,
            remainingStarsNeeded: data.remainingStarsNeeded,
          });
          toast({ title: "Lane A ready", description: "Master prompt package generated. Use it for external bulk generation." });
        },
        onError: (error) => {
          toast({
            title: "Lane A failed",
            description: error instanceof Error ? error.message : "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleLaneBImport = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(laneBJson);
    } catch {
      toast({ title: "Invalid JSON", description: "Lane B input must be valid JSON.", variant: "destructive" });
      return;
    }

    const parsedQuestions = Array.isArray((parsed as any)?.questions) ? (parsed as any).questions.length : 0;
    setExpectedImportQuestionCount(parsedQuestions);

    startImportLaneB.mutate(
      { configId, payload: parsed as any },
      {
        onSuccess: () => {
          setImportPolling(true);
          setImportWarnings([]);
          toast({
            title: "Import started",
            description: "Saving content in stages. Please wait...",
          });
        },
        onError: (error) => {
          toast({
            title: "Lane B import failed",
            description: error instanceof Error ? error.message : "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  useEffect(() => {
    if (!importStatus) return;
    if (importStatus.status === "complete") {
      setImportPolling(false);
      setExpectedImportQuestionCount(0);
      queryClient.invalidateQueries({ queryKey: ["/api/nodes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/configs"] });
      setImportWarnings(importStatus.warnings || []);
      const savedQuestions = importStatus.saved?.questions ?? 0;
      const warningCount = (importStatus.warnings || []).length;
      toast({
        title: "Lane B imported",
        description: warningCount > 0
          ? `${savedQuestions} questions saved with ${warningCount} warning(s).`
          : `${savedQuestions} questions saved successfully.`,
      });
      return;
    }

    if (importStatus.status === "error") {
      setImportPolling(false);
      setExpectedImportQuestionCount(0);
      toast({
        title: "Lane B import failed",
        description: importStatus.error || "Please try again.",
        variant: "destructive",
      });
    }
  }, [importStatus, queryClient, toast]);

  useEffect(() => {
    if (importStatus?.status === "processing") {
      setImportPolling(true);
    }
  }, [importStatus?.status]);

  return (
    <div className="bg-card rounded-2xl border border-border p-6 space-y-4">
      <h3 className="text-lg font-semibold flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-primary" />
        Cheap Mode Generation
      </h3>

      <div className="rounded-xl border border-border p-4 bg-secondary/10 space-y-3">
        <p className="text-sm font-semibold text-foreground">Generation Lane A (Portal)</p>
        <p className="text-xs text-muted-foreground">
          Extracts structure + replica mandatory/starred questions and prepares a master prompt for external bulk generation.
        </p>
        <Button onClick={handleLaneA} disabled={generateLaneA.isPending} className="gap-2">
          {generateLaneA.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          Generate Lane A Package
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={handleCopyPrompt} disabled={!masterPrompt.trim()} className="h-8 text-xs">
            Copy Prompt
          </Button>
          <Button type="button" variant="outline" onClick={handleDownloadPrompt} disabled={!masterPrompt.trim()} className="h-8 text-xs">
            Download Prompt
          </Button>
        </div>
        {laneAResult && (
          <p className="text-xs text-foreground">
            Target: {laneAResult.totalQuestionTarget} questions, {laneAResult.totalStarTarget} starred.
            Remaining after replica: {laneAResult.remainingQuestionsNeeded} questions, {laneAResult.remainingStarsNeeded} stars.
          </p>
        )}
        {laneAReplicaExtraction && (
          <div className="rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
            <p>
              Replica status: {laneAReplicaExtraction.hasReplicaFile ? "file attached" : "no replica file"}
              {" | "}Extracted text: {laneAReplicaExtraction.extractedPaperTextLength} chars
              {" | "}Method: {laneAReplicaExtraction.extractionMethod}
            </p>
          </div>
        )}
        {laneAWarnings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-semibold mb-1">Lane A Warnings</p>
            <ul className="list-disc pl-4 space-y-1">
              {laneAWarnings.map((w, i) => (
                <li key={`${w}-${i}`}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <Textarea
          rows={10}
          value={masterPrompt}
          onChange={(e) => setMasterPrompt(e.target.value)}
          placeholder="Lane A master prompt will appear here..."
          className="text-sm"
        />
      </div>

      <div className="rounded-xl border border-border p-4 bg-secondary/10 space-y-3">
        <p className="text-sm font-semibold text-foreground">Generation Lane B (External to Portal)</p>
        <p className="text-xs text-muted-foreground">
          Paste externally generated JSON (editable) and import. Auto-fix/warnings will be applied before save.
        </p>
        <Textarea
          rows={14}
          value={laneBJson}
          onChange={(e) => setLaneBJson(e.target.value)}
          placeholder='Paste JSON with {"units":[...],"questions":[...]}'
          className="text-sm font-mono"
        />
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={handleValidateLaneB} disabled={!laneBJson.trim()} className="h-8 text-xs">
            Validate JSON
          </Button>
        </div>
        <Button
          onClick={handleLaneBImport}
          disabled={!laneBJson.trim() || startImportLaneB.isPending || importStatus?.status === "processing"}
          className="gap-2"
        >
          {(startImportLaneB.isPending || importPolling) ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Import Lane B Content
        </Button>
        {importStatus?.status === "processing" && (
          <div className="rounded-lg border border-border bg-background p-3 space-y-2">
            {(() => {
              const effectiveTotal = importStatus.totalQuestions > 0
                ? importStatus.totalQuestions
                : expectedImportQuestionCount;
              const effectiveProcessed = importStatus.totalQuestions > 0
                ? importStatus.processedQuestions
                : 0;
              const progressValue = effectiveTotal > 0
                ? (effectiveProcessed / effectiveTotal) * 100
                : 5;
              return (
                <>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{importStatus.message}</span>
              <span className="font-medium text-foreground">
                {effectiveProcessed}/{effectiveTotal || 0}
              </span>
            </div>
            <Progress
              value={progressValue}
              className="h-2"
            />
            <p className="text-[11px] text-muted-foreground capitalize">
              Stage: {importStatus.stage.replace("_", " ")}
            </p>
            {effectiveTotal > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Batch {Math.max(1, Math.ceil(effectiveProcessed / 10))}/
                {Math.ceil(effectiveTotal / 10)} (10 questions per batch)
              </p>
            )}
                </>
              );
            })()}
          </div>
        )}
        {importWarnings.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-semibold mb-1">Auto-fix Warnings</p>
            <ul className="list-disc pl-4 space-y-1">
              {importWarnings.map((w, i) => (
                <li key={`${w}-${i}`}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function ReusableUnitLibrarySection({ configId, subjectName }: { configId: string; subjectName: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: subjects, isLoading: subjectsLoading } = useGetLibrarySubjects();
  const upsertSubject = useUpsertLibrarySubject();
  const normalizedSubject = normalizeText(subjectName);
  const subject = subjects?.find((s) => s.normalizedName === normalizedSubject) ?? null;

  const { data: units, isLoading: unitsLoading } = useGetLibraryUnits(subject?.id ?? null);
  const upsertUnit = useUpsertLibraryUnit();
  const updateUnit = useUpdateLibraryUnit();
  const { data: configUnitLinks } = useGetConfigUnitLinks(configId);
  const saveConfigUnitLinks = useSaveConfigUnitLinks();
  const extractUnits = useExtractUnitsFromText();

  const [selectedUnitId, setSelectedUnitId] = useState<string>("");
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [unitTitle, setUnitTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [topicsText, setTopicsText] = useState("");
  const [readingMaterials, setReadingMaterials] = useState<Array<{ id: string; title: string; text: string }>>([
    { id: "rm-1", title: "", text: "" },
  ]);

  const hasCompleteStructure = (topics: UnitTopicInput[]) =>
    Array.isArray(topics) &&
    topics.length > 0 &&
    topics.every((t) => t.title.trim().length > 0 && Array.isArray(t.subtopics) && t.subtopics.length > 0);

  const reusableUnits = (units ?? []).filter((u) =>
    hasCompleteStructure((u.topics as UnitTopicInput[] | null | undefined) ?? [])
  );

  useEffect(() => {
    if (!selectedUnitId || !units) return;
    const existing = units.find((u) => u.id === selectedUnitId);
    if (!existing) return;
    setUnitTitle(existing.unitTitle);
    setSourceText(existing.sourceText ?? "");
    setTopicsText(
      (existing.topics ?? [])
        .map((t) => `${t.title}: ${t.subtopics.join(", ")}`)
        .join("\n")
    );
  }, [selectedUnitId, units]);

  useEffect(() => {
    if (!configUnitLinks) return;
    setSelectedUnitIds(configUnitLinks.unitIds ?? []);
  }, [configUnitLinks]);

  useEffect(() => {
    const allowed = new Set(reusableUnits.map((u) => u.id));
    setSelectedUnitIds((prev) => prev.filter((id) => allowed.has(id)));
  }, [units]);

  const ensureSubject = () => {
    upsertSubject.mutate(
      { name: subjectName },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["library-subjects"] });
          toast({ title: "Subject ready", description: "Subject was added to reusable library." });
        },
        onError: (error) => {
          toast({
            title: "Failed to add subject",
            description: error instanceof Error ? error.message : "Please try again.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const parseTopics = () => {
    const topics = topicsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(":");
        if (idx === -1) {
          return { title: line, subtopics: [] as string[] };
        }
        const title = line.slice(0, idx).trim();
        const subtopics = line
          .slice(idx + 1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return { title, subtopics };
      })
      .filter((t) => t.title.length > 0);
    return topics;
  };

  const handleSave = () => {
    if (!subject?.id) return;
    if (!unitTitle.trim()) {
      toast({ title: "Unit title required", description: "Please add a unit title.", variant: "destructive" });
      return;
    }
    const topics = parseTopics();
    if (topics.length === 0) {
      toast({ title: "Topics required", description: "Add at least one topic line.", variant: "destructive" });
      return;
    }

    const onSuccess = () => {
      queryClient.invalidateQueries({ queryKey: ["library-units", subject.id] });
      setSelectedUnitId("");
      setUnitTitle("");
      setSourceText("");
      setTopicsText("");
      toast({ title: "Unit saved", description: "Reusable unit library updated." });
    };

    const onError = (error: unknown) => {
      toast({
        title: "Save failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    };

    if (selectedUnitId) {
      updateUnit.mutate(
        { unitId: selectedUnitId, unitTitle: unitTitle.trim(), topics, sourceText: sourceText.trim() || null },
        { onSuccess, onError }
      );
      return;
    }

    upsertUnit.mutate(
      { subjectId: subject.id, unitTitle: unitTitle.trim(), topics, sourceText: sourceText.trim() || null },
      { onSuccess, onError }
    );
  };

  const saving = upsertUnit.isPending || updateUnit.isPending;
  const savingConfigLinks = saveConfigUnitLinks.isPending;
  const extracting = extractUnits.isPending;

  const toggleUnitSelection = (unitId: string, checked: boolean) => {
    setSelectedUnitIds((prev) => {
      if (checked) {
        if (prev.includes(unitId)) return prev;
        return [...prev, unitId];
      }
      return prev.filter((id) => id !== unitId);
    });
  };

  const saveSelectedUnits = () => {
    saveConfigUnitLinks.mutate(
      { configId, unitIds: selectedUnitIds },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["library-config-unit-links", configId] });
          toast({ title: "Selected units saved", description: "Generation will use these reusable units for this config." });
        },
        onError: (error) => {
          toast({
            title: "Failed to save selected units",
            description: error instanceof Error ? error.message : "Please try again.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const handleExtractFromText = () => {
    if (!subject?.id) return;
    const validMaterials = readingMaterials
      .map((m) => ({ ...m, title: m.title.trim(), text: m.text.trim() }))
      .filter((m) => m.text.length > 0);

    if (validMaterials.length === 0) {
      toast({ title: "Paste reading material", description: "Add at least one reading material before extracting.", variant: "destructive" });
      return;
    }

    const mergedReadingText = validMaterials
      .map((material, idx) => {
        const header = material.title
          ? `Reading Material ${idx + 1}: ${material.title}`
          : `Reading Material ${idx + 1}`;
        return `${header}\n${material.text}`;
      })
      .join("\n\n-----\n\n");

    extractUnits.mutate(
      { subjectId: subject.id, readingText: mergedReadingText },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: ["library-units", subject.id] });
          toast({
            title: "Units extracted",
            description: `Processed ${validMaterials.length} material(s). Extracted/upserted ${data.extractedCount} unit(s) to library.`,
          });
        },
        onError: (error) => {
          toast({
            title: "Extraction failed",
            description: error instanceof Error ? error.message : "Please try again.",
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <div className="bg-card rounded-2xl border border-border p-6 mt-8">
      <h3 className="text-lg font-semibold flex items-center gap-2 mb-2">
        <BookOpen className="w-5 h-5 text-primary" />
        Reusable Unit Library
      </h3>
      <p className="text-sm text-muted-foreground mb-4">
        Subject: <span className="font-medium text-foreground">{subjectName}</span>
      </p>

      {subjectsLoading ? (
        <p className="text-sm text-muted-foreground">Loading library...</p>
      ) : !subject ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This subject is not in global library yet.
          </p>
          <Button onClick={ensureSubject} disabled={upsertSubject.isPending} className="gap-2">
            {upsertSubject.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add Subject To Library
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-border p-3 bg-secondary/20">
            <p className="text-xs font-semibold text-foreground mb-2">Units Selected For This Config</p>
            {reusableUnits.length === 0 ? (
              <p className="text-xs text-muted-foreground">No fully structured reusable units yet for this subject.</p>
            ) : (
              <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                {reusableUnits.map((u) => (
                  <label key={u.id} className="flex items-start gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedUnitIds.includes(u.id)}
                      onChange={(e) => toggleUnitSelection(u.id, e.target.checked)}
                    />
                    <span>{u.unitTitle}</span>
                  </label>
                ))}
              </div>
            )}
            <Button onClick={saveSelectedUnits} disabled={savingConfigLinks} className="mt-3 h-8 text-xs gap-1.5">
              {savingConfigLinks ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Reuse These Units
            </Button>
          </div>

          <Accordion type="multiple" className="space-y-3">
            <AccordionItem value="extract-materials" className="rounded-xl border border-border bg-secondary/10 px-3">
              <AccordionTrigger className="text-xs font-semibold text-foreground py-3">
                Extract Units From Reading Materials
              </AccordionTrigger>
              <AccordionContent className="space-y-2 pb-3">
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      setReadingMaterials((prev) => [
                        ...prev,
                        { id: `rm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: "", text: "" },
                      ])
                    }
                    className="h-7 text-xs gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Material
                  </Button>
                </div>
                <div className="space-y-3">
                  {readingMaterials.map((material, index) => (
                    <div key={material.id} className="rounded-lg border border-border bg-background p-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-foreground">Material {index + 1}</p>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground"
                          disabled={readingMaterials.length === 1}
                          onClick={() =>
                            setReadingMaterials((prev) => prev.filter((m) => m.id !== material.id))
                          }
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      <Input
                        value={material.title}
                        onChange={(e) =>
                          setReadingMaterials((prev) =>
                            prev.map((m) => (m.id === material.id ? { ...m, title: e.target.value } : m))
                          )
                        }
                        placeholder="Optional title (e.g. Unit 2 Part A)"
                        className="h-8 text-xs"
                      />
                      <Textarea
                        rows={4}
                        value={material.text}
                        onChange={(e) =>
                          setReadingMaterials((prev) =>
                            prev.map((m) => (m.id === material.id ? { ...m, text: e.target.value } : m))
                          )
                        }
                        placeholder="Paste reading material text..."
                        className="text-sm"
                      />
                    </div>
                  ))}
                </div>
                <Button onClick={handleExtractFromText} disabled={extracting} className="h-8 text-xs gap-1.5">
                  {extracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  Extract And Save Units (All Materials)
                </Button>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="edit-existing-units" className="rounded-xl border border-border bg-secondary/10 px-3">
              <AccordionTrigger className="text-xs font-semibold text-foreground py-3">
                Edit Existing Units
              </AccordionTrigger>
              <AccordionContent className="space-y-3 pb-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Existing Units</label>
                  <Select value={selectedUnitId || undefined} onValueChange={setSelectedUnitId}>
                    <SelectTrigger className="h-10">
                      <SelectValue placeholder={unitsLoading ? "Loading units..." : "Select a unit to edit or start new"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(units ?? []).map((u) => (
                        <SelectItem key={u.id} value={u.id}>{u.unitTitle}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedUnitId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-1 h-7 text-xs"
                      onClick={() => {
                        setSelectedUnitId("");
                        setUnitTitle("");
                        setSourceText("");
                        setTopicsText("");
                      }}
                    >
                      Switch to New Unit
                    </Button>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Unit Title</label>
                  <Input
                    value={unitTitle}
                    onChange={(e) => setUnitTitle(e.target.value)}
                    placeholder="e.g. Unit 2 Part A: React Fundamentals"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Topics And Subtopics
                  </label>
                  <Textarea
                    rows={8}
                    value={topicsText}
                    onChange={(e) => setTopicsText(e.target.value)}
                    placeholder={"Format per line:\nTopic 1: Subtopic A, Subtopic B\nTopic 2: Subtopic C, Subtopic D"}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Reading Material Text</label>
                  <Textarea
                    rows={4}
                    value={sourceText}
                    onChange={(e) => setSourceText(e.target.value)}
                    placeholder="Paste source reading material text for future reference..."
                  />
                </div>

                <Button onClick={handleSave} disabled={saving} className="gap-2">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {selectedUnitId ? "Update Unit" : "Save Unit"}
                </Button>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}
    </div>
  );
}

function SubtopicEditor({ nodeId }: { nodeId: string }) {
  const { data, isLoading, refetch } = useGetSubtopicContent(nodeId);
  const updateContent = useUpdateSubtopicContent();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [questions, setQuestions] = useState<EditableQuestion[]>([]);

  useEffect(() => {
    if (data) {
      setExplanation(data.explanation);
      setQuestions(
        data.questions.map((q) => ({
          id: q.id,
          markType: q.markType as "Foundational" | "Applied",
          question: q.question,
          answer: q.answer,
          isStarred: q.isStarred ?? false,
          starSource: q.starSource ?? "none",
        }))
      );
    }
  }, [data]);

  if (isLoading) {
    return <div className="p-4 animate-pulse text-sm text-muted-foreground">Loading content...</div>;
  }

  if (!data) return null;

  const handleSave = () => {
    updateContent.mutate(
      {
        id: nodeId,
        data: {
          explanation,
          questions: questions.map((q) => ({
            id: q.id,
            markType: q.markType,
            question: q.question,
            answer: q.answer,
            isStarred: q.isStarred ?? false,
            starSource: q.starSource ?? "none",
          })),
        },
      },
      {
        onSuccess: () => {
          setEditing(false);
          refetch();
          toast({ title: "Content saved", description: "Subtopic content updated successfully." });
        },
        onError: () => {
          toast({ title: "Save failed", description: "Could not save content changes.", variant: "destructive" });
        },
      }
    );
  };

  const addQuestion = () => {
    setQuestions([
      ...questions,
      { id: null, markType: "Foundational", question: "", answer: "", isStarred: false, starSource: "none" },
    ]);
  };

  const removeQuestion = (index: number) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const updateQuestion = (
    index: number,
    field: "markType" | "question" | "answer",
    value: string
  ) => {
    setQuestions(questions.map((q, i) => (i === index ? { ...q, [field]: value } : q)));
  };

  if (!editing) {
    return (
      <div className="space-y-4 p-4 bg-secondary/30 rounded-xl">
        <div className="flex items-center justify-between">
          <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5" /> Explanation
          </h5>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} className="gap-1.5 h-7 text-xs">
            <Pencil className="w-3 h-3" /> Edit
          </Button>
        </div>
        <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{data.explanation}</p>
        {data.questions.length > 0 && (
          <div>
            <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5" /> Questions ({data.questions.length})
            </h5>
            <div className="space-y-3">
              {data.questions.map((q) => (
                <div key={q.id} className="bg-card rounded-lg p-3 border border-border">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-xs">{q.markType}</Badge>
                    {q.isStarred && (
                      <Badge variant="secondary" className="text-xs">★ {q.starSource === "auto" ? "Auto" : "Manual"}</Badge>
                    )}
                  </div>
                  <p className="text-sm font-medium text-foreground mb-1">{q.question}</p>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{q.answer}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 bg-primary/5 border border-primary/20 rounded-xl">
      <div className="flex items-center justify-between">
        <h5 className="text-xs font-semibold text-primary uppercase tracking-wider flex items-center gap-1.5">
          <Pencil className="w-3.5 h-3.5" /> Editing
        </h5>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)} className="h-7 text-xs">
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={updateContent.isPending} className="gap-1.5 h-7 text-xs">
            {updateContent.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Save
          </Button>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-foreground mb-1">Explanation</label>
        <Textarea
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          rows={6}
          className="text-sm"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium text-foreground">Questions</label>
          <Button variant="outline" size="sm" onClick={addQuestion} className="gap-1.5 h-7 text-xs">
            <Plus className="w-3 h-3" /> Add Question
          </Button>
        </div>
        <div className="space-y-3">
          {questions.map((q, idx) => (
            <div key={idx} className="bg-card rounded-lg p-3 border border-border space-y-2">
              <div className="flex items-center justify-between">
                <Select value={q.markType} onValueChange={(v) => updateQuestion(idx, "markType", v)}>
                  <SelectTrigger className="w-28 h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Foundational">Foundational</SelectItem>
                    <SelectItem value="Applied">Applied</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="sm" onClick={() => removeQuestion(idx)} className="h-7 w-7 p-0 text-destructive hover:text-destructive">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={!!q.isStarred}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setQuestions(questions.map((item, i) => (
                      i === idx
                        ? { ...item, isStarred: checked, starSource: checked ? "manual" : "none" }
                        : item
                    )));
                  }}
                />
                Star this question
              </label>
              <Input
                value={q.question}
                onChange={(e) => updateQuestion(idx, "question", e.target.value)}
                placeholder="Question"
                className="text-sm"
              />
              <Textarea
                value={q.answer}
                onChange={(e) => updateQuestion(idx, "answer", e.target.value)}
                placeholder="Answer"
                rows={3}
                className="text-sm"
              />
            </div>
          ))}
          {questions.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">No questions yet. Click "Add Question" above.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ContentReviewSection({ configId }: { configId: string }) {
  const { data: nodes, isLoading } = useGetNodes({ configId });
  const [expandedSubtopic, setExpandedSubtopic] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="bg-card rounded-2xl border border-border p-6">
        <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
          <BookOpen className="w-5 h-5 text-primary" />
          Generated Content
        </h3>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 bg-muted animate-pulse rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!nodes || nodes.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border p-6">
        <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
          <BookOpen className="w-5 h-5 text-primary" />
          Generated Content
        </h3>
        <p className="text-sm text-muted-foreground text-center py-8">
          No content generated yet. Upload files and run generation first.
        </p>
      </div>
    );
  }

  const units = nodes.filter((n) => n.type === "unit");
  const topics = nodes.filter((n) => n.type === "topic");
  const subtopics = nodes.filter((n) => n.type === "subtopic");

  return (
    <div className="bg-card rounded-2xl border border-border p-6">
      <h3 className="text-lg font-semibold flex items-center gap-2 mb-2">
        <BookOpen className="w-5 h-5 text-primary" />
        Generated Content
      </h3>
      <p className="text-sm text-muted-foreground mb-4">
        {units.length} units, {topics.length} topics, {subtopics.length} subtopics
        <span className="text-xs ml-2">(click a subtopic to view and edit)</span>
      </p>

      <Accordion type="multiple" className="space-y-2">
        {units
          .sort((a, b) => (a.sortOrder ?? "").localeCompare(b.sortOrder ?? ""))
          .map((unit) => {
            const unitTopics = topics
              .filter((t) => t.parentId === unit.id)
              .sort((a, b) => (a.sortOrder ?? "").localeCompare(b.sortOrder ?? ""));

            return (
              <AccordionItem key={unit.id} value={unit.id} className="border border-border rounded-xl overflow-hidden">
                <AccordionTrigger className="px-4 py-3 hover:bg-muted/50 text-sm font-semibold">
                  {unit.title}
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4">
                  <div className="space-y-2">
                    {unitTopics.map((topic) => {
                      const topicSubtopics = subtopics
                        .filter((s) => s.parentId === topic.id)
                        .sort((a, b) => (a.sortOrder ?? "").localeCompare(b.sortOrder ?? ""));

                      return (
                        <div key={topic.id} className="ml-2">
                          <p className="text-sm font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                            <ChevronRight className="w-3.5 h-3.5 text-primary" />
                            {topic.title}
                          </p>
                          <div className="ml-5 space-y-1">
                            {topicSubtopics.map((sub) => (
                              <div key={sub.id}>
                                <button
                                  onClick={() => setExpandedSubtopic(expandedSubtopic === sub.id ? null : sub.id)}
                                  className="w-full text-left text-sm text-muted-foreground hover:text-foreground py-1.5 px-2 rounded-lg hover:bg-muted/50 transition-colors flex items-center justify-between group"
                                >
                                  <span className="flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-primary/40 group-hover:bg-primary transition-colors" />
                                    {sub.title}
                                  </span>
                                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expandedSubtopic === sub.id ? "rotate-180" : ""}`} />
                                </button>
                                <AnimatePresence>
                                  {expandedSubtopic === sub.id && (
                                    <motion.div
                                      initial={{ height: 0, opacity: 0 }}
                                      animate={{ height: "auto", opacity: 1 }}
                                      exit={{ height: 0, opacity: 0 }}
                                      className="overflow-hidden"
                                    >
                                      <SubtopicEditor nodeId={sub.id} />
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
      </Accordion>
    </div>
  );
}

export default function ConfigDetail() {
  const [, params] = useRoute("/admin/config/:id");
  const [, setLocation] = useLocation();
  const configId = params?.id ?? "";

  const { data: configs, isLoading: configsLoading, refetch } = useGetConfigs(
    {},
    { query: { queryKey: ["configs", "all"] } }
  );
  const { data: metadata } = useGetAppMetadata();
  const universities = metadata?.universities?.length ? metadata.universities : UNIVERSITIES;
  const semesters = metadata?.semesters?.length ? metadata.semesters : SEMESTERS;
  const examTypes = metadata?.examTypes?.length ? metadata.examTypes : EXAM_TYPES;
  const uniLabel = (id: string) => universities.find((u) => u.id === id)?.name ?? id;
  const semesterLabel = (id: string) => semesters.find((s) => s.id === id)?.name ?? id;
  const examLabel = (id: string) => examTypes.find((e) => e.id === id)?.name ?? id;
  const config = configs?.find((c) => c.id === configId);
  const { data: genStatus } = useGetGenerationStatus(configId);
  const { data: publishNodes } = useGetNodes({ configId });
  const [generationMode, setGenerationMode] = useState<"expensive" | "cheap">("expensive");

  const hasFiles = !!config?.syllabusFileUrl;
  const hasContent = genStatus?.status === "complete" || (publishNodes?.length ?? 0) > 0;

  if (configsLoading) {
    return (
      <div className="w-full max-w-4xl mx-auto pt-4 pb-20 px-4 sm:px-6 lg:px-8">
        <Button variant="ghost" onClick={() => setLocation("/admin")} className="gap-2 mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to Dashboard
        </Button>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="w-full max-w-4xl mx-auto pt-4 pb-20 px-4 sm:px-6 lg:px-8">
        <Button variant="ghost" onClick={() => setLocation("/admin")} className="gap-2 mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to Dashboard
        </Button>
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <AlertCircle className="w-12 h-12 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold text-foreground mb-1">Config not found</h2>
          <p className="text-muted-foreground text-sm">This config may be disabled or doesn't exist.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl mx-auto pt-4 pb-20">
      <Button variant="ghost" onClick={() => setLocation("/admin")} className="gap-2 mb-6">
        <ArrowLeft className="w-4 h-4" /> Back to Dashboard
      </Button>

      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Badge variant={config.status === "live" ? "default" : "secondary"}>
            {config.status === "live" ? "Live" : "Draft"}
          </Badge>
          <span className="text-xs text-muted-foreground">ID: {config.id}</span>
        </div>
        <h1 className="text-2xl font-display font-bold text-foreground">{config.subject}</h1>
        <p className="text-muted-foreground mt-1">
          {uniLabel(config.universityId)} &middot; {config.branch} &middot; {semesterLabel(config.year)} &middot; {examLabel(config.exam)}
        </p>
      </div>

      <div className="mb-6 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <p className="text-sm font-semibold text-foreground mb-3">Setup Flow</p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
          <div className="rounded-lg border border-border bg-background px-3 py-2">
            <p className="font-medium text-foreground">1. Reuse Units</p>
            <p className="text-muted-foreground mt-0.5">Pick existing units or extract new ones.</p>
          </div>
          <div className="rounded-lg border border-border bg-background px-3 py-2">
            <p className="font-medium text-foreground">2. Add Inputs</p>
            <p className="text-muted-foreground mt-0.5">{hasFiles ? "Content uploaded" : "Upload syllabus + optional replica."}</p>
          </div>
          <div className="rounded-lg border border-border bg-background px-3 py-2">
            <p className="font-medium text-foreground">3. Generate</p>
            <p className="text-muted-foreground mt-0.5">
              {generationMode === "expensive"
                ? (hasContent ? "Generated" : "Run AI generation.")
                : "Lane A + Lane B import"}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background px-3 py-2">
            <p className="font-medium text-foreground">4. Publish</p>
            <p className="text-muted-foreground mt-0.5">{config.status === "live" ? "Live to students" : "Publish after review."}</p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Step 1</p>
          <ReusableUnitLibrarySection configId={configId} subjectName={config.subject} />
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Step 2</p>
          <FileUploadSection
            configId={configId}
            hasFiles={hasFiles}
            paperUrls={config.paperFileUrls}
            onUploaded={() => refetch()}
          />
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Step 3</p>
          <div className="mb-3 inline-flex rounded-xl border border-border bg-background p-1">
            <button
              type="button"
              onClick={() => setGenerationMode("expensive")}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                generationMode === "expensive" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Expensive Mode
            </button>
            <button
              type="button"
              onClick={() => setGenerationMode("cheap")}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                generationMode === "cheap" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Cheap Mode
            </button>
          </div>
          {generationMode === "expensive" ? (
            <GenerationSection configId={configId} hasFiles={hasFiles} />
          ) : (
            <CheapGenerationSection configId={configId} />
          )}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Review</p>
          <ContentReviewSection configId={configId} />
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Step 4</p>
          <PublishSection
            configId={configId}
            status={config.status}
            hasContent={hasContent}
            onPublished={() => refetch()}
          />
        </div>
      </div>
    </div>
  );
}

