import { defineConfig } from "vite-plus";

/** 打包:一次性 CLI,一个入口。 */
export default defineConfig({
  pack: {
    entry: ["src/main.ts"],
    format: ["esm"],
    platform: "node",
    sourcemap: true,
  },
});
