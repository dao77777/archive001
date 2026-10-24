import { defineConfig } from "vite-plus";

/** 打包:交互式客户端一个入口。 */
export default defineConfig({
  pack: {
    entry: ["src/main.ts"],
    format: ["esm"],
    platform: "node",
    sourcemap: true,
  },
});
