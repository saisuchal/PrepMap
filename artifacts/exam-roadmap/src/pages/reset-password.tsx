import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Zap, Lock, ArrowLeft, Check, KeyRound } from "lucide-react";
import { motion } from "framer-motion";
import { useGetSecurityQuestion, useResetPasswordWithSecurity } from "@/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const [collegeId, setCollegeId] = useState("");
  const [securityAnswer, setSecurityAnswer] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [success, setSuccess] = useState(false);
  const [lookupId, setLookupId] = useState<string | null>(null);
  const { data: securityData, isFetching: isFetchingQuestion, isError: isQuestionError } = useGetSecurityQuestion(lookupId, {
    enabled: !!lookupId,
    retry: false,
  });
  const resetMutation = useResetPasswordWithSecurity();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!collegeId.trim() || !securityAnswer.trim() || !newPassword.trim()) return;

    resetMutation.mutate(
      { collegeId: collegeId.trim(), securityAnswer: securityAnswer.trim(), newPassword: newPassword.trim() },
      {
        onSuccess: () => {
          setSuccess(true);
          setTimeout(() => setLocation("/login"), 2000);
        }
      }
    );
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background relative overflow-hidden">
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
              <Zap className="w-8 h-8" />
            </div>
          </div>
          
          <div className="text-center mb-8">
            <h1 className="text-2xl font-display font-bold text-foreground">Reset Password</h1>
            <p className="mt-2 text-muted-foreground text-sm">Answer your security question and choose a new password.</p>
          </div>

          {success ? (
            <div className="text-center py-8">
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                <Check className="w-8 h-8 text-green-600" />
              </div>
              <p className="text-foreground font-semibold">Password updated!</p>
              <p className="text-sm text-muted-foreground mt-1">Redirecting to login...</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground">College Roll ID</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="e.g. STU001"
                    value={collegeId}
                    onChange={(e) => setCollegeId(e.target.value)}
                    autoFocus
                    className="bg-white/50 focus:bg-white"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!collegeId.trim() || isFetchingQuestion}
                    onClick={() => setLookupId(collegeId.trim())}
                  >
                    {isFetchingQuestion ? "Checking..." : "Get Question"}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-primary" />
                  Security Question
                </label>
                <Input
                  value={securityData?.securityQuestion ?? ""}
                  readOnly
                  placeholder="Get question using College Roll ID"
                  className="bg-slate-100"
                />
                {isQuestionError && (
                  <p className="text-xs text-destructive">Security question not found for this account.</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-primary" />
                  Security Answer
                </label>
                <Input
                  placeholder="Enter your security answer"
                  value={securityAnswer}
                  onChange={(e) => setSecurityAnswer(e.target.value)}
                  className="bg-white/50 focus:bg-white"
                />
              </div>
              
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Lock className="w-4 h-4 text-primary" />
                  New Password
                </label>
                <Input
                  type="password"
                  placeholder="Choose a new password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="bg-white/50 focus:bg-white"
                />
              </div>

              <Button 
                type="submit" 
                className="w-full h-14 text-base mt-4"
                disabled={resetMutation.isPending || !collegeId.trim() || !securityData?.securityQuestion || !securityAnswer.trim() || !newPassword.trim()}
              >
                {resetMutation.isPending ? "Updating..." : "Update Password"}
              </Button>

              {resetMutation.isError && (
                <p className="text-sm text-destructive text-center font-medium p-3 bg-destructive/10 rounded-xl">
                  Failed to reset password. Check your security answer.
                </p>
              )}

              <p className="text-xs text-muted-foreground text-center leading-relaxed">
                Security note: Do not share your password or security answer with anyone.
                Use a strong password and a strong security answer.
              </p>
            </form>
          )}

          <div className="mt-6 text-center">
            <Link href="/login" className="text-sm text-primary hover:underline inline-flex items-center gap-1">
              <ArrowLeft className="w-3 h-3" />
              Back to login
            </Link>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

