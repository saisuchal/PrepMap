import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { Layout } from "@/components/layout";
import { getStoredUser } from "@/lib/auth";

import Login from "@/pages/login";
import ResetPassword from "@/pages/reset-password";
import Home from "@/pages/home";
import Roadmap from "@/pages/roadmap";
import Subtopic from "@/pages/subtopic";
import Admin from "@/pages/admin";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    }
  }
});

function ProtectedRoute({ component: Component, requireRole }: { component: React.ComponentType; requireRole?: "admin" | "student" }) {
  const user = getStoredUser();
  if (!user) return <Redirect to="/login" />;
  if (requireRole && user.role !== requireRole) {
    return <Redirect to={user.role === "admin" ? "/admin" : "/home"} />;
  }
  return <Component />;
}

function RootRedirect() {
  const user = getStoredUser();
  if (!user) return <Redirect to="/login" />;
  return <Redirect to={user.role === "admin" ? "/admin" : "/home"} />;
}

function ProtectedHome() { return <ProtectedRoute component={Home} requireRole="student" />; }
function ProtectedRoadmap() { return <ProtectedRoute component={Roadmap} requireRole="student" />; }
function ProtectedSubtopic() { return <ProtectedRoute component={Subtopic} requireRole="student" />; }
function ProtectedAdmin() { return <ProtectedRoute component={Admin} requireRole="admin" />; }

function AppRouter() {
  return (
    <Layout>
      <Switch>
        <Route path="/login" component={Login} />
        <Route path="/reset-password" component={ResetPassword} />
        <Route path="/home" component={ProtectedHome} />
        <Route path="/roadmap" component={ProtectedRoadmap} />
        <Route path="/subtopic/:id" component={ProtectedSubtopic} />
        <Route path="/admin" component={ProtectedAdmin} />
        <Route path="/" component={RootRedirect} />
        <Route>
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
            <h1 className="text-4xl font-display font-bold text-foreground mb-4">404</h1>
            <p className="text-muted-foreground mb-6">The page you're looking for doesn't exist.</p>
            <a href="/home" className="text-primary hover:underline font-medium">Return Home</a>
          </div>
        </Route>
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppRouter />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
