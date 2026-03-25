import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { LogOut, Zap, User, Settings, Home } from "lucide-react";
import { getStoredUser, removeStoredUser } from "@/lib/auth";
import { Button } from "./ui/button";

export function Layout({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  const user = getStoredUser();

  const handleLogout = () => {
    removeStoredUser();
    setLocation("/login");
  };

  if (!user) return <>{children}</>;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-50 w-full glass-panel border-b border-border/40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link href={user.role === "admin" ? "/admin" : "/"} className="flex items-center gap-2 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center text-white shadow-lg shadow-primary/20 group-hover:scale-105 transition-transform">
              <Zap className="w-5 h-5" />
            </div>
            <span className="font-display font-bold text-xl tracking-tight text-foreground">
              GP-<span className="text-primary">Max</span>
            </span>
          </Link>
          
          <div className="flex items-center gap-4">
            {user.role === "admin" ? (
              <Link href="/admin" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
                <Settings className="w-4 h-4" />
                <span className="hidden sm:inline">Dashboard</span>
              </Link>
            ) : (
              <Link href="/" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
                <Home className="w-4 h-4" />
                <span className="hidden sm:inline">Home</span>
              </Link>
            )}
            
            <div className="h-6 w-px bg-border mx-2"></div>
            
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex flex-col items-end">
                <span className="text-sm font-semibold leading-none">{user.id}</span>
                <span className="text-xs text-muted-foreground leading-none mt-1">
                  {user.role === "admin" ? "Admin" : `${user.branch} • Year ${user.year}`}
                </span>
              </div>
              <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center border border-border text-primary">
                <User className="w-4 h-4" />
              </div>
              <Button variant="ghost" size="icon" onClick={handleLogout} className="text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {children}
      </main>
    </div>
  );
}
