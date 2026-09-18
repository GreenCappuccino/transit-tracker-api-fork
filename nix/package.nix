{
  lib,
  stdenv,
  makeWrapper,
  fetchPnpmDeps,
  pnpmConfigHook,
  nodejs_24,
  pnpm_11,

  # Overridable build inputs. Pinned to the versions CI uses (see
  # .github/workflows/test.yaml and the Dockerfile), but exposed so a consumer
  # can move either without vendoring this file.
  nodejs ? nodejs_24,
  pnpm ? pnpm_11,

  # Regenerate after any change to pnpm-lock.yaml: set this to lib.fakeHash,
  # build, and record the hash Nix reports.
  #
  # One hash covers every platform. fetchPnpmDeps fetches the dependency set
  # described by the lockfile, including the platform-specific optional
  # packages for *all* platforms, so the output is byte-identical on x86_64 and
  # aarch64 -- verified by realising this derivation on both.
  pnpmDepsHash ? "sha256-WBsTsw7dfi4aKyKTH/7Y3p4sBkiPMABG3uqWgC/pe2k=",

  version ? "0.0.1",
}:

let
  # An explicit allowlist, not lib.cleanSource. cleanSource filters VCS noise
  # but NOT gitignored paths, so it would happily copy local credential files
  # into the world-readable Nix store.
  root = ../.;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../nest-cli.json
      ../tsconfig.json
      ../tsconfig.build.json
      ../src
      ../db
    ];
  };

  # Deliberately narrower than `src`: the dependency set is a function of these
  # three files alone, so editing a .ts file must not invalidate the
  # fixed-output derivation and send you hash-chasing again.
  depsSrc = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
    ];
  };

  # src/sentry/index.ts imports @sentry/profiling-node unconditionally, and both
  # src/main.ts and src/cli.ts import ./sentry -- so a prebuilt .node has to
  # dlopen at *runtime*, not just during the build (where @swc/core needs the
  # same). Neither records a full RPATH, so they need this on the search path.
  nativeLibPath = lib.makeLibraryPath [ stdenv.cc.cc.lib ];
in
stdenv.mkDerivation (finalAttrs: {
  pname = "transit-tracker-api";
  inherit version src;

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version;
    src = depsSrc;
    fetcherVersion = 4;
    hash = pnpmDepsHash;
  };

  # @sentry/cli's postinstall downloads a release binary, which cannot work in
  # the sandbox. Only the sentry:sourcemaps:* scripts use it, and those are
  # release tooling we never invoke here.
  env.SENTRYCLI_SKIP_DOWNLOAD = "1";

  buildPhase = ''
    runHook preBuild

    export LD_LIBRARY_PATH=${nativeLibPath}''${LD_LIBRARY_PATH:+:}$LD_LIBRARY_PATH
    pnpm build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Drop devDependencies before installing: they are roughly half the closure
    # and nothing in dist/ reaches for them. Offline -- it only unlinks from the
    # store already populated by pnpmConfigHook.
    pnpm prune --prod --ignore-scripts

    mkdir -p $out/lib/transit-tracker-api

    # -a, never -r. pnpm's node_modules is a symlink farm into node_modules/.pnpm;
    # dereferencing it turns a few hundred MB into several GB.
    cp -a dist node_modules package.json db $out/lib/transit-tracker-api/

    for entry in main cli; do
      makeWrapper ${lib.getExe nodejs} $out/bin/transit-tracker-api-$entry \
        --add-flags $out/lib/transit-tracker-api/dist/$entry.js \
        --prefix LD_LIBRARY_PATH : ${nativeLibPath}
    done
    ln -s transit-tracker-api-main $out/bin/transit-tracker-api

    runHook postInstall
  '';

  meta = {
    description = "Backend API for Transit Tracker, serving realtime transit departures";
    homepage = "https://github.com/tjhorner/transit-tracker-api";
    license = lib.licenses.mit;
    mainProgram = "transit-tracker-api-main";
    platforms = lib.platforms.linux;
  };
})
