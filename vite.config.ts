import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Express server hosts Vite as middleware in dev (`npm run dev`), so the
// app, API, and Google sign-in callback all share one origin and port.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
