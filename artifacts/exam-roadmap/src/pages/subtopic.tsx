import { useState, useEffect, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, CheckCircle2, MessageSquare, BookOpen, AlertCircle } from "lucide-react";
import { useGetSubtopicContent, useTrackEvent } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { getStoredUser } from "@/lib/auth";

function QuestionBlock({ 
  label, 
  question, 
  answer 
}: { 
  label: string; 
  question: string; 
  answer: string; 
}) {
  const [isRevealed, setIsRevealed] = useState(false);

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm transition-all hover:shadow-md">
      <div className="p-5 sm:p-6 border-b border-border bg-secondary/30">
        <div className="flex items-start gap-3">
          <span className="shrink-0 mt-0.5 px-2.5 py-1 rounded-md bg-primary/10 text-primary text-xs font-bold uppercase tracking-wider">
            {label}
          </span>
          <h3 className="text-base sm:text-lg font-semibold text-foreground leading-snug">
            {question}
          </h3>
        </div>
      </div>
      
      <div className="p-5 sm:p-6">
        <AnimatePresence initial={false} mode="wait">
          {!isRevealed ? (
            <motion.div
              key="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex justify-center py-4"
            >
              <Button 
                variant="outline" 
                onClick={() => setIsRevealed(true)}
                className="rounded-full px-6 font-medium shadow-sm hover:border-primary/50"
              >
                Reveal Answer
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="answer"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="prose prose-sm sm:prose-base prose-slate max-w-none prose-headings:font-display prose-p:leading-relaxed"
            >
              <div className="whitespace-pre-line">{answer}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default function Subtopic() {
  const [, params] = useRoute("/subtopic/:id");
  const id = params?.id;
  const [, setLocation] = useLocation();
  const user = getStoredUser();
  const observerRef = useRef<HTMLDivElement>(null);

  const searchParams = new URLSearchParams(window.location.search);
  const universityId = searchParams.get("universityId") || user?.universityId || "";
  const year = searchParams.get("year") || user?.year || "";
  const branch = searchParams.get("branch") || user?.branch || "";
  const examParam = searchParams.get("exam") || "";
  const configId = searchParams.get("configId") || "";
  const topicId = searchParams.get("topicId") || "";
  
  const { data: content, isLoading, isError } = useGetSubtopicContent(id || "", {
    query: { enabled: !!id }
  });
  
  const trackEventMutation = useTrackEvent();
  const [isTracked, setIsTracked] = useState(false);

  // Check initial track state from session
  useEffect(() => {
    if (id && sessionStorage.getItem(`tracked_${id}`)) {
      setIsTracked(true);
    }
  }, [id]);

  useEffect(() => {
    if (!content || !user || !id || isTracked) return;

    let timeoutId: NodeJS.Timeout;
    
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        // User scrolled to bottom, wait 2 seconds before tracking
        timeoutId = setTimeout(() => {
          if (!sessionStorage.getItem(`tracked_${id}`)) {
            trackEventMutation.mutate({
              data: {
                userId: user.id,
                universityId,
                year,
                branch,
                exam: examParam,
                configId,
                topicId,
                subtopicId: id
              }
            }, {
              onSuccess: () => {
                sessionStorage.setItem(`tracked_${id}`, 'true');
                setIsTracked(true);
              }
            });
          }
        }, 2000);
      } else {
        clearTimeout(timeoutId);
      }
    }, { threshold: 0.5 });

    if (observerRef.current) {
      observer.observe(observerRef.current);
    }

    return () => {
      observer.disconnect();
      clearTimeout(timeoutId);
    };
  }, [content, id, user, isTracked, trackEventMutation]);

  if (!id) return null;

  return (
    <div className="w-full max-w-3xl mx-auto pb-32">
      <div className="flex items-center justify-between mb-8">
        <Button variant="ghost" className="-ml-4 text-muted-foreground" onClick={() => window.history.back()}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>
        
        {isTracked && (
          <div className="flex items-center gap-1.5 text-sm font-semibold text-green-600 bg-green-50 px-3 py-1.5 rounded-full border border-green-200">
            <CheckCircle2 className="w-4 h-4" /> Completed
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="h-8 bg-muted animate-pulse rounded-md w-3/4 mb-8" />
          <div className="h-32 bg-muted animate-pulse rounded-2xl" />
          <div className="h-64 bg-muted animate-pulse rounded-2xl" />
        </div>
      ) : isError ? (
        <div className="p-8 text-center bg-destructive/5 text-destructive rounded-2xl border border-destructive/20">
          <AlertCircle className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <h3 className="text-lg font-bold mb-2">Content Not Found</h3>
          <p>We couldn't load the study material for this subtopic.</p>
        </div>
      ) : content ? (
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-10"
        >
          {/* Explanation Section */}
          <section className="bg-card rounded-3xl p-6 sm:p-10 shadow-lg shadow-black/5 border border-border">
            <div className="flex items-center gap-3 mb-6 pb-6 border-b border-border">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                <BookOpen className="w-6 h-6" />
              </div>
              <h1 className="text-2xl sm:text-3xl font-display font-bold text-foreground">Concepts & Explanation</h1>
            </div>
            <div className="prose prose-slate max-w-none prose-p:text-muted-foreground prose-p:leading-relaxed prose-strong:text-foreground text-base sm:text-lg">
              <div className="whitespace-pre-line">{content.explanation}</div>
            </div>
          </section>

          {/* Q&A Sections */}
          <section className="space-y-6">
            <div className="flex items-center gap-2 px-2">
              <MessageSquare className="w-5 h-5 text-primary" />
              <h2 className="text-xl font-display font-bold text-foreground">Practice Questions</h2>
            </div>
            
            <QuestionBlock 
              label="2 Marks" 
              question={content.twoMarkQuestion} 
              answer={content.twoMarkAnswer} 
            />
            
            <QuestionBlock 
              label="5 Marks" 
              question={content.fiveMarkQuestion} 
              answer={content.fiveMarkAnswer} 
            />
          </section>

          {/* Observer Target */}
          <div ref={observerRef} className="h-10 w-full flex items-center justify-center">
             <div className="w-1/2 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
          </div>
        </motion.div>
      ) : null}
    </div>
  );
}
