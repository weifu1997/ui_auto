import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 20 * 1024,
          maxSize: 400 * 1024,
          groups: [
            {
              name: "vendor",
              test: /[\\/]node_modules[\\/]/,
              minSize: 20 * 1024,
              maxSize: 400 * 1024,
            },
          ],
        },
      },
    },
  },
});
