import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { BookOpen, GraduationCap, Lock, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";
import { useLogin } from "@workspace/api-client-react";
import { setStoredUser, getStoredUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Login() {
  const [, setLocation] = useLocation();
  const [collegeId, setCollegeId] = useState("");
  const [password, setPassword] = useState("1234567890"); // Hardcoded as per req
  const loginMutation = useLogin();

  useEffect(() => {
    if (getStoredUser()) {
      setLocation("/");
    }
  }, [setLocation]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!collegeId.trim()) return;

    loginMutation.mutate(
      { data: { collegeId, password } },
      {
        onSuccess: (data) => {
          setStoredUser(data);
          setLocation("/");
        }
      }
    );
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background relative overflow-hidden">
      {/* Decorative background image generated via requirements.yaml */}
      <div className="absolute inset-0 z-0 opacity-[0.15] mix-blend-multiply pointer-events-none">
        <img 
          src={`${import.meta.env.BASE_URL}images/academic-bg.png`} 
          alt="Abstract academic background" 
          className="w-full h-full object-cover"
        />
      </div>

      <div className="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-primary/5 blur-[120px]" />
      <div className="absolute -bottom-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-blue-400/5 blur-[120px]" />

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-md px-4 relative z-10"
      >
        <div className="bg-white/80 backdrop-blur-xl rounded-3xl p-8 sm:p-10 border border-white shadow-[0_8px_40px_rgb(0,0,0,0.06)]">
          <div className="flex justify-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center text-white shadow-xl shadow-primary/25">
              <BookOpen className="w-8 h-8" />
            </div>
          </div>
          
          <div className="text-center mb-8">
            <h1 className="text-3xl font-display font-bold text-foreground">Welcome to AuraPrep</h1>
            <p className="mt-2 text-muted-foreground text-sm">Sign in with your college credentials to access your exam roadmap.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                <GraduationCap className="w-4 h-4 text-primary" />
                College Roll ID
              </label>
              <Input
                placeholder="e.g. 21BXX0000"
                value={collegeId}
                onChange={(e) => setCollegeId(e.target.value)}
                autoFocus
                className="bg-white/50 focus:bg-white"
              />
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Lock className="w-4 h-4 text-primary" />
                Password
              </label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-white/50 focus:bg-white text-muted-foreground"
                readOnly
              />
              <p className="text-xs text-muted-foreground text-right">Password is preset by your institution</p>
            </div>

            <Button 
              type="submit" 
              className="w-full h-14 text-base mt-4 group"
              disabled={loginMutation.isPending || !collegeId.trim()}
            >
              {loginMutation.isPending ? "Authenticating..." : "Access Roadmap"}
              {!loginMutation.isPending && (
                <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
              )}
            </Button>

            {loginMutation.isError && (
              <p className="text-sm text-destructive text-center font-medium p-3 bg-destructive/10 rounded-xl">
                Failed to authenticate. Please check your ID.
              </p>
            )}
          </form>
        </div>
      </motion.div>
    </div>
  );
}
