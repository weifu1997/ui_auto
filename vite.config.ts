import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    rolldownOptions: {
      output: {
        // Preserve package initialization order when a lazy route shares
        // Ant Design modules with the initial application chunk.
        strictExecutionOrder: true,
        codeSplitting: {
          minSize: 20 * 1024,
          groups: [
            // Keep the RC component graph together: select and menu have
            // initialization cycles that break when Rolldown splits them.
            {
              name: "rc-select-menu",
              test: /[\\/]node_modules[\\/]@rc-component[\\/](?:select|menu|trigger|util)[\\/]/,
              minSize: 20 * 1024,
              priority: 40,
            },
            {
              name: "rc-components",
              test: /[\\/]node_modules[\\/](?:@rc-component|rc-)[\\/]/,
              minSize: 20 * 1024,
              maxSize: 400 * 1024,
              priority: 30,
            },
            {
              name: "antd",
              test: /[\\/]node_modules[\\/]antd[\\/]/,
              minSize: 20 * 1024,
              // Ant Design has initialization cycles between feedback and
              // overlay components. Splitting this package breaks production
              // ESM evaluation before the application can render.
              maxSize: 1024 * 1024,
              priority: 20,
            },
            {
              name: "antd-icons",
              test: /[\\/]node_modules[\\/]@ant-design[\\/]icons(?:-svg)?[\\/]/,
              minSize: 20 * 1024,
              priority: 20,
            },
            {
              name: "vendor",
              test: /[\\/]node_modules[\\/]/,
              minSize: 20 * 1024,
              maxSize: 400 * 1024,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
