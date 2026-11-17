import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" makes every asset path relative, so the same build works locally
// and under https://<user>.github.io/<repo>/ without hard-coding the repo name.
export default defineConfig({
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
});
