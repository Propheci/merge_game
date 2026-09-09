{
  lib,
  stdenvNoCC,
  bun,
  makeBinaryWrapper,
  cacert,
  # Hash of the resolved node_modules tree. Update after changing bun.lock:
  #   nix build .#beach-bar-merge.deps  (the error prints the new hash)
  depsHash ? "sha256-VEm2duxnGtTsb0lJYYA+OswyM5xzrJsN49TqaHohELY=",
}:

let
  pname = "beach-bar-merge";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version or "0.1.0";

  # Only what the build and the runtime actually read. Keeping this list tight
  # means editing a README or the Nix files does not invalidate the build.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../package.json
      ../bun.lock
      ../tsconfig.json
    ];
  };

  # Dependency fetching is the only step that needs the network, so it lives in
  # its own fixed-output derivation.
  deps = stdenvNoCC.mkDerivation {
    pname = "${pname}-deps";
    inherit version;

    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../bun.lock
      ];
    };

    nativeBuildInputs = [
      bun
      cacert
    ];

    dontConfigure = true;

    buildPhase = ''
      runHook preBuild

      export HOME=$TMPDIR
      bun install \
        --frozen-lockfile \
        --production \
        --ignore-scripts \
        --no-progress \
        --no-summary

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R node_modules $out/
      runHook postInstall
    '';

    # bun records absolute paths and timestamps in its install cache; strip
    # everything that is not the package tree itself.
    fixupPhase = ''
      rm -rf $out/node_modules/.cache $out/node_modules/.bin
      find $out -name '.DS_Store' -delete
      find $out -exec touch -h -d '@1' {} +
    '';

    dontPatchShebangs = true;

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = depsHash;
  };
in
stdenvNoCC.mkDerivation {
  inherit pname version src;

  nativeBuildInputs = [
    bun
    makeBinaryWrapper
  ];

  configurePhase = ''
    runHook preConfigure
    cp -R ${deps}/node_modules node_modules
    chmod -R u+w node_modules
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild

    export HOME=$TMPDIR
    bun build src/client/main.ts \
      --outdir dist \
      --target browser \
      --format esm \
      --minify

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm444 dist/main.js $out/share/${pname}/dist/main.js

    mkdir -p $out/share/${pname}/src
    cp -R src/server src/shared $out/share/${pname}/src/
    find $out/share/${pname}/src -name '*.test.ts' -delete

    # Only the files that assets.ts serves, never the client sources.
    install -Dm444 src/client/index.html  $out/share/${pname}/src/client/index.html
    install -Dm444 src/client/styles.css  $out/share/${pname}/src/client/styles.css
    install -Dm444 src/client/favicon.svg $out/share/${pname}/src/client/favicon.svg

    makeBinaryWrapper ${lib.getExe bun} $out/bin/${pname} \
      --set-default NODE_ENV production \
      --set MERGE_GAME_PREBUILT 1 \
      --set MERGE_GAME_DIST $out/share/${pname}/dist \
      --add-flags "run $out/share/${pname}/src/server/index.ts"

    runHook postInstall
  '';

  passthru = {
    inherit deps;
    inherit (deps) outputHash;
  };

  meta = {
    description = "Beach Bar Merge, a drink merge game served by Bun";
    homepage = "https://github.com/Propheci/merge_game";
    mainProgram = pname;
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
