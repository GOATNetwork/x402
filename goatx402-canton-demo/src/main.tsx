import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { readEnv } from "./lib/env";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("client-web: #root element missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App env={readEnv(import.meta.env)} />
  </StrictMode>,
);
