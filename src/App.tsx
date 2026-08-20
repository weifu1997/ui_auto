import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "./router";
import { App as AntdApp, ConfigProvider, Spin, theme as antdTheme } from "antd";
import { applyTheme, themePalettes, useThemeStore } from "./theme-mode";
import { restorePlatformSession } from "./platform-api";
import { storePlatformSession } from "./platform-context";
import type { PlatformSession } from "./platform-api";
import { LoginPage } from "./LoginPage";
import { ServerWorkspaceSynchronizer } from "./ServerWorkspaceSynchronizer";
import "./App.css";
import "./responsive.css";
import { AntdFeedbackBridge } from "./antd-feedback";
import {
  PageHeading,
  ProjectLayout,
  statusMeta,
  statusTag,
} from "./pages/shared";

const LazyFlowEditor = lazy(() => import("./FlowEditorPage"));
const LazyRunDetail = lazy(() => import("./RunDetailPage"));
const LazyProjectsPage = lazy(() =>
  import("./pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })),
);
const LazyTemplatesPage = lazy(() =>
  import("./pages/TemplatesPage").then((m) => ({ default: m.TemplatesPage })),
);
const LazyProjectShell = lazy(() =>
  import("./pages/ProjectShell").then((m) => ({ default: m.ProjectShell })),
);
const LazyWorkspaceAdministrationPage = lazy(() =>
  import("./pages/WorkspaceAdministrationPage").then((m) => ({ default: m.WorkspaceAdministrationPage })),
);
const LazyInvitationAcceptPage = lazy(() =>
  import("./InvitationAcceptPage").then((m) => ({ default: m.InvitationAcceptPage })),
);
const LazyPasswordResetPage = lazy(() =>
  import("./PasswordResetPage").then((m) => ({ default: m.PasswordResetPage })),
);

const routeFallback = (
  <div className="route-loading"><Spin size="large" /></div>
);

// 主题宿主：跟随系统或手动模式，同步 antd 算法与 <html data-theme>。
function ThemeHost({ children }: { children: React.ReactNode }) {
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    applyTheme(useThemeStore.getState().mode),
  );

  useEffect(() => {
    const sync = () => setResolved(applyTheme(useThemeStore.getState().mode));
    sync();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => useThemeStore.subscribe((state) => setResolved(applyTheme(state.mode))), []);

  const palette = themePalettes[resolved];
  return (
    <ConfigProvider
      theme={{
        algorithm: resolved === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: palette.colorPrimary,
          colorInfo: palette.colorInfo,
          colorSuccess: palette.colorSuccess,
          colorWarning: palette.colorWarning,
          colorError: palette.colorError,
          colorTextBase: palette.colorTextBase,
          colorBgBase: palette.colorBgBase,
          colorBgLayout: palette.colorBgLayout,
          colorBgContainer: palette.colorBgBase,
          colorBgElevated: palette.colorBgBase,
          borderRadius: 8,
          controlHeight: 36,
          fontFamily: "var(--font-sans)",
          // 0.2s：比 antd 默认 0.3s 更干脆；同时避免抽屉/弹层关闭动画与顶栏交互重叠（时序竞态）。
          motionDurationSlow: "0.2s",
        },
        components: {
          Table: {
            headerBg: palette.surface2,
            headerSplitColor: palette.separator,
            rowHoverBg: palette.surface2,
            cellPaddingBlock: 12,
          },
          Modal: { contentBg: palette.colorBgBase, headerBg: palette.colorBgBase },
          Drawer: { colorBgElevated: palette.colorBgBase },
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}

function App() {
  return (
    <ThemeHost>
      <AntdApp>
        <AntdFeedbackBridge />
        <Routes>
          <Route
            path="/invitations/accept"
            element={<Suspense fallback={routeFallback}><LazyInvitationAcceptPage /></Suspense>}
          />
          <Route
            path="/password-resets/accept"
            element={<Suspense fallback={routeFallback}><LazyPasswordResetPage /></Suspense>}
          />
          <Route path="*" element={<ApplicationSessionGate><AuthenticatedApplication /></ApplicationSessionGate>} />
        </Routes>
      </AntdApp>
    </ThemeHost>
  );
}

function AuthenticatedApplication() {
  return (
    <>
      <ServerWorkspaceSynchronizer />
      <Routes>
            <Route path="/" element={<Navigate to="/projects" replace />} />
            <Route
              path="/projects"
              element={<Suspense fallback={routeFallback}><LazyProjectsPage /></Suspense>}
            />
            <Route
              path="/templates"
              element={<Suspense fallback={routeFallback}><LazyTemplatesPage /></Suspense>}
            />
            <Route
              path="/workspace/administration"
              element={<Suspense fallback={routeFallback}><LazyWorkspaceAdministrationPage /></Suspense>}
            />
            <Route
              path="/project/:projectId/:section"
              element={<Suspense fallback={routeFallback}><LazyProjectShell /></Suspense>}
            />
            <Route
              path="/project/:projectId/flows/:flowId/edit"
              element={
                <Suspense fallback={routeFallback}>
                  <LazyFlowEditor />
                </Suspense>
              }
            />
            <Route
              path="/project/:projectId/runs/:runId"
              element={
                <Suspense fallback={routeFallback}>
                  <LazyRunDetail
                    ProjectLayout={ProjectLayout}
                    PageHeading={PageHeading}
                    statusTag={statusTag}
                    statusMeta={statusMeta}
                  />
                </Suspense>
              }
            />
            <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </>
  );
}

function ApplicationSessionGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "authenticated" | "anonymous">("checking");

  useEffect(() => {
    let active = true;
    const restore = () => {
      setState("checking");
      void restorePlatformSession()
        .then((session) => {
          if (!active) return;
          storePlatformSession(session);
          setState("authenticated");
        })
        .catch(() => {
          if (!active) return;
          storePlatformSession();
          setState("anonymous");
        });
    };
    const expire = () => {
      setState((current) => {
        if (current === "anonymous") return current;
        storePlatformSession();
        return "anonymous";
      });
    };
    restore();
    window.addEventListener("autoflow-auth-expired", expire);
    return () => {
      active = false;
      window.removeEventListener("autoflow-auth-expired", expire);
    };
  }, []);

  if (state === "checking") return <div className="route-loading"><Spin size="large" /></div>;
  if (state === "anonymous") return <LoginPage onAuthenticated={(session: PlatformSession) => {
    storePlatformSession(session);
    setState("authenticated");
  }} />;
  return children;
}

export default App;
