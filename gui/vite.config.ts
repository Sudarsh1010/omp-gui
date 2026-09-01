import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  resolve: { tsconfigPaths: true },
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/route-tree.gen.ts",
      routeFileIgnorePrefix: "-",
    }),
    react(),
    tailwindcss(),
  ],

  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
  },

  run: {
    tasks: {
      tauri: {
        command: "tauri",
        cwd: "../crates/shell",
        untrackedEnv: ["NIX_*", "DEVELOPER_DIR", "SDKROOT", "MACOSX_DEPLOYMENT_TARGET"],
      },
    },
  },
}));
