{
  description = "NixOS server configurations";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    hunk = {
      url = "github:modem-dev/hunk";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-wsl.url = "github:nix-community/NixOS-WSL/main";
    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      home-manager,
      hunk,
      nixpkgs,
      nixos-wsl,
    }:
    let
      system = "x86_64-linux";
    in
    {
      nixosConfigurations.wsl = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          nixos-wsl.nixosModules.default
          home-manager.nixosModules.home-manager
          ./hosts/wsl/configuration.nix
        ];
        specialArgs = {
          inherit hunk;
        };
      };

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
