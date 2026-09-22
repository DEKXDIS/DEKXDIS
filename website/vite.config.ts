import { defineConfig } from "vite";

// Static single-page site. Build output goes to ./dist.
export default defineConfig({
  build: {
    outDir: "dist",
  },
});
