// Winterlock's React entry. Written with Codex (OpenAI), directed by Vicky.
import {
  Component,
  Suspense,
  lazy,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletProvider, useWallet } from "./lib/state";
import { Shell, WalletGate } from "./components/common";
import "./styles.css";

const queries = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 1_000 },
    mutations: { retry: false },
  },
});
const WalletsPage = lazy(() =>
  import("./pages/wallets").then((m) => ({ default: m.WalletsPage })),
);
const HotColdPage = lazy(() =>
  import("./pages/hot-cold").then((m) => ({ default: m.HotColdPage })),
);
const AgentPage = lazy(() =>
  import("./pages/agent").then((m) => ({ default: m.AgentPage })),
);
const SessionPage = lazy(() =>
  import("./pages/session").then((m) => ({ default: m.SessionPage })),
);
function App() {
  const { pathname } = useLocation();
  const { wallet } = useWallet();
  const screen = pathname.includes("hot-cold")
    ? "hot-cold"
    : pathname.includes("agent")
      ? "agent"
      : pathname.includes("session")
        ? "session"
        : "index";
  const key = `${wallet?.address}:${wallet?.epoch}`;
  return (
    <Shell screen={screen}>
      <Suspense
        fallback={
          <main id="workspace">
            <p className="empty-state" role="status">
              Loading workspace…
            </p>
          </main>
        }
      >
        <Routes>
          <Route path="/" element={<WalletsPage />} />
          <Route path="/index.html" element={<WalletsPage />} />
          <Route
            path="/hot-cold.html"
            element={
              <WalletGate>
                <HotColdPage key={key} />
              </WalletGate>
            }
          />
          <Route
            path="/agent.html"
            element={
              <WalletGate>
                <AgentPage key={key} />
              </WalletGate>
            }
          />
          <Route
            path="/session.html"
            element={
              <WalletGate>
                <SessionPage key={key} />
              </WalletGate>
            }
          />
          <Route
            path="*"
            element={
              <main id="workspace">
                <h1>Page not found</h1>
                <a href="/">Go to wallets</a>
              </main>
            }
          />
        </Routes>
      </Suspense>
    </Shell>
  );
}
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Never log wallet payloads. */
  }
  render() {
    return this.state.error ? (
      <main>
        <h1>The workspace could not render</h1>
        <p>
          Your transaction state is held by the backend. Reload to retrieve the
          latest records before submitting again.
        </p>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <QueryClientProvider client={queries}>
      <BrowserRouter>
        <WalletProvider>
          <App />
        </WalletProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </ErrorBoundary>,
);
