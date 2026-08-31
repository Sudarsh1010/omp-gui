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
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            rustToolchain
            cargo-watch

            # Node.js LTS + Corepack (shims for pnpm, pinned to pnpm 12 below)
            nodejs_24
            corepack_24
            curl # for the vp installer below
          ];

          # Corepack refuses to write shims into the read-only Nix store, so
          # point it at a project-local, gitignored directory instead.
          shellHook = ''
            export COREPACK_HOME="$PWD/.corepack"
            mkdir -p "$COREPACK_HOME/bin"
            corepack enable --install-directory "$COREPACK_HOME/bin" >/dev/null 2>&1
            export PATH="$COREPACK_HOME/bin:$PATH"
            # Pin pnpm 12 (cached in COREPACK_HOME; remove this once
            # package.json declares "packageManager": "pnpm@12.x").
            corepack prepare pnpm@12 --activate >/dev/null 2>&1 || true

            # Project-local Vite+ (vp). VP_HOME pins bin/cache/config/state
            # under .vp/. A fake HOME keeps the installer from touching real
            # shell rc files; VP_NODE_MANAGER=no because nix owns node/pnpm.
            export VP_HOME="$PWD/.vp"
            if [ ! -x "$VP_HOME/bin/vp" ]; then
              echo "installing vp (Vite+) into .vp/ ..."
              curl -fsSL https://vite.plus | HOME="$(mktemp -d)" VP_HOME="$VP_HOME" VP_NODE_MANAGER=no bash
              "$VP_HOME/bin/vp" env off >/dev/null 2>&1 || true
            fi
            # Append, not prepend: nix node and corepack's pnpm shim win PATH.
            export PATH="$PATH:$VP_HOME/bin"

            echo "node $(node --version) · pnpm $(pnpm --version 2>/dev/null || echo 'n/a') · vp $(vp --version 2>/dev/null || echo 'n/a') · $(rustc --version)"
          '';
        };
      }
    );
}
