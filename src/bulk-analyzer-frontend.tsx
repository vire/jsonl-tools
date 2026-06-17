import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BulkAnalyzerApp } from "./bulk-analyzer-app";

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <BulkAnalyzerApp />
  </StrictMode>
);

if (import.meta.hot) {
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  createRoot(elem).render(app);
}
