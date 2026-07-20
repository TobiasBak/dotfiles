{
  description = "NixOS configurations for developer machines and servers";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    hunk = {
      url = "github:modem-dev/hunk";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-wsl.url = "github:nix-community/NixOS-WSL/main";
    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
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
      mkDeveloperSystem =
        modules:
        nixpkgs.lib.nixosSystem {
          inherit system;
          specialArgs = { inherit hunk; };
          modules = [ home-manager.nixosModules.home-manager ] ++ modules;
        };
    in
    {
      formatter.${system} = nixpkgs.legacyPackages.${system}.nixfmt;

      nixosConfigurations = {
        wsl = mkDeveloperSystem [
          nixos-wsl.nixosModules.default
          ./hosts/wsl/configuration.nix
        ];

        tobias-stationary = mkDeveloperSystem [
          ./hosts/tobias-stationary/configuration.nix
        ];

        tobias-laptop = mkDeveloperSystem [
          ./hosts/tobias-laptop/configuration.nix
        ];

        laptop-server = nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [ ./hosts/laptop-server/configuration.nix ];
        };

        tobias-serv01 = nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [ ./hosts/tobias-serv01/configuration.nix ];
        };
      };
    };
}
