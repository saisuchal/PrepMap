import { useEffect, useMemo, useState } from "react";
import {
  useGetConfigs,
  useCreateConfig,
  useGetAdminStats,
  useDeleteConfig,
  useGetAppMetadata,
  useGetQuestionBankInteractionSummary,
  useGetLiveConfigQuestionBankInteractionSummary,
  useGetUniversityAnalytics,
  useGetConfigStudentProgress,
  useGetQuestionBank,
  useGetLibrarySubjects,
  useGetLibraryUnits,
  useUpsertLibrarySubject,
  useSaveConfigUnitLinks,
} from "@/api-client";
import { UNIVERSITIES, EXAM_TYPES, COMMON_BRANCH, SEMESTERS } from "@/lib/constants";
import { useLocation } from "wouter";
import {
  BarChart3, Users, BookOpen, Plus, Settings, FileText,
  CheckCircle2, Clock, ChevronRight, Search, Ban, MessageSquare, Eye,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

function CreateConfigDialog({ onCreated }: { onCreated: () => void }) {
  const CUSTOM_SUBJECT_OPTION = "__create_new__";
  const [open, setOpen] = useState(false);
  const [universityId, setUniversityId] = useState("");
  const [year, setYear] = useState("");
  const [subject, setSubject] = useState("");
  const [subjectSelection, setSubjectSelection] = useState(CUSTOM_SUBJECT_OPTION);
  const [subjectDrafts, setSubjectDrafts] = useState<string[]>([]);
  const [exam, setExam] = useState("");
  const { data: metadata } = useGetAppMetadata();
  const universities = metadata?.universities?.length ? metadata.universities : UNIVERSITIES;
  const semesters = metadata?.semesters?.length ? metadata.semesters : SEMESTERS;
  const examTypes = metadata?.examTypes?.length ? metadata.examTypes : EXAM_TYPES;
  const commonBranch = metadata?.commonBranch || COMMON_BRANCH;
  const { data: existingConfigs } = useGetConfigs({});
  const createConfig = useCreateConfig();
  const { data: librarySubjects } = useGetLibrarySubjects();
  const upsertLibrarySubject = useUpsertLibrarySubject();
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const saveConfigUnitLinks = useSaveConfigUnitLinks();
  const { toast } = useToast();

  const normalizeText = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

  const selectedLibrarySubject = useMemo(() => {
    const n = normalizeText(subject);
    return (librarySubjects ?? []).find((s) => s.normalizedName === n) ?? null;
  }, [librarySubjects, subject]);

  const { data: libraryUnits } = useGetLibraryUnits(selectedLibrarySubject?.id ?? null);

  useEffect(() => {
    setSelectedUnitIds([]);
  }, [subject]);

  const subjectOptions = useMemo(
    () =>
      Array.from(new Set((librarySubjects ?? []).map((s) => s.name.trim()).filter(Boolean))).sort(
        (a, b) => a.localeCompare(b)
      ),
    [librarySubjects]
  );

  const addSubjectDraft = () => {
    const trimmed = subject.trim();
    if (!trimmed) return;
    const normalized = normalizeText(trimmed);
    setSubjectDrafts((prev) => {
      if (prev.some((s) => normalizeText(s) === normalized)) return prev;
      return [...prev, trimmed];
    });
    setSubject("");
    setSubjectSelection(CUSTOM_SUBJECT_OPTION);
    setSelectedUnitIds([]);
  };

  const removeSubjectDraft = (index: number) => {
    setSubjectDrafts((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const enteredSubject = subject.trim();
      const allSubjects = [...subjectDrafts, ...(enteredSubject ? [enteredSubject] : [])];
      const uniqueSubjects = Array.from(
        new Map(allSubjects.map((s) => [normalizeText(s), s.trim()])).values()
      ).filter(Boolean);

      if (uniqueSubjects.length === 0) {
        toast({
          title: "No subjects added",
          description: "Add at least one subject draft before creating configs.",
        });
        return;
      }

      const existingForCombo = new Set(
        (existingConfigs ?? [])
          .filter(
            (c) =>
              c.universityId === universityId &&
              c.year === year &&
              c.branch === commonBranch &&
              c.exam === exam
          )
          .map((c) => normalizeText(c.subject))
      );

      const pendingSubjects = uniqueSubjects.filter((s) => !existingForCombo.has(normalizeText(s)));
      const skippedCount = uniqueSubjects.length - pendingSubjects.length;

      if (pendingSubjects.length === 0) {
        toast({
          title: "Nothing to create",
          description: `All selected subjects already have configs for this exam.`,
        });
        return;
      }

      const createdConfigIds: string[] = [];
      for (const pendingSubject of pendingSubjects) {
        const normalizedPending = normalizeText(pendingSubject);
        const existingLibrarySubject =
          (librarySubjects ?? []).find((s) => s.normalizedName === normalizedPending) ?? null;
        if (!existingLibrarySubject) {
          await upsertLibrarySubject.mutateAsync({ name: pendingSubject });
        }

        const created = await createConfig.mutateAsync({
          data: {
            universityId,
            year,
            branch: commonBranch,
            subject: pendingSubject,
            exam: exam as "mid1" | "mid2" | "endsem",
          },
        });
        createdConfigIds.push(created.id);
      }

      if (selectedUnitIds.length > 0 && createdConfigIds.length === 1) {
        for (const configId of createdConfigIds) {
          await saveConfigUnitLinks.mutateAsync({ configId, unitIds: selectedUnitIds });
        }
      }

      setOpen(false);
      setUniversityId("");
      setYear("");
      setSubject("");
      setSubjectSelection(CUSTOM_SUBJECT_OPTION);
      setSubjectDrafts([]);
      setExam("");
      setSelectedUnitIds([]);
      onCreated();
      toast({
        title: "Configs created",
        description:
          skippedCount > 0
            ? `${createdConfigIds.length} created, ${skippedCount} skipped (already existed).`
            : `${createdConfigIds.length} config drafts created successfully.`,
      });
    } catch {
      toast({ title: "Failed to create config", description: "Something went wrong. Please try again.", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          New Config
        </Button>
      </DialogTrigger>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[56rem] overflow-x-hidden sm:max-w-[56rem]">
        <DialogHeader>
          <DialogTitle>Create Exam Config</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label>University</Label>
            <Select value={universityId} onValueChange={setUniversityId}>
              <SelectTrigger className="w-full min-w-0 max-w-full">
                <span className="block min-w-0 truncate text-left">
                  <SelectValue placeholder="Select university" />
                </span>
              </SelectTrigger>
              <SelectContent>
                {universities.map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Semester</Label>
              <Select value={year} onValueChange={setYear}>
                <SelectTrigger className="w-full min-w-0 max-w-full">
                  <span className="block min-w-0 truncate text-left">
                    <SelectValue placeholder="Select semester" />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {semesters.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Branch</Label>
              <Input value={commonBranch} readOnly disabled />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Exam Type</Label>
            <Select value={exam} onValueChange={setExam}>
              <SelectTrigger className="w-full min-w-0 max-w-full">
                <span className="block min-w-0 truncate text-left">
                  <SelectValue placeholder="Select exam" />
                </span>
              </SelectTrigger>
              <SelectContent>
                {examTypes.map((e) => (
                  <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Add Subject</Label>
            <Select
              value={subjectSelection}
              onValueChange={(value) => {
                setSubjectSelection(value);
                if (value !== CUSTOM_SUBJECT_OPTION) {
                  setSubject(value);
                } else {
                  setSubject("");
                }
              }}
            >
              <SelectTrigger className="w-full min-w-0 max-w-full">
                <span className="block min-w-0 truncate text-left">
                  <SelectValue placeholder="Select/create subject" />
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CUSTOM_SUBJECT_OPTION}>Create new subject</SelectItem>
                {subjectOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {subjectSelection === CUSTOM_SUBJECT_OPTION && (
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Data Structures" />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={addSubjectDraft} disabled={!subject.trim()}>
                <Plus className="w-4 h-4 mr-1" />
                Add Subject
              </Button>
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Add multiple subjects, then create all drafts in one go.
              </p>
            </div>
            {subjectDrafts.length > 0 && (
              <div className="rounded-md border border-border p-2 flex flex-wrap gap-2">
                {subjectDrafts.map((s, index) => (
                  <Badge key={`${s}-${index}`} variant="secondary" className="gap-2 pr-1">
                    <span>{s}</span>
                    <button
                      type="button"
                      className="text-xs leading-none px-1 py-0.5 rounded hover:bg-black/10"
                      onClick={() => removeSubjectDraft(index)}
                      aria-label={`Remove ${s}`}
                    >
                      x
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Reusable Units (optional)</Label>
            {subjectDrafts.length > 1 ? (
              <p className="text-xs text-muted-foreground">Reusable units are available when creating one subject at a time.</p>
            ) : !subject.trim() ? (
              <p className="text-xs text-muted-foreground">Select/enter subject to see reusable units.</p>
            ) : !selectedLibrarySubject ? (
              <p className="text-xs text-muted-foreground">No library subject yet for this name. It will be created on config creation.</p>
            ) : !libraryUnits || libraryUnits.length === 0 ? (
              <p className="text-xs text-muted-foreground">No units available yet for this subject.</p>
            ) : (
              <div className="max-h-36 overflow-y-auto rounded-md border border-border p-2 space-y-1">
                {libraryUnits.map((u) => (
                  <label key={u.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedUnitIds.includes(u.id)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setSelectedUnitIds((prev) =>
                          checked ? (prev.includes(u.id) ? prev : [...prev, u.id]) : prev.filter((id) => id !== u.id)
                        );
                      }}
                    />
                    <span>{u.unitTitle}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          

          <Button
            type="submit"
            className="w-full"
            disabled={
              !universityId ||
              !year ||
              !(subjectDrafts.length > 0 || subject.trim()) ||
              !exam ||
              createConfig.isPending ||
              upsertLibrarySubject.isPending ||
              saveConfigUnitLinks.isPending
            }
          >
            {createConfig.isPending || upsertLibrarySubject.isPending || saveConfigUnitLinks.isPending
              ? "Creating..."
              : "Create Config Drafts"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfigsTab() {
  const { data: metadata } = useGetAppMetadata();
  const universities = metadata?.universities?.length ? metadata.universities : UNIVERSITIES;
  const semesters = metadata?.semesters?.length ? metadata.semesters : SEMESTERS;
  const examTypes = metadata?.examTypes?.length ? metadata.examTypes : EXAM_TYPES;
  const uniLabel = (id: string) => universities.find((u) => u.id === id)?.name ?? id;
  const semesterLabel = (id: string) => semesters.find((s) => s.id === id)?.name ?? id;
  const examLabel = (id: string) => examTypes.find((e) => e.id === id)?.name ?? id;
  const semExamLabel = (semesterId: string, examId: string) => `${semesterLabel(semesterId)} - ${examLabel(examId)}`;
  const [, setLocation] = useLocation();
  const [selectedUniversityId, setSelectedUniversityId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [yearFilter, setYearFilter] = useState<string>("all");
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [examFilter, setExamFilter] = useState<string>("all");
  const [subjectFilter, setSubjectFilter] = useState<string>("all");
  const { data: configs, isLoading, refetch } = useGetConfigs({}, { query: { queryKey: ["configs", "all"] } });
  const deleteConfig = useDeleteConfig();
  const { toast } = useToast();
  const [disableTarget, setDisableTarget] = useState<{
    id: string;
    subject: string;
    year: string;
    exam: string;
  } | null>(null);

  const sortedConfigs = [...(configs ?? [])].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });

  const universityCards = universities
    .map((u) => {
      const universityConfigs = sortedConfigs.filter((c) => c.universityId === u.id);
      return {
        id: u.id,
        name: u.name,
        total: universityConfigs.length,
        live: universityConfigs.filter((c) => c.status === "live").length,
        draft: universityConfigs.filter((c) => c.status !== "live").length,
      };
    })
    .filter((u) => {
      if (!search.trim()) return true;
      return u.name.toLowerCase().includes(search.toLowerCase());
    });

  const selectedUniversityConfigs = selectedUniversityId
    ? sortedConfigs.filter((c) => c.universityId === selectedUniversityId)
    : [];

  const yearOptions = Array.from(new Set(selectedUniversityConfigs.map((c) => c.year)));
  const branchOptions = Array.from(new Set(selectedUniversityConfigs.map((c) => c.branch))).sort((a, b) => a.localeCompare(b));
  const examOptions = Array.from(new Set(selectedUniversityConfigs.map((c) => c.exam)));
  const subjectOptions = Array.from(new Set(selectedUniversityConfigs.map((c) => c.subject))).sort((a, b) => a.localeCompare(b));

  const filteredConfigs = selectedUniversityConfigs.filter((c) => {
    if (yearFilter !== "all" && c.year !== yearFilter) return false;
    if (branchFilter !== "all" && c.branch !== branchFilter) return false;
    if (examFilter !== "all" && c.exam !== examFilter) return false;
    if (subjectFilter !== "all" && c.subject !== subjectFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.subject.toLowerCase().includes(q) ||
      c.branch.toLowerCase().includes(q) ||
      uniLabel(c.universityId).toLowerCase().includes(q)
    );
  });

  useEffect(() => {
    setYearFilter("all");
    setBranchFilter("all");
    setExamFilter("all");
    setSubjectFilter("all");
  }, [selectedUniversityId]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3 flex-1 w-full sm:w-auto">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={selectedUniversityId ? "Search subjects in this university..." : "Search universities..."}
              className="pl-9"
            />
          </div>
        </div>
        <CreateConfigDialog onCreated={() => refetch()} />
      </div>
      {selectedUniversityId && (
        <div className="mb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSelectedUniversityId(null);
              setSearch("");
            }}
          >
            {"<- Back to Universities"}
          </Button>
          <p className="mt-2 text-sm text-muted-foreground">
            Showing configs for <span className="font-medium text-foreground">{uniLabel(selectedUniversityId)}</span>
          </p>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <Select value={yearFilter} onValueChange={setYearFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Year/Semester" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Semesters</SelectItem>
                  {yearOptions.map((yearId) => (
                    <SelectItem key={yearId} value={yearId}>
                      {semesterLabel(yearId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Select value={branchFilter} onValueChange={setBranchFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Branch" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Branches</SelectItem>
                  {branchOptions.map((branch) => (
                    <SelectItem key={branch} value={branch}>
                      {branch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Select value={examFilter} onValueChange={setExamFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Exam" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Exams</SelectItem>
                  {examOptions.map((examId) => (
                    <SelectItem key={examId} value={examId}>
                      {examLabel(examId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Select value={subjectFilter} onValueChange={setSubjectFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Subject" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Subjects</SelectItem>
                  {subjectOptions.map((subject) => (
                    <SelectItem key={subject} value={subject}>
                      {subject}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-44 bg-card rounded-2xl border border-border animate-pulse" />
          ))}
        </div>
      ) : !selectedUniversityId && universityCards.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <FileText className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-1">No universities found</h3>
          <p className="text-muted-foreground text-sm">Try a different search keyword.</p>
        </div>
      ) : selectedUniversityId && filteredConfigs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <FileText className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-1">No configs found</h3>
          <p className="text-muted-foreground text-sm">Create your first exam config for this university to get started.</p>
        </div>
      ) : !selectedUniversityId ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence>
            {universityCards.map((u, i) => (
              <motion.div
                key={u.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                onClick={() => u.total > 0 && setSelectedUniversityId(u.id)}
                className={`bg-card rounded-2xl border border-border p-5 transition-all ${
                  u.total > 0
                    ? "cursor-pointer hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5"
                    : "opacity-80"
                }`}
              >
                <div className="flex items-start justify-between mb-3">
                  <Badge variant="secondary" className="text-xs">
                    {u.total} Config{u.total === 1 ? "" : "s"}
                  </Badge>
                  {u.total > 0 && <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                </div>
                <h3 className="font-semibold text-foreground text-lg mb-2 line-clamp-2">{u.name}</h3>
                <p className="text-sm text-muted-foreground mb-3">University-level configs</p>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Live: <span className="text-foreground font-medium">{u.live}</span></span>
                  <span className="text-muted-foreground">Draft: <span className="text-foreground font-medium">{u.draft}</span></span>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence>
            {filteredConfigs.map((config, i) => {
              const hasFiles = !!config.syllabusFileUrl;
              return (
                <motion.div
                  key={config.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  onClick={() => setLocation(`/admin/config/${config.id}`)}
                  className="bg-card rounded-2xl border border-border p-5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 transition-all cursor-pointer group"
                >
                  <div className="flex items-start justify-between mb-3">
                    <Badge variant={config.status === "live" ? "default" : "secondary"} className="text-xs">
                      {config.status === "live" ? (
                        <><CheckCircle2 className="w-3 h-3 mr-1" /> Live</>
                      ) : (
                        <><Clock className="w-3 h-3 mr-1" /> Draft</>
                      )}
                    </Badge>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-1 rounded-md">
                        {semExamLabel(config.year, config.exam)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDisableTarget({
                            id: config.id,
                            subject: config.subject,
                            year: config.year,
                            exam: config.exam,
                          });
                        }}
                        disabled={deleteConfig.isPending}
                        aria-label={`Disable ${config.subject}`}
                      >
                        <Ban className="w-4 h-4" />
                      </Button>
                      <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                  </div>
                  <h3 className="font-semibold text-foreground text-lg mb-1 line-clamp-1">{config.subject}</h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    {uniLabel(config.universityId)} &middot; {config.branch}
                  </p>
                  <div className="flex items-center justify-between">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLocation(
                          `/roadmap?configId=${encodeURIComponent(config.id)}&subject=${encodeURIComponent(config.subject)}&exam=${encodeURIComponent(config.exam)}`
                        );
                      }}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Preview
                    </Button>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {hasFiles && <FileText className="w-3.5 h-3.5 text-green-500" />}
                      {config.createdAt && new Date(config.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      <AlertDialog open={!!disableTarget} onOpenChange={(open) => !open && setDisableTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable Roadmap?</AlertDialogTitle>
            <AlertDialogDescription>
              {disableTarget
                ? `Disable "${disableTarget.subject}" (${semExamLabel(disableTarget.year, disableTarget.exam)})? Students will no longer see it, but units, explanations, and question bank data will be preserved.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!disableTarget) return;
                deleteConfig.mutate(
                  { id: disableTarget.id },
                  {
                    onSuccess: () => {
                      refetch();
                      toast({
                        title: "Roadmap disabled",
                        description: `${disableTarget.subject} has been disabled.`,
                      });
                      setDisableTarget(null);
                    },
                    onError: () => {
                      toast({
                        title: "Disable failed",
                        description: "Could not disable this roadmap. Please try again.",
                        variant: "destructive",
                      });
                    },
                  }
                );
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AnalyticsTab() {
  const { data: metadata } = useGetAppMetadata();
  const universities = metadata?.universities?.length ? metadata.universities : UNIVERSITIES;
  const semesters = metadata?.semesters?.length ? metadata.semesters : SEMESTERS;
  const examTypes = metadata?.examTypes?.length ? metadata.examTypes : EXAM_TYPES;
  const uniLabel = (id: string) => universities.find((u) => u.id === id)?.name ?? id;
  const semesterLabel = (id: string) => semesters.find((s) => s.id === id)?.name ?? id;
  const examLabel = (id: string) => examTypes.find((e) => e.id === id)?.name ?? id;
  const semExamLabel = (semesterId: string, examId: string) => `${semesterLabel(semesterId)} - ${examLabel(examId)}`;
  const {
    data: allConfigs,
    isLoading: configsLoading,
    isError: configsError,
    error: configsErrorDetails,
  } = useGetConfigs({}, { query: { queryKey: ["configs", "all"] } });
  const { data: questionBankInteractionSummary } = useGetQuestionBankInteractionSummary();
  const { data: liveConfigQbSummary } = useGetLiveConfigQuestionBankInteractionSummary();
  const { data: universityAnalytics } = useGetUniversityAnalytics();
  const liveConfigs = useMemo(
    () => (allConfigs ?? []).filter((cfg) => cfg.status === "live"),
    [allConfigs]
  );
  const studentCountByUniversity = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of universityAnalytics ?? []) {
      map.set(row.universityId, row.totalStudents ?? 0);
    }
    return map;
  }, [universityAnalytics]);
  const universityRows = useMemo(
    () =>
      universities.map((u) => ({
        universityId: u.id,
        liveConfigs: liveConfigs.filter((cfg) => cfg.universityId === u.id),
      })),
    [universities, liveConfigs]
  );
  const [selectedUniversityId, setSelectedUniversityId] = useState<string | null>(null);
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
  const selectedUniversityRow = universityRows.find((row) => row.universityId === selectedUniversityId) ?? null;
  const selectedUniversityConfigs = selectedUniversityRow?.liveConfigs ?? [];
  const selectedConfig = selectedUniversityConfigs.find((cfg) => cfg.id === selectedConfigId) ?? null;
  const qbSummaryByConfig = useMemo(() => {
    const map = new Map<string, {
      totalStudents: number;
      uniqueStudents: number;
      totalInteractions: number;
      interactionPercent: number;
    }>();
    for (const row of liveConfigQbSummary?.rows ?? []) {
      map.set(row.configId, {
        totalStudents: row.totalStudents,
        uniqueStudents: row.uniqueStudents,
        totalInteractions: row.totalInteractions,
        interactionPercent: row.interactionPercent,
      });
    }
    return map;
  }, [liveConfigQbSummary]);
  const { data: studentProgress, isLoading: studentsLoading } = useGetConfigStudentProgress(
    selectedConfigId
  );
  const { data: selectedConfigQuestionBank } = useGetQuestionBank(selectedConfigId);
  const { data: stats } = useGetAdminStats();
  const getStudentRating = (subtopicPercent: number, qbPercent: number): "Poor" | "Average" | "Good" => {
    if (subtopicPercent <= 30 || qbPercent <= 50) return "Poor";
    if (subtopicPercent >= 75 && qbPercent >= 75) return "Good";
    if (subtopicPercent >= 50 && qbPercent >= 50) return "Average";
    return "Poor";
  };
  const selectedConfigRatingCounts = useMemo(() => {
    const counts = { Poor: 0, Average: 0, Good: 0 };
    if (!studentProgress) return counts;

    const totalQuestions = selectedConfigQuestionBank?.total ?? 0;
    for (const s of studentProgress.students) {
      const subtopicPercent = Math.round(s.progressPercent);
      const rawQbInteractions = s.questionBankInteractions ?? 0;
      const normalizedQbInteractions =
        totalQuestions > 0 ? Math.min(rawQbInteractions, totalQuestions) : 0;
      const qbPercent =
        totalQuestions > 0 ? Math.round((normalizedQbInteractions / totalQuestions) * 100) : 0;
      const rating = getStudentRating(subtopicPercent, qbPercent);
      counts[rating] += 1;
    }
    return counts;
  }, [studentProgress, selectedConfigQuestionBank]);
  const selectedConfigRatingPercents = useMemo(() => {
    const total = studentProgress?.students.length ?? 0;
    const toPercent = (count: number) => (total > 0 ? Math.round((count / total) * 100) : 0);
    return {
      Poor: toPercent(selectedConfigRatingCounts.Poor),
      Average: toPercent(selectedConfigRatingCounts.Average),
      Good: toPercent(selectedConfigRatingCounts.Good),
    };
  }, [studentProgress, selectedConfigRatingCounts]);

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
        <div className="bg-card rounded-2xl p-6 border border-border shadow-sm flex items-center gap-5">
          <div className="w-14 h-14 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-600">
            <BookOpen className="w-7 h-7" />
          </div>
          <div>
            <p className="text-sm font-semibold text-muted-foreground">Tracked Subtopics</p>
            <p className="text-3xl font-display font-bold text-foreground">{stats?.length || 0}</p>
          </div>
        </div>
        <div className="bg-card rounded-2xl p-6 border border-border shadow-sm flex items-center gap-5">
          <div className="w-14 h-14 rounded-xl bg-green-500/10 flex items-center justify-center text-green-600">
            <Users className="w-7 h-7" />
          </div>
          <div>
            <p className="text-sm font-semibold text-muted-foreground">Total Interactions</p>
            <p className="text-3xl font-display font-bold text-foreground">
              {stats?.reduce((acc, curr) => acc + curr.eventCount, 0) || 0}
            </p>
          </div>
        </div>
        <div className="bg-card rounded-2xl p-6 border border-border shadow-sm flex items-center gap-5">
          <div className="w-14 h-14 rounded-xl bg-violet-500/10 flex items-center justify-center text-violet-600">
            <Users className="w-7 h-7" />
          </div>
          <div>
            <p className="text-sm font-semibold text-muted-foreground">Universities Covered</p>
            <p className="text-3xl font-display font-bold text-foreground">{universities.length}</p>
          </div>
        </div>
        <div className="bg-card rounded-2xl p-6 border border-border shadow-sm flex items-center gap-5">
          <div className="w-14 h-14 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-600">
            <MessageSquare className="w-7 h-7" />
          </div>
          <div>
            <p className="text-sm font-semibold text-muted-foreground">Question Bank Interactions</p>
            <p className="text-3xl font-display font-bold text-foreground">
              {questionBankInteractionSummary?.questionBankInteractionCount || 0}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-card rounded-3xl border border-border shadow-lg shadow-black/5 overflow-hidden">
        <div className="px-6 py-5 border-b border-border bg-secondary/30">
          <h2 className="text-lg font-semibold text-foreground">Detailed Analytics By University</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-6 py-4 font-semibold">University</th>
                <th className="px-6 py-4 font-semibold text-right">Students</th>
                <th className="px-6 py-4 font-semibold text-right">Live Configs</th>
                <th className="px-6 py-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50 text-sm">
              {configsLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-6 py-4"><div className="h-5 bg-muted animate-pulse rounded w-3/4" /></td>
                    <td className="px-6 py-4"><div className="h-5 bg-muted animate-pulse rounded w-1/3 ml-auto" /></td>
                    <td className="px-6 py-4"><div className="h-5 bg-muted animate-pulse rounded w-1/3 ml-auto" /></td>
                    <td className="px-6 py-4"><div className="h-8 bg-muted animate-pulse rounded w-24 ml-auto" /></td>
                  </tr>
                ))
              ) : configsError ? (
                <tr>
                  <td colSpan={4} className="px-6 py-12 text-center text-destructive">
                    Failed to load analytics: {configsErrorDetails instanceof Error ? configsErrorDetails.message : "Unknown error"}
                  </td>
                </tr>
              ) : (
                universityRows.map((row, i) => {
                  return (
                    <motion.tr
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05 }}
                      key={row.universityId}
                      className="hover:bg-muted/50 transition-colors"
                    >
                      <td className="px-6 py-4 font-medium text-foreground">
                        {uniLabel(row.universityId)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="font-display font-bold text-foreground">
                          {studentCountByUniversity.get(row.universityId) ?? 0}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="font-display font-bold text-foreground">{row.liveConfigs.length}</span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={row.liveConfigs.length === 0}
                          onClick={() => {
                            setSelectedUniversityId(row.universityId);
                            setSelectedConfigId(null);
                          }}
                        >
                          Show All Live Configs
                        </Button>
                      </td>
                    </motion.tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog
        open={!!selectedUniversityId}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedUniversityId(null);
            setSelectedConfigId(null);
          }
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {selectedConfig
                ? `Student Progress - ${uniLabel(selectedUniversityId || "")} / ${selectedConfig.subject}`
                : `Live Configs - ${uniLabel(selectedUniversityId || "")}`}
            </DialogTitle>
          </DialogHeader>

          {!selectedConfig ? (
            <div className="max-h-[65vh] overflow-auto border border-border rounded-xl">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">Subject</th>
                    <th className="px-4 py-3 font-semibold">Semester</th>
                    <th className="px-4 py-3 font-semibold">Exam</th>
                    <th className="px-4 py-3 font-semibold">Branch</th>
                    <th className="px-4 py-3 font-semibold text-right">QB Interactions</th>
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50 text-sm">
                  {selectedUniversityConfigs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                        No live configs found for this university.
                      </td>
                    </tr>
                  ) : (
                    selectedUniversityConfigs.map((cfg) => {
                      const qb = qbSummaryByConfig.get(cfg.id);
                      const percent = Math.round(qb?.interactionPercent ?? 0);
                      const totalInteractions = qb?.totalInteractions ?? 0;
                      return (
                        <tr key={cfg.id}>
                          <td className="px-4 py-3 font-medium text-foreground">{cfg.subject}</td>
                          <td className="px-4 py-3 text-foreground">{semesterLabel(cfg.year)}</td>
                          <td className="px-4 py-3 text-foreground">{examLabel(cfg.exam)}</td>
                          <td className="px-4 py-3 text-foreground">{cfg.branch}</td>
                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex items-center gap-2">
                              <span className="font-semibold text-foreground">{percent}%</span>
                              <span className="text-xs text-muted-foreground">({totalInteractions})</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setSelectedConfigId(cfg.id)}
                            >
                              Student Progress
                            </Button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="space-y-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => setSelectedConfigId(null)}
              >{"<- Back to Live Configs"}</Button>
              {studentsLoading ? (
                <div className="py-8 text-center text-muted-foreground">Loading students...</div>
              ) : !studentProgress ? (
                <div className="py-8 text-center text-muted-foreground">No student progress data found.</div>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="bg-rose-50 text-rose-700 border border-rose-200">
                      Poor: {selectedConfigRatingCounts.Poor} ({selectedConfigRatingPercents.Poor}%)
                    </Badge>
                    <Badge variant="secondary" className="bg-amber-50 text-amber-700 border border-amber-200">
                      Average: {selectedConfigRatingCounts.Average} ({selectedConfigRatingPercents.Average}%)
                    </Badge>
                    <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border border-emerald-200">
                      Good: {selectedConfigRatingCounts.Good} ({selectedConfigRatingPercents.Good}%)
                    </Badge>
                  </div>
                <div className="max-h-[60vh] overflow-auto border border-border rounded-xl">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-card">
                      <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                        <th className="px-4 py-3 font-semibold">Student</th>
                        <th className="px-4 py-3 font-semibold">Semester</th>
                        <th className="px-4 py-3 font-semibold">Branch</th>
                        <th className="px-4 py-3 font-semibold text-right">Sub-topic Coverage</th>
                        <th className="px-4 py-3 font-semibold text-right">QB Interactions</th>
                        <th className="px-4 py-3 font-semibold text-right">Rating</th>
                        <th className="px-4 py-3 font-semibold text-right">Last Active</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50 text-sm">
                      {studentProgress.students.map((s) => {
                        const pct = Math.round(s.progressPercent);
                        const totalQuestions = selectedConfigQuestionBank?.total ?? 0;
                        const rawQbInteractions = s.questionBankInteractions ?? 0;
                        const normalizedQbInteractions =
                          totalQuestions > 0 ? Math.min(rawQbInteractions, totalQuestions) : 0;
                        const qbPct =
                          totalQuestions > 0
                            ? Math.round((normalizedQbInteractions / totalQuestions) * 100)
                            : 0;
                        const rating = getStudentRating(pct, qbPct);
                        return (
                          <tr key={s.userId}>
                            <td className="px-4 py-3 font-medium text-foreground">{s.userId}</td>
                            <td className="px-4 py-3 text-foreground">{semesterLabel(s.year)}</td>
                            <td className="px-4 py-3 text-foreground">{s.branch}</td>
                            <td className="px-4 py-3 text-right">
                              <div className="inline-flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">
                                  {s.doneSubtopics}/{s.totalSubtopics}
                                </span>
                                <span className="font-semibold text-foreground">{pct}%</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="inline-flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">
                                  {normalizedQbInteractions}/{totalQuestions}
                                </span>
                                <span className="font-semibold text-foreground">{qbPct}%</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span
                                className={
                                  rating === "Good"
                                    ? "inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700"
                                    : rating === "Average"
                                    ? "inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700"
                                    : "inline-flex items-center rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700"
                                }
                              >
                                {rating}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right text-muted-foreground">
                              {s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleDateString() : "-"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Admin() {
  return (
    <div className="w-full max-w-6xl mx-auto pt-4 pb-20 px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-3">
          <Settings className="w-8 h-8 text-primary" />
          Admin Dashboard
        </h1>
        <p className="text-muted-foreground mt-2">
          Manage exam configs, generate content, and monitor analytics.
        </p>
      </div>

      <Tabs defaultValue="configs">
        <TabsList className="mb-6">
          <TabsTrigger value="configs" className="gap-2">
            <FileText className="w-4 h-4" /> Configs
          </TabsTrigger>
          <TabsTrigger value="analytics" className="gap-2">
            <BarChart3 className="w-4 h-4" /> Analytics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="configs">
          <ConfigsTab />
        </TabsContent>
        <TabsContent value="analytics">
          <AnalyticsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
