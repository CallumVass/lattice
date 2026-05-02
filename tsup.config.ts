import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/plugin/index.ts", "src/builder/index.ts", "src/schema/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  outDir: "dist",
});
