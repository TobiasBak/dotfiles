{
  description = "NixOS configuration for tobias-serv01";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      formatter.${system} = pkgs.nixfmt;

      nixosConfigurations.tobias-serv01 = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [ ./hosts/tobias-serv01/configuration.nix ];
      };
    };
}
