// Web 客户端入口:挂载 React 应用。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("找不到 #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
