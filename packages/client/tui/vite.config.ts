import { defineConfig } from "vite-plus";

/** 打包:一个入口(骨架阶段只是占位)。 */
export default defineConfig({
  pack: {
    entry: ["src/main.ts"],
    format: ["esm"],
    platform: "node",
    sourcemap: true,
  },
});
