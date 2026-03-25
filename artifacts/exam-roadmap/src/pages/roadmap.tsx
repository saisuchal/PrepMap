import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, Folder, FileText, ArrowLeft, Layers, CheckCircle2 } from "lucide-react";
import { useGetNodes } from "@workspace/api-client-react";
import { buildTree, type TreeNode } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function NodeItem({ node, depth = 0, context }: { node: TreeNode; depth?: number; context?: string }) {
  const [isOpen, setIsOpen] = useState(depth === 0);
  const [, setLocation] = useLocation();

  const isSubtopic = node.type === "subtopic";
  const hasChildren = node.children && node.children.length > 0;
  
  const isTracked = isSubtopic && sessionStorage.getItem(`tracked_${node.id}`);

  const handleClick = () => {
    if (isSubtopic) {
      setLocation(`/subtopic/${node.id}${context ? `?${context}&topicId=${node.parentId || ""}` : ""}`);
    } else if (hasChildren) {
      setIsOpen(!isOpen);
    }
  };

  return (
    <div className="w-full">
      <div 
        className={`
          flex items-center gap-3 py-3 px-4 rounded-xl cursor-pointer transition-all duration-200 group
          ${isSubtopic ? 'hover:bg-primary/5 hover:text-primary' : 'hover:bg-secondary/50'}
          ${depth === 0 ? 'bg-card border border-border shadow-sm mb-3' : ''}
          ${depth === 1 ? 'mt-1' : ''}
        `}
        style={{ marginLeft: depth > 0 ? `${depth * 1.5}rem` : '0' }}
        onClick={handleClick}
      >
        <div className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors ${isOpen && !isSubtopic ? 'bg-primary/10 text-primary' : 'text-muted-foreground group-hover:text-primary'}`}>
          {!isSubtopic ? (
            <ChevronRight className={`w-4 h-4 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`} />
          ) : (
            <FileText className="w-4 h-4" />
          )}
        </div>
        
        <div className="flex-1 flex items-center justify-between">
          <span className={`font-medium ${depth === 0 ? 'text-lg text-foreground font-semibold' : 'text-foreground/80'}`}>
            {node.title}
          </span>
          
          {isSubtopic && isTracked && (
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          )}
          
          {!isSubtopic && (
            <span className="text-xs font-semibold text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
              {node.children.length} {node.children.length === 1 ? 'item' : 'items'}
            </span>
          )}
        </div>
      </div>

      <AnimatePresence>
        {isOpen && hasChildren && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className={`relative ${depth === 0 ? 'mb-4 border-l-2 border-border/50 ml-7 pl-2' : ''}`}>
              {node.children.map(child => (
                <NodeItem key={child.id} node={child} depth={depth + 1} context={context} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Roadmap() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const configId = searchParams.get("configId");
  const universityId = searchParams.get("universityId") || "";
  const year = searchParams.get("year") || "";
  const branch = searchParams.get("branch") || "";
  const exam = searchParams.get("exam") || "";
  const subject = searchParams.get("subject") || "Syllabus Roadmap";

  const { data: nodes, isLoading, isError } = useGetNodes({ configId: configId! }, {
    query: { enabled: !!configId }
  });

  const tree = useMemo(() => {
    if (!nodes) return [];
    return buildTree(nodes);
  }, [nodes]);

  if (!configId) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground mb-4">No configuration selected.</p>
        <Button onClick={() => setLocation("/")}>Go Back</Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto pb-20">
      <Button variant="ghost" className="mb-6 -ml-4 text-muted-foreground" onClick={() => setLocation("/")}>
        <ArrowLeft className="w-4 h-4 mr-2" /> Back to Selection
      </Button>

      <div className="mb-8">
        <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-3">
          <Layers className="w-8 h-8 text-primary" />
          {subject}
        </h1>
        <p className="text-muted-foreground mt-2">Expand the units to explore topics and access study materials.</p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 bg-muted animate-pulse rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <div className="p-6 bg-destructive/10 text-destructive rounded-xl border border-destructive/20 font-medium">
          Failed to load roadmap nodes. Please try again.
        </div>
      ) : tree.length === 0 ? (
        <div className="text-center py-20 bg-card rounded-2xl border border-border border-dashed">
          <Folder className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-20" />
          <p className="text-muted-foreground">No content available for this configuration yet.</p>
        </div>
      ) : (
        <div className="space-y-1">
          {tree.map(node => (
            <NodeItem key={node.id} node={node} context={`universityId=${universityId}&year=${year}&branch=${branch}&exam=${exam}&configId=${configId}`} />
          ))}
        </div>
      )}
    </div>
  );
}
