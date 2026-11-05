import React from "react";
import { AppMotion } from "../components/motion/Motion";
import FlowChainApp from "./FlowChainApp";
import { createBrowserRouter, RouterProvider } from "react-router";
import { UnsavedChangesProvider } from "../components/navigation/UnsavedChangesProvider";
import { I18nProvider } from "../i18n/I18n";

// The last guard: an error no page caught (or a part of the app that failed to
// load) shows a message and Reload instead of a white page. It sits outside
// the language provider, so it reads the page's language attribute.
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error("FlowChain could not render", error);
  }

  render() {
    return this.state.failed ? <AppErrorFallback /> : this.props.children;
  }
}

function AppErrorFallback() {
  const english = typeof document === "undefined" || document.documentElement.lang !== "zh-CN";
  return (
    <div role="alert" data-testid="app-error" className="flex h-full items-center justify-center p-4 text-center" style={{ background: "#f5f5f7", color: "#1d1d1f" }}>
      <div className="max-w-md">
        <h1 className="text-base font-semibold">{english ? "FlowChain could not load this page" : "FlowChain 无法加载此页面"}</h1>
        <p className="mt-2 text-sm" style={{ color: "#6e6e73" }}>
          {english ? "Your data is safe. Reload the page to try again; if it keeps happening, check your connection." : "数据不受影响。请重新加载页面；如仍出现，请检查网络连接。"}
        </p>
        <button type="button" onClick={() => window.location.reload()} className="mt-4 h-9 rounded-lg px-4 text-sm font-semibold text-white" style={{ background: "#0071e3" }}>
          {english ? "Reload" : "重新加载"}
        </button>
      </div>
    </div>
  );
}

const router = createBrowserRouter([{
  path: "*",
  // An error inside the routed app shows the same message, not the router's.
  errorElement: <AppErrorFallback />,
  element: <AppMotion><I18nProvider><UnsavedChangesProvider><FlowChainApp /></UnsavedChangesProvider></I18nProvider></AppMotion>,
}]);

export default function App() {
  return <AppErrorBoundary><RouterProvider router={router} /></AppErrorBoundary>;
}
