import { defineConfig } from "vite-plus";

/**
 * 根配置只管"全仓"的工具:
 *   vp check  -> fmt + lint + type-check(tsc,覆盖 packages/*)
 *   vp test   -> vitest(两个包的用例)
 *   vp lint / vp fmt -> 单独跑
 * 打包(`vp pack`)由各包自己的 vite.config.ts 决定入口。
 */
export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts"],
  },
  fmt: {
    printWidth: 100,
  },
  lint: {
    plugins: ["typescript", "oxc"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
