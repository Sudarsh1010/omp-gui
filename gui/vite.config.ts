import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
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
      // `vp run` scrubs the environment to a small allowlist, which drops the
      // nix build env (NIX_LDFLAGS → `ld: library 'iconv' not found`). Pass it
      // through explicitly; the linker side is pinned in .cargo/config.toml.
      tauri: {
        command: "tauri",
        cwd: "../crates/shell",
        untrackedEnv: ["NIX_*", "DEVELOPER_DIR", "SDKROOT", "MACOSX_DEPLOYMENT_TARGET"],
      },
    },
  },
}));
