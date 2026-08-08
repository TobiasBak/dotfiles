{
  buildNpmPackage,
  chromium,
  lib,
  makeWrapper,
  nodejs,
}:

buildNpmPackage {
  pname = "playwright-cli";
  version = "0.1.17";

  src = ./.;
  npmDepsHash = "sha256-wxnOrerqqwbYkABSciMeqBuqh1Lk0FxHKHyGoX0SAAs=";

  dontNpmBuild = true;
  nativeBuildInputs = [ makeWrapper ];
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/node_modules/playwright-cli-wrapper" "$out/bin"
    cp -R node_modules/. "$out/lib/node_modules/playwright-cli-wrapper/node_modules"

    makeWrapper ${nodejs}/bin/node "$out/bin/playwright-cli" \
      --add-flags "$out/lib/node_modules/playwright-cli-wrapper/node_modules/@playwright/cli/playwright-cli.js" \
      --set PLAYWRIGHT_MCP_EXECUTABLE_PATH "${chromium}/bin/chromium"

    runHook postInstall
  '';

  meta = {
    description = "Token-efficient Playwright browser automation CLI for coding agents";
    homepage = "https://github.com/microsoft/playwright-cli";
    license = lib.licenses.asl20;
    mainProgram = "playwright-cli";
    platforms = lib.platforms.linux;
  };
}
