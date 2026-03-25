import { useState, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import {
  useGetConfigs,
  useUploadConfigFiles,
  useTriggerGeneration,
  useGetGenerationStatus,
  usePublishConfig,
  useRequestUploadUrl,
  useGetNodes,
  useGetSubtopicContent,
} from "@workspace/api-client-react";
import { UNIVERSITIES, EXAM_TYPES } from "@/lib/constants";
import {
  ArrowLeft, Upload, Sparkles, Globe, FileText, CheckCircle2,
  Clock, AlertCircle, Loader2, ChevronDown, ChevronRight,
  BookOpen, HelpCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";

const examLabel = (id: string) => EXAM_TYPES.find((e) => e.id === id)?.name ?? id;
const uniLabel = (id: string) => UNIVERSITIES.find((u) => u.id === id)?.name ?? id;

function FileUploadSection({
  configId,
  hasFiles,
  syllabusUrl,
  paperUrls,
  onUploaded,
}: {
  configId: string;
  hasFiles: boolean;
  syllabusUrl: string | null | undefined;
  paperUrls: string[] | null | undefined;
  onUploaded: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [syllabusFile, setSyllabusFile] = useState<File | null>(null);
  const [paperFiles, setPaperFiles] = useState<File[]>([]);
  const requestUrl = useRequestUploadUrl();
  const uploadFiles = useUploadConfigFiles();
  const { toast } = useToast();

  const uploadSingleFile = async (file: File): Promise<string> => {
    const { data } = await requestUrl.mutateAsync({
      data: { name: file.name, size: file.size, contentType: file.type || "application/pdf" },
    });
    await fetch(data.uploadURL, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/pdf" },
    });
    return data.objectPath;
  };

  const handleUpload = async () => {
    if (!syllabusFile) return;
    setUploading(true);
    try {
      const syllabusPath = await uploadSingleFile(syllabusFile);
      const paperPaths = await Promise.all(paperFiles.map(uploadSingleFile));

      await uploadFiles.mutateAsync({
        id: configId,
        data: {
          syllabusFileUrl: `/objects/${syllabusPath}`,
          paperFileUrls: paperPaths.map((p) => `/objects/${p}`),
        },
      });
      setSyllabusFile(null);
      setPaperFiles([]);
      onUploaded();
      toast({ title: "Files uploaded", description: "Syllabus and papers saved successfully." });
    } catch (err) {
      toast({ title: "Upload failed", description: "Something went wrong. Please try again.", variant: "destructive" });
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
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            Syllabus PDF <span className="text-destructive">*</span>
          </label>
          <label className="flex items-center justify-center border-2 border-dashed border-border rounded-xl p-6 cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-all">
            <input
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={(e) => setSyllabusFile(e.target.files?.[0] ?? null)}
            />
            <div className="text-center">
              <FileText className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                {syllabusFile ? syllabusFile.name : "Click to select syllabus PDF"}
              </p>
            </div>
          </label>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            Previous Papers (optional)
          </label>
          <label className="flex items-center justify-center border-2 border-dashed border-border rounded-xl p-6 cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-all">
            <input
              type="file"
              accept=".pdf"
              multiple
              className="hidden"
              onChange={(e) => setPaperFiles(Array.from(e.target.files ?? []))}
            />
            <div className="text-center">
              <FileText className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                {paperFiles.length > 0 ? `${paperFiles.length} file(s) selected` : "Click to select paper PDFs"}
              </p>
            </div>
          </label>
        </div>

        <Button onClick={handleUpload} disabled={!syllabusFile || uploading} className="w-full gap-2">
          {uploading ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Uploading...</>
          ) : (
            <><Upload className="w-4 h-4" /> {hasFiles ? "Replace Files" : "Upload Files"}</>
          )}
        </Button>
      </div>
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

  const handlePublish = () => {
    publishConfig.mutate({ id: configId }, {
      onSuccess: () => {
        onPublished();
        toast({ title: "Published", description: "Config is now live and visible to students." });
      },
      onError: () => {
        toast({ title: "Publish failed", description: "Could not publish config.", variant: "destructive" });
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
        <Badge variant={status === "live" ? "default" : "secondary"} className="text-sm px-3 py-1">
          {status === "live" ? (
            <><CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Live</>
          ) : (
            <><Clock className="w-3.5 h-3.5 mr-1.5" /> Draft</>
          )}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {status === "live" ? "Visible to students" : "Not visible to students"}
        </span>
      </div>

      {status !== "live" && (
        <Button
          onClick={handlePublish}
          disabled={!hasContent || publishConfig.isPending}
          className="w-full gap-2"
        >
          {publishConfig.isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Publishing...</>
          ) : (
            <><Globe className="w-4 h-4" /> Publish to Students</>
          )}
        </Button>
      )}

      {status !== "live" && !hasContent && (
        <p className="text-xs text-muted-foreground text-center mt-2">Generate content first before publishing</p>
      )}
    </div>
  );
}

function SubtopicViewer({ nodeId }: { nodeId: string }) {
  const { data, isLoading } = useGetSubtopicContent(nodeId);

  if (isLoading) {
    return <div className="p-4 animate-pulse text-sm text-muted-foreground">Loading content...</div>;
  }

  if (!data) return null;

  return (
    <div className="space-y-4 p-4 bg-secondary/30 rounded-xl">
      <div>
        <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <BookOpen className="w-3.5 h-3.5" /> Explanation
        </h5>
        <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{data.explanation}</p>
      </div>
      {data.questions.length > 0 && (
        <div>
          <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <HelpCircle className="w-3.5 h-3.5" /> Questions ({data.questions.length})
          </h5>
          <div className="space-y-3">
            {data.questions.map((q) => (
              <div key={q.id} className="bg-card rounded-lg p-3 border border-border">
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="text-xs">{q.markType}-mark</Badge>
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
                                      <SubtopicViewer nodeId={sub.id} />
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
  const config = configs?.find((c) => c.id === configId);
  const { data: genStatus } = useGetGenerationStatus(configId);

  const hasFiles = !!config?.syllabusFileUrl;
  const hasContent = genStatus?.status === "complete";

  if (configsLoading) {
    return (
      <div className="w-full max-w-4xl mx-auto pt-4 pb-20">
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
      <div className="w-full max-w-4xl mx-auto pt-4 pb-20">
        <Button variant="ghost" onClick={() => setLocation("/admin")} className="gap-2 mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to Dashboard
        </Button>
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <AlertCircle className="w-12 h-12 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold text-foreground mb-1">Config not found</h2>
          <p className="text-muted-foreground text-sm">This config may have been deleted or doesn't exist.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto pt-4 pb-20">
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
          {uniLabel(config.universityId)} &middot; {config.branch} &middot; Year {config.year} &middot; {examLabel(config.exam)}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <FileUploadSection
          configId={configId}
          hasFiles={hasFiles}
          syllabusUrl={config.syllabusFileUrl}
          paperUrls={config.paperFileUrls}
          onUploaded={() => refetch()}
        />
        <GenerationSection configId={configId} hasFiles={hasFiles} />
        <PublishSection
          configId={configId}
          status={config.status}
          hasContent={hasContent}
          onPublished={() => refetch()}
        />
      </div>

      <ContentReviewSection configId={configId} />
    </div>
  );
}
