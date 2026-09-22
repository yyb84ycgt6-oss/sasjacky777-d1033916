import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useSearchParams, useLocation } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { ThemeProvider } from "@/hooks/useTheme";
import { I18nProvider } from "@/game/i18n";
import { LocalAIProvider } from "@/providers/LocalAIProvider";
import { useEffect, lazy, Suspense } from "react";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import Sandbox from "./pages/Sandbox";
import OAuthConsent from "./pages/OAuthConsent";
import { SandboxBanner } from "./components/SandboxBanner";

import NotFound from "./pages/NotFound";
import Welcome from "./pages/Welcome";
import { ERU_ALIASES } from "./lib/routeManifest";
import RouteDebugOverlay from "./components/RouteDebugOverlay";
import { UniversalFloatingNavBar } from "./components/UniversalFloatingNavBar";
import { GlobalStickyNotes } from "./components/GlobalStickyNotes";
import { GuideDock } from "./components/GuideDock";
import { IndexPill } from "./components/IndexPill";

// Every page below is its own chunk, loaded when its route is first visited.
// They were all imported eagerly, which put ~50 pages — 3D scenes, editors,
// games, dashboards — into one 4.8 MB entry chunk that every visitor
// downloaded before the first screen could render. The pages kept eager are
// the ones a first visit actually lands on: the chat, sign-in, the landing
// page and the 404.
const Play = lazy(() => import("./pages/Play"));
const TelegramShell = lazy(() => import("./pages/TelegramShell"));
const Vault = lazy(() => import("./pages/Vault"));
const BotFoundry = lazy(() => import("./pages/BotFoundry"));
const BotSwarm = lazy(() => import("./pages/BotSwarm"));
const ApiKeyManager = lazy(() => import("./pages/ApiKeyManager"));
const GunitLayout = lazy(() => import("./pages/gunit/GunitLayout"));
const GunitDashboard = lazy(() => import("./pages/gunit/GunitDashboard"));
const GunitBotFactory = lazy(() => import("./pages/gunit/GunitBotFactory"));
const GunitChat = lazy(() => import("./pages/gunit/GunitChat"));
const GunitAgents = lazy(() => import("./pages/gunit/GunitAgents"));
const GunitUsers = lazy(() => import("./pages/gunit/GunitUsers"));
const GunitApiKeys = lazy(() => import("./pages/gunit/GunitApiKeys"));
const SphereCommand = lazy(() => import("./pages/SphereCommand"));
const JackieControl = lazy(() => import("./pages/JackieControl"));
const VeilOps = lazy(() => import("./pages/VeilOps"));
const MarvelsRace = lazy(() => import("./pages/MarvelsRace"));
const SentinelDashboard = lazy(() => import("./pages/SentinelDashboard"));
const SentinelBoard = lazy(() => import("./pages/SentinelBoard"));
const ApexHub = lazy(() => import("./pages/ApexHub"));
const AIProviders = lazy(() => import("./pages/AIProviders"));
const GrokStudio = lazy(() => import("./pages/GrokStudio"));
const RepairBay = lazy(() => import("./pages/RepairBay"));
const LocalBridge = lazy(() => import("./pages/LocalBridge"));
const PodStation = lazy(() => import("./pages/PodStation"));
const FoldSurface = lazy(() => import("./pages/FoldSurface"));
const JackyLive = lazy(() => import("./pages/JackyLive"));
const AgentLab = lazy(() => import("./pages/AgentLab"));
const AgentCompare = lazy(() => import("./pages/AgentCompare"));
const RouterMesh = lazy(() => import("./pages/RouterMesh"));
const RouterMeshDocs = lazy(() => import("./pages/RouterMeshDocs"));
const PCDesktop = lazy(() => import("./pages/PCDesktop"));
const PcApps = lazy(() => import("./pages/PcApps"));
const PathRouter = lazy(() => import("./pages/PathRouter"));
const Workstation = lazy(() => import("./pages/Workstation"));
const Guide = lazy(() => import("./pages/Guide"));
const JackieCore = lazy(() => import("./pages/JackieCore"));
const GithubSync = lazy(() => import("./pages/GithubSync"));
const LocalAITest = lazy(() => import("./pages/LocalAITest"));
const MicroAI = lazy(() => import("./pages/MicroAI"));
const IndexForge = lazy(() => import("./pages/IndexForge"));
const MicroBoard = lazy(() => import("./pages/MicroBoard"));
const NervousSystem = lazy(() => import("./pages/NervousSystem"));

const EruRouter = lazy(() => import("./eru/EruRouter"));

const VisualizerLab = lazy(() => import("./eru/VisualizerLab"));

const queryClient = new QueryClient();

/** Shown for the moment a route's chunk is loading — the same mark as the auth check. */
const RouteFallback = () => (
  <div className="min-h-screen bg-background flex items-center justify-center">
    <span className="font-mono text-4xl font-bold text-primary animate-pulse">J</span>
  </div>
);

const SandboxCatcher = ({ children }: { children: React.ReactNode }) => {
  const [params] = useSearchParams();
  const location = useLocation();
  useEffect(() => {
    // Sandbox flag is only honoured on the dedicated /sandbox route — it never
    // grants access to other protected routes or AI edge functions.
    if (params.get("sandbox") === "true" && location.pathname.startsWith("/sandbox")) {
      sessionStorage.setItem("sandbox", "true");
    }
  }, [params, location.pathname]);
  return <>{children}</>;
};

/**
 * Guards a route, and decides what a signed-out visitor sees instead.
 *
 * `fallback` exists because "/" is not like the others. Every protected route
 * showed `<Auth />` directly, so the first thing this app ever said to someone
 * who had not seen it before was "password" — no name, no explanation, no way
 * to find out what they would be signing in to. The root now falls back to the
 * landing page, which has a sign-in button on it. Everywhere else still goes
 * straight to the form, because someone deep-linked to /vault knows what this
 * is and wants to get in, not to read about it.
 */
const ProtectedRoute = ({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <span className="font-mono text-4xl font-bold text-primary animate-pulse">J</span>
      </div>
    );
  }

  if (!user) return <>{fallback ?? <Auth />}</>;
  return <>{children}</>;
};

const EruAliasRedirect = () => {
  const location = useLocation();
  return <Navigate to={`/eru${location.pathname}${location.search}${location.hash}`} replace />;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <AuthProvider>
        <LocalAIProvider>
          <I18nProvider>
            <TooltipProvider>
              <Toaster />
              <Sonner />
            <BrowserRouter>
              <SandboxBanner />
              <SandboxCatcher>
                <Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/auth" element={<Auth />} />
                    <Route path="/.lovable/oauth/consent" element={<OAuthConsent />} />
                    <Route path="/welcome" element={<Welcome />} />
                    <Route path="/sandbox" element={<Sandbox />} />
                    <Route path="/index" element={<Navigate to="/" replace />} />
                  <Route
                    path="/"
                    element={
                      <ProtectedRoute fallback={<Welcome />}>
                        <Index />
                      </ProtectedRoute>
                    }
                  />


                  <Route
                    path="/play"
                    element={
                      <ProtectedRoute>
                        <Play />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/core"
                    element={
                      <ProtectedRoute>
                        <JackieCore />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/path"
                    element={
                      <ProtectedRoute>
                        <PathRouter />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/workstation"
                    element={
                      <ProtectedRoute>
                        <Workstation />
                      </ProtectedRoute>
                    }
                  />
                  <Route path="/work" element={<Navigate to="/workstation" replace />} />
                  <Route
                    path="/guide"
                    element={
                      <ProtectedRoute>
                        <Guide />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/pc"
                    element={
                      <ProtectedRoute>
                        <PCDesktop />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/pc-apps"
                    element={
                      <ProtectedRoute>
                        <PcApps />
                      </ProtectedRoute>
                    }
                  />
                  <Route path="/hub" element={<TelegramShell />} />
                  <Route
                    path="/vault"
                    element={
                      <ProtectedRoute>
                        <Vault />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/bots"
                    element={
                      <ProtectedRoute>
                        <BotFoundry />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/swarm"
                    element={
                      <ProtectedRoute>
                        <BotSwarm />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/keys"
                    element={
                      <ProtectedRoute>
                        <ApiKeyManager />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/gunit"
                    element={
                      <ProtectedRoute>
                        <GunitLayout />
                      </ProtectedRoute>
                    }
                  >
                    <Route index element={<GunitDashboard />} />
                    <Route path="bots" element={<GunitBotFactory />} />
                    <Route path="chat" element={<GunitChat />} />
                    <Route path="agents" element={<GunitAgents />} />
                    <Route path="users" element={<GunitUsers />} />
                    <Route path="keys" element={<GunitApiKeys />} />
                  </Route>
                  <Route
                    path="/sphere"
                    element={
                      <ProtectedRoute>
                        <SphereCommand />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/control"
                    element={
                      <ProtectedRoute>
                        <JackieControl />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/veilops"
                    element={
                      <ProtectedRoute>
                        <VeilOps />
                      </ProtectedRoute>
                    }
                  />
                  <Route path="/marvels" element={<ProtectedRoute><MarvelsRace /></ProtectedRoute>} />
                  <Route path="/sentinel" element={<ProtectedRoute><SentinelDashboard /></ProtectedRoute>} />
                  <Route path="/sentinel/board" element={<ProtectedRoute><SentinelBoard /></ProtectedRoute>} />
                  <Route path="/apex" element={<ProtectedRoute><ApexHub /></ProtectedRoute>} />
                  <Route path="/providers" element={<ProtectedRoute><AIProviders /></ProtectedRoute>} />
                  <Route path="/grok" element={<ProtectedRoute><GrokStudio /></ProtectedRoute>} />
                  <Route path="/repair" element={<ProtectedRoute><RepairBay /></ProtectedRoute>} />
                  <Route path="/bridge" element={<ProtectedRoute><LocalBridge /></ProtectedRoute>} />
                  <Route path="/pods" element={<ProtectedRoute><PodStation /></ProtectedRoute>} />
                  <Route path="/eyepod" element={<ProtectedRoute><PodStation /></ProtectedRoute>} />
                  <Route path="/pods/surface" element={<ProtectedRoute><FoldSurface /></ProtectedRoute>} />
                  <Route path="/eyepod/surface" element={<ProtectedRoute><FoldSurface /></ProtectedRoute>} />
                  <Route path="/jacky-live" element={<ProtectedRoute><JackyLive /></ProtectedRoute>} />
                  <Route path="/agent-lab" element={<ProtectedRoute><AgentLab /></ProtectedRoute>} />
                  <Route path="/agent-compare" element={<ProtectedRoute><AgentCompare /></ProtectedRoute>} />
                  <Route path="/mesh" element={<ProtectedRoute><RouterMesh /></ProtectedRoute>} />
                  <Route path="/mesh/docs" element={<ProtectedRoute><RouterMeshDocs /></ProtectedRoute>} />
                  <Route path="/nervous" element={<ProtectedRoute><NervousSystem /></ProtectedRoute>} />
                  <Route path="/github" element={<ProtectedRoute><GithubSync /></ProtectedRoute>} />
                  <Route path="/local-ai" element={<ProtectedRoute><LocalAITest /></ProtectedRoute>} />
                  <Route path="/forge" element={<ProtectedRoute><IndexForge /></ProtectedRoute>} />
                  <Route path="/micro" element={<ProtectedRoute><MicroAI /></ProtectedRoute>} />
                  <Route path="/micro/board" element={<ProtectedRoute><MicroBoard /></ProtectedRoute>} />
                  <Route

                    path="/eru/visualizers"
                    element={
                      <ProtectedRoute>
                        <Suspense fallback={null}><VisualizerLab /></Suspense>
                      </ProtectedRoute>
                    }
                  />
                  {ERU_ALIASES.map(({ path }) => (
                    <Route
                      key={`eru-alias-${path}`}
                      path={path}
                      element={
                        <ProtectedRoute>
                          <EruAliasRedirect />
                        </ProtectedRoute>
                      }
                    />
                  ))}

                  <Route
                    path="/eru/*"
                    element={
                      <ProtectedRoute>
                        <Suspense fallback={null}><EruRouter /></Suspense>
                      </ProtectedRoute>
                    }
                  />
                  <Route path="*" element={<NotFound />} />
                </Routes>
                </Suspense>
              <RouteDebugOverlay />

              </SandboxCatcher>
              <UniversalFloatingNavBar />
              <GlobalStickyNotes />
              <GuideDock />
              <IndexPill />
            </BrowserRouter>
            </TooltipProvider>
          </I18nProvider>
        </LocalAIProvider>
      </AuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
