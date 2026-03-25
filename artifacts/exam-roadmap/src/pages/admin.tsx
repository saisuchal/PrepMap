import { useState } from "react";
import { useGetConfigs, useCreateConfig, useGetAdminStats } from "@workspace/api-client-react";
import { UNIVERSITIES, EXAM_TYPES } from "@/lib/constants";
import { useLocation } from "wouter";
import {
  BarChart3, Users, BookOpen, Plus, Settings, FileText,
  CheckCircle2, Clock, ChevronRight, Search, Filter,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

const examLabel = (id: string) => EXAM_TYPES.find((e) => e.id === id)?.name ?? id;
const uniLabel = (id: string) => UNIVERSITIES.find((u) => u.id === id)?.name ?? id;

function CreateConfigDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [universityId, setUniversityId] = useState("");
  const [year, setYear] = useState("");
  const [branch, setBranch] = useState("");
  const [subject, setSubject] = useState("");
  const [exam, setExam] = useState("");
  const createConfig = useCreateConfig();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createConfig.mutate(
      { data: { universityId, year, branch, subject, exam: exam as "mid1" | "mid2" | "endsem" } },
      {
        onSuccess: () => {
          setOpen(false);
          setUniversityId("");
          setYear("");
          setBranch("");
          setSubject("");
          setExam("");
          onCreated();
          toast({ title: "Config created", description: `${subject} config created successfully.` });
        },
        onError: () => {
          toast({ title: "Failed to create config", description: "Something went wrong. Please try again.", variant: "destructive" });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          New Config
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Exam Config</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label>University</Label>
            <Select value={universityId} onValueChange={setUniversityId}>
              <SelectTrigger><SelectValue placeholder="Select university" /></SelectTrigger>
              <SelectContent>
                {UNIVERSITIES.map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Year</Label>
              <Select value={year} onValueChange={setYear}>
                <SelectTrigger><SelectValue placeholder="Year" /></SelectTrigger>
                <SelectContent>
                  {["1", "2", "3", "4"].map((y) => (
                    <SelectItem key={y} value={y}>Year {y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Branch</Label>
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="e.g. CSE" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Data Structures" />
          </div>

          <div className="space-y-2">
            <Label>Exam Type</Label>
            <Select value={exam} onValueChange={setExam}>
              <SelectTrigger><SelectValue placeholder="Select exam" /></SelectTrigger>
              <SelectContent>
                {EXAM_TYPES.map((e) => (
                  <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={!universityId || !year || !branch || !subject || !exam || createConfig.isPending}
          >
            {createConfig.isPending ? "Creating..." : "Create Config"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfigsTab() {
  const [, setLocation] = useLocation();
  const [filterUni, setFilterUni] = useState<string>("all");
  const [search, setSearch] = useState("");
  const { data: configs, isLoading, refetch } = useGetConfigs(
    filterUni !== "all" ? { universityId: filterUni } : {},
    { query: { queryKey: ["configs", filterUni] } }
  );

  const filtered = (configs ?? []).filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.subject.toLowerCase().includes(q) ||
      c.branch.toLowerCase().includes(q) ||
      uniLabel(c.universityId).toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3 flex-1 w-full sm:w-auto">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search configs..."
              className="pl-9"
            />
          </div>
          <Select value={filterUni} onValueChange={setFilterUni}>
            <SelectTrigger className="w-[200px]">
              <Filter className="w-4 h-4 mr-2 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Universities</SelectItem>
              {UNIVERSITIES.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CreateConfigDialog onCreated={() => refetch()} />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-44 bg-card rounded-2xl border border-border animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <FileText className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-1">No configs found</h3>
          <p className="text-muted-foreground text-sm">Create your first exam config to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence>
            {filtered.map((config, i) => {
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
                    <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                  <h3 className="font-semibold text-foreground text-lg mb-1 line-clamp-1">{config.subject}</h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    {uniLabel(config.universityId)} &middot; {config.branch} &middot; Year {config.year}
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-1 rounded-md">
                      {examLabel(config.exam)}
                    </span>
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
    </div>
  );
}

function AnalyticsTab() {
  const { data: stats, isLoading } = useGetAdminStats();

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-10">
        <div className="bg-card rounded-2xl p-6 border border-border shadow-sm flex items-center gap-5">
          <div className="w-14 h-14 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-600">
            <BookOpen className="w-7 h-7" />
          </div>
          <div>
            <p className="text-sm font-semibold text-muted-foreground">Total Subtopics</p>
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
      </div>

      <div className="bg-card rounded-3xl border border-border shadow-lg shadow-black/5 overflow-hidden">
        <div className="px-6 py-5 border-b border-border bg-secondary/30">
          <h2 className="text-lg font-semibold text-foreground">Content Engagement</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-6 py-4 font-semibold">Subtopic Title</th>
                <th className="px-6 py-4 font-semibold text-right">Views / Completions</th>
                <th className="px-6 py-4 font-semibold text-right">Engagement Level</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50 text-sm">
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-6 py-4"><div className="h-5 bg-muted animate-pulse rounded w-3/4" /></td>
                    <td className="px-6 py-4"><div className="h-5 bg-muted animate-pulse rounded w-1/4 ml-auto" /></td>
                    <td className="px-6 py-4"><div className="h-5 bg-muted animate-pulse rounded w-1/2 ml-auto" /></td>
                  </tr>
                ))
              ) : stats?.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-6 py-12 text-center text-muted-foreground">
                    No analytics data available yet.
                  </td>
                </tr>
              ) : (
                stats?.sort((a, b) => b.eventCount - a.eventCount).map((stat, i) => {
                  const maxCount = Math.max(...(stats ?? []).map((s) => s.eventCount));
                  const percentage = maxCount > 0 ? (stat.eventCount / maxCount) * 100 : 0;
                  return (
                    <motion.tr
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05 }}
                      key={stat.subtopicId}
                      className="hover:bg-muted/50 transition-colors"
                    >
                      <td className="px-6 py-4 font-medium text-foreground">{stat.subtopicTitle}</td>
                      <td className="px-6 py-4 text-right font-display font-bold text-foreground">
                        {stat.eventCount.toLocaleString()}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-end gap-3">
                          <span className="text-xs font-medium text-muted-foreground w-8 text-right">
                            {Math.round(percentage)}%
                          </span>
                          <div className="w-32 h-2 rounded-full bg-secondary overflow-hidden">
                            <div className="h-full bg-primary rounded-full" style={{ width: `${percentage}%` }} />
                          </div>
                        </div>
                      </td>
                    </motion.tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
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
