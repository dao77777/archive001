import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

// Web 客户端:标准 Vite 应用(React 19 + Tailwind v4)。
// `vp dev` 起开发服务器(页面 + HMR),`vp build` 出产物到 dist/。
//
// ⚠️ 页面归 Vite,**API 归宿主**(`src/host/`,Effect HTTP,默认 5180):
// dev 期 `/api/*` 代理过去,宿主就不用再托管 Vite 的中间件了。
// 端口与 `src/host/_constants.ts` 的 `HOST_PORT` 保持一致。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:5180" },
    },
  },
});
