{
  fetchurl,
  lib,
  stdenvNoCC,
  unzip,
}:

# Order Integration Platform pins this CLI version in infra/gcp/*/versions.tf.
# Use HashiCorp's release archive without changing the host's nixpkgs pin.
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "terraform";
  version = "1.16.3";

  src = fetchurl {
    url = "https://releases.hashicorp.com/terraform/${finalAttrs.version}/terraform_${finalAttrs.version}_linux_amd64.zip";
    hash = "sha256-CTtq6aIiivUCnEFga8lutYNVNSiq0b/n4LTWL8keJdg=";
  };

  dontUnpack = true;
  nativeBuildInputs = [ unzip ];

  installPhase = ''
    runHook preInstall

    unzip "$src" -d unpacked
    install -Dm755 unpacked/terraform "$out/bin/terraform"
    install -Dm644 unpacked/LICENSE.txt "$out/share/licenses/terraform/LICENSE.txt"

    runHook postInstall
  '';

  meta = {
    description = "Infrastructure as code CLI";
    homepage = "https://developer.hashicorp.com/terraform";
    license = lib.licenses.bsl11;
    mainProgram = "terraform";
    platforms = [ "x86_64-linux" ];
  };
})
