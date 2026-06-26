{
  description = "NixOS server configurations";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
    in
    {
      nixosConfigurations.laptop-server = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          ./hosts/laptop-server/configuration.nix
        ];
      };

      nixosConfigurations.tobias-serv01 = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          ./hosts/tobias-serv01/configuration.nix
        ];
      };
    };
}
