{
  description = "Beach Bar Merge, a drink merge game served by Bun";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      overlays.default = final: _prev: {
        beach-bar-merge = final.callPackage ./nix/package.nix { };
      };

      packages = forAllSystems (pkgs: rec {
        beach-bar-merge = pkgs.callPackage ./nix/package.nix { };
        default = beach-bar-merge;
      });

      # Self-contained: the module builds its own default package, so it does
      # not touch `nixpkgs.overlays` and works under a read-only `pkgs`.
      nixosModules.beach-bar-merge = ./nix/module.nix;
      nixosModules.default = self.nixosModules.beach-bar-merge;

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.sqlite
          ];
        };
      });

      checks = forAllSystems (
        pkgs:
        {
          package = self.packages.${pkgs.stdenv.hostPlatform.system}.beach-bar-merge;
        }
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          # Boots a VM and exercises the service and its nginx vhost over
          # real HTTP, so the module is checked end to end.
          nixos = pkgs.testers.runNixOSTest (import ./nix/test.nix { inherit self; });
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
