import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, Lock, KeyRound, ArrowLeft, Check } from "lucide-react";
import { motion } from "framer-motion";
import { useCompleteFirstLoginSetup } from "@/api-client";
import { getStoredUser, removeStoredUser, setStoredUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function FirstLoginSetup() {
  const [, setLocation] = useLocation();
  const user = getStoredUser();
  const [collegeId, setCollegeId] = useState(user?.id ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [securityQuestion, setSecurityQuestion] = useState("");
  const [securityAnswer, setSecurityAnswer] = useState("");
  const [success, setSuccess] = useState(false);
  const setupMutation = useCompleteFirstLoginSetup();

  useEffect(() => {
    const me = getStoredUser();
    if (!me) {
      setLocation("/login");
      return;
    }
    if ((me.role !== "student" && me.role !== "super_student") || !me.onboardingRequired) {
      setLocation(me.role === "admin" ? "/admin" : "/home");
    }
  }, [setLocation]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !collegeId.trim() ||
      !currentPassword.trim() ||
      !newPassword.trim() ||
      !securityQuestion.trim() ||
      !securityAnswer.trim()
    ) {
      return;
    }

    setupMutation.mutate(
      {
        collegeId: collegeId.trim(),
        currentPassword: currentPassword.trim(),
        newPassword: newPassword.trim(),
        securityQuestion: securityQuestion.trim(),
        securityAnswer: securityAnswer.trim(),
      },
      {
        onSuccess: () => {
          const existing = getStoredUser();
          if (existing) {
            setStoredUser({
              ...existing,
              onboardingRequired: false,
              mustResetPassword: false,
              securityQuestionSet: true,
            });
          }
          setSuccess(true);
          setTimeout(() => setLocation("/home"), 1200);
        },
      },
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
              <ShieldCheck className="w-8 h-8" />
            </div>
          </div>

          <div className="text-center mb-8">
            <h1 className="text-2xl font-display font-bold text-foreground">First Login Setup</h1>
            <p className="mt-2 text-muted-foreground text-sm">
              Set your new password and security question to continue.
            </p>
          </div>

          {success ? (
            <div className="text-center py-8">
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                <Check className="w-8 h-8 text-green-600" />
              </div>
              <p className="text-foreground font-semibold">Setup completed!</p>
              <p className="text-sm text-muted-foreground mt-1">Taking you to your dashboard...</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground">College Roll ID</label>
                <Input value={collegeId} onChange={(e) => setCollegeId(e.target.value)} className="bg-white/50 focus:bg-white" />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Lock className="w-4 h-4 text-primary" />
                  Current Password
                </label>
                <Input
                  type="password"
                  placeholder="Your temporary password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
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

              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-primary" />
                  Security Question
                </label>
                <Input
                  placeholder="e.g. What is your favorite teacher's name?"
                  value={securityQuestion}
                  onChange={(e) => setSecurityQuestion(e.target.value)}
                  className="bg-white/50 focus:bg-white"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-primary" />
                  Security Answer
                </label>
                <Input
                  placeholder="Enter your answer"
                  value={securityAnswer}
                  onChange={(e) => setSecurityAnswer(e.target.value)}
                  className="bg-white/50 focus:bg-white"
                />
              </div>

              <Button
                type="submit"
                className="w-full h-14 text-base mt-4"
                disabled={
                  setupMutation.isPending ||
                  !collegeId.trim() ||
                  !currentPassword.trim() ||
                  !newPassword.trim() ||
                  !securityQuestion.trim() ||
                  !securityAnswer.trim()
                }
              >
                {setupMutation.isPending ? "Saving..." : "Complete Setup"}
              </Button>

              {setupMutation.isError && (
                <p className="text-sm text-destructive text-center font-medium p-3 bg-destructive/10 rounded-xl">
                  Could not complete setup. Please verify your current password.
                </p>
              )}

              <p className="text-xs text-muted-foreground text-center leading-relaxed">
                Security note: Do not share your password or security answer with anyone.
                Use a strong password and a strong security question and answer.
              </p>
            </form>
          )}

          <div className="mt-6 text-center">
            <button
              type="button"
              className="text-sm text-primary hover:underline inline-flex items-center gap-1"
              onClick={() => {
                removeStoredUser();
                setLocation("/login");
              }}
            >
              <ArrowLeft className="w-3 h-3" />
              Sign in with different account
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
