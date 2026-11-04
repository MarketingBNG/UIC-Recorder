import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built into server/dist/public, which the API serves from the same origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/public", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/auth": "http://localhost:8000",
    },
  },
});
