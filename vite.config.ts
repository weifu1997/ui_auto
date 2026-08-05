import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "ui-vendor",
              test: /[\\/]node_modules[\\/](?:antd|@ant-design|@rc-component|rc-[^\\/]+)[\\/]/,
              minSize: 50_000,
              maxSize: 250_000,
              includeDependenciesRecursively: true,
            },
          ],
        },
      },
    },
  },
});
