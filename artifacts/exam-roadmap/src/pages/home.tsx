import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { BookOpen, Map, ArrowRight, Building2, Calendar, Compass, GraduationCap } from "lucide-react";
import { UNIVERSITIES, EXAM_TYPES } from "@/lib/constants";
import { useGetConfigs } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export default function Home() {
  const [, setLocation] = useLocation();
  const [selectedUni, setSelectedUni] = useState(UNIVERSITIES[0].id);
  const [selectedYear, setSelectedYear] = useState("");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [selectedExam, setSelectedExam] = useState("");

  const { data: configs, isLoading } = useGetConfigs({ universityId: selectedUni }, {
    query: { enabled: !!selectedUni }
  });

  // Extract unique available options based on fetched configs
  const availableYears = Array.from(new Set(configs?.map(c => c.year) || [])).sort();
  const availableBranches = Array.from(new Set(configs?.filter(c => !selectedYear || c.year === selectedYear).map(c => c.branch) || [])).sort();
  const availableExams = Array.from(new Set(configs?.filter(c => 
    (!selectedYear || c.year === selectedYear) && 
    (!selectedBranch || c.branch === selectedBranch)
  ).map(c => c.exam) || []));

  // Reset dependent fields when parents change
  useEffect(() => {
    setSelectedYear("");
    setSelectedBranch("");
    setSelectedExam("");
  }, [selectedUni]);

  useEffect(() => {
    setSelectedBranch("");
    setSelectedExam("");
  }, [selectedYear]);

  useEffect(() => {
    setSelectedExam("");
  }, [selectedBranch]);

  const handleNavigate = () => {
    const config = configs?.find(c => 
      c.year === selectedYear && 
      c.branch === selectedBranch && 
      c.exam === selectedExam
    );
    
    if (config) {
      setLocation(`/roadmap?universityId=${selectedUni}&year=${selectedYear}&branch=${selectedBranch}&exam=${selectedExam}&configId=${config.id}&subject=${encodeURIComponent(config.subject)}`);
    }
  };

  const isFormComplete = selectedUni && selectedYear && selectedBranch && selectedExam;

  return (
    <div className="w-full max-w-4xl mx-auto pt-8 pb-20">
      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-12"
      >
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-semibold tracking-wide mb-4 border border-primary/20">
          <Compass className="w-4 h-4" /> Syllabus Navigator
        </span>
        <h1 className="text-4xl sm:text-5xl font-display font-bold text-foreground mb-4 leading-tight">
          Find your exact path to <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-blue-400">exam success</span>
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Select your academic details below to unlock a structured, topic-by-topic roadmap tailored for your specific exam.
        </p>
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-card rounded-3xl p-6 sm:p-10 shadow-xl shadow-black/5 border border-border relative overflow-hidden"
      >
        {isLoading && (
          <div className="absolute inset-0 bg-background/50 backdrop-blur-sm z-10 flex items-center justify-center">
            <div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8">
          {/* University */}
          <div className="space-y-3">
            <label className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Building2 className="w-4 h-4 text-primary" /> University
            </label>
            <select
              className="w-full h-14 rounded-xl border-2 border-border bg-background px-4 text-base focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all appearance-none cursor-pointer"
              value={selectedUni}
              onChange={(e) => setSelectedUni(e.target.value)}
            >
              {UNIVERSITIES.map(u => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>

          {/* Year */}
          <div className="space-y-3">
            <label className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Calendar className="w-4 h-4 text-primary" /> Academic Year
            </label>
            <select
              className="w-full h-14 rounded-xl border-2 border-border bg-background px-4 text-base focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all appearance-none cursor-pointer disabled:opacity-50 disabled:bg-muted"
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
              disabled={!availableYears.length}
            >
              <option value="" disabled>Select Year</option>
              {availableYears.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          {/* Branch */}
          <div className="space-y-3">
            <label className="text-sm font-semibold text-foreground flex items-center gap-2">
              <GraduationCap className="w-4 h-4 text-primary" /> Branch / Department
            </label>
            <select
              className="w-full h-14 rounded-xl border-2 border-border bg-background px-4 text-base focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all appearance-none cursor-pointer disabled:opacity-50 disabled:bg-muted"
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              disabled={!selectedYear || !availableBranches.length}
            >
              <option value="" disabled>Select Branch</option>
              {availableBranches.map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          {/* Exam Type */}
          <div className="space-y-3">
            <label className="text-sm font-semibold text-foreground flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" /> Exam Target
            </label>
            <select
              className="w-full h-14 rounded-xl border-2 border-border bg-background px-4 text-base focus:border-primary focus:ring-4 focus:ring-primary/10 outline-none transition-all appearance-none cursor-pointer disabled:opacity-50 disabled:bg-muted"
              value={selectedExam}
              onChange={(e) => setSelectedExam(e.target.value)}
              disabled={!selectedBranch || !availableExams.length}
            >
              <option value="" disabled>Select Exam</option>
              {EXAM_TYPES.filter(e => availableExams.includes(e.id)).map(e => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-10 pt-8 border-t border-border flex justify-end">
          <Button 
            size="lg" 
            className="w-full sm:w-auto min-w-[200px] h-14 group"
            disabled={!isFormComplete}
            onClick={handleNavigate}
          >
            <Map className="w-5 h-5 mr-2" />
            Generate Roadmap
            <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
