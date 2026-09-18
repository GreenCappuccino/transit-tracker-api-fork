{
  description = "Backend API for Transit Tracker, serving realtime transit departures";

  # nixpkgs only, deliberately. A flake-utils or flake-parts dependency would
  # buy little beyond the six lines of genAttrs below, and every input a
  # consumer has to resolve is a cost paid by everyone who depends on this.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      overlays.default = final: _prev: {
        transit-tracker-api = final.callPackage ./nix/package.nix { };
      };

      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          transit-tracker-api = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit transit-tracker-api;
          default = transit-tracker-api;
        }
      );

      # Enough to work on the server itself: the toolchain it builds with, plus
      # the two clients you need to talk to its datastores and the migration
      # tool. Bringing Postgres and Redis *up* is deliberately out of scope --
      # see docs/development/quickstart.md for the compose file that does that.
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm_11
              pkgs.dbmate
              pkgs.postgresql # psql
              pkgs.valkey # valkey-cli, speaks the Redis protocol
              pkgs.jq
            ];

            # Without this, the prebuilt .node binaries in @swc/core and
            # @sentry/profiling-node cannot find libstdc++/libgcc_s, and an
            # impure `pnpm install && pnpm start:dev` fails on NixOS at import
            # time with a bare "cannot open shared object file".
            shellHook = ''
              export LD_LIBRARY_PATH=${
                lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]
              }''${LD_LIBRARY_PATH:+:}$LD_LIBRARY_PATH
            '';
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-tree);
    };
}
