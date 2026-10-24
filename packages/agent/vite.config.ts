import { defineConfig } from "vite-plus";

/** 打包:SDK 一个入口(客户端各自打包自己)。 */
export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    sourcemap: true,
  },
});
