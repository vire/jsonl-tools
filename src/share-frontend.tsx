/**
 * Entry point for the recipient viewer (src/share.html). This bundle is
 * deliberately analytics-free (R22): no third-party script may run on a surface
 * that holds a decryption key.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ShareViewer } from "./share-viewer";

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <ShareViewer />
  </StrictMode>
);

if (import.meta.hot) {
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  createRoot(elem).render(app);
}
