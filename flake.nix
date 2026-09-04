{
  description = "omp-gui dev environment: Rust, Node LTS, pnpm via Corepack, Vite+ (vp)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      rust-overlay,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [
            "rust-src"
            "rust-analyzer"
            "clippy"
            "rustfmt"
          ];
        };

        inherit (pkgs) lib stdenv;

        # Tauri 2 on Linux links against WebKitGTK/GTK3 via pkg-config.
        linuxNativeDeps = with pkgs; [
          at-spi2-atk
          atkmm
          cairo
          gdk-pixbuf
          glib
          gtk3
          harfbuzz
          librsvg
          libsoup_3
          pango
          webkitgtk_4_1
        ];

        # GLib/GTK find schemas and TLS modules through the environment, not
        # rpath; without these the dev binary starts but WebKit can't do
        # HTTPS and GTK warns about missing gsettings schemas.
        linuxHook = ''
          export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"
          # nixpkgs' webkitgtk renders a blank window under the DMA-BUF
          # renderer on many Nvidia/Wayland setups; software path is safe.
          export WEBKIT_DISABLE_DMABUF_RENDERER=1
          export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
        '';

        darwinHook = ''
          export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
          echo "SDK: $(xcrun --sdk macosx --show-sdk-path)"
        '';
      in
      {
        devShells.default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              rustToolchain
              cargo-watch

              nodejs_24
              corepack_24
              curl
              pkg-config

              boost
            ]
            ++ lib.optionals stdenv.hostPlatform.isDarwin [ libiconv ];

          buildInputs = lib.optionals stdenv.hostPlatform.isLinux linuxNativeDeps;

          # Corepack refuses to write shims into the read-only Nix store, so
          # point it at a project-local, gitignored directory instead.
          shellHook =
            lib.optionalString stdenv.hostPlatform.isLinux linuxHook
            + lib.optionalString stdenv.hostPlatform.isDarwin darwinHook
            + ''
              export COREPACK_HOME="$PWD/.corepack"
              mkdir -p "$COREPACK_HOME/bin"
              corepack enable --install-directory "$COREPACK_HOME/bin" >/dev/null 2>&1
              export PATH="$COREPACK_HOME/bin:$PATH"

              corepack prepare pnpm@12 --activate >/dev/null 2>&1 || true

              export VP_HOME="$PWD/.vp"
              if [ ! -x "$VP_HOME/bin/vp" ]; then
                echo "installing vp (Vite+) into .vp/ ..."
                curl -fsSL https://vite.plus | HOME="$(mktemp -d)" VP_HOME="$VP_HOME" VP_NODE_MANAGER=no bash
                "$VP_HOME/bin/vp" env off >/dev/null 2>&1 || true
              fi

              export PATH="$VP_HOME/bin:$PATH"

              echo "CC: $(which cc)"
              echo "node $(node --version) · pnpm $(pnpm --version 2>/dev/null || echo 'n/a') · vp $(vp --version 2>/dev/null || echo 'n/a') · $(rustc --version)"
            '';
        };
      }
    );
}
