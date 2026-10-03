import { AppMotion } from "../components/motion/Motion";
import FlowChainApp from "./FlowChainApp";
import { createBrowserRouter, RouterProvider } from "react-router";
import { UnsavedChangesProvider } from "../components/navigation/UnsavedChangesProvider";
import { I18nProvider } from "../i18n/I18n";

const router = createBrowserRouter([{
  path: "*",
  element: <AppMotion><I18nProvider><UnsavedChangesProvider><FlowChainApp /></UnsavedChangesProvider></I18nProvider></AppMotion>,
}]);

export default function App() {
  return <RouterProvider router={router} />;
}
