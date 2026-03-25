import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { Layout } from "@/components/layout";
import { getStoredUser } from "@/lib/auth";

import Login from "@/pages/login";
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

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const user = getStoredUser();
  if (!user) return <Redirect to="/login" />;
  return <Component />;
}

function ProtectedHome() { return <ProtectedRoute component={Home} />; }
function ProtectedRoadmap() { return <ProtectedRoute component={Roadmap} />; }
function ProtectedSubtopic() { return <ProtectedRoute component={Subtopic} />; }
function ProtectedAdmin() { return <ProtectedRoute component={Admin} />; }

function AppRouter() {
  return (
    <Layout>
      <Switch>
        <Route path="/login" component={Login} />
        <Route path="/" component={ProtectedHome} />
        <Route path="/roadmap" component={ProtectedRoadmap} />
        <Route path="/subtopic/:id" component={ProtectedSubtopic} />
        <Route path="/admin" component={ProtectedAdmin} />
        <Route>
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
            <h1 className="text-4xl font-display font-bold text-foreground mb-4">404</h1>
            <p className="text-muted-foreground mb-6">The page you're looking for doesn't exist.</p>
            <a href="/" className="text-primary hover:underline font-medium">Return Home</a>
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
