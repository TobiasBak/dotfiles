{
  description = "NixOS configurations for developer machines and servers";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    hunk = {
      url = "github:modem-dev/hunk";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-wsl = {
      url = "github:nix-community/NixOS-WSL/main";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    hermes-agent = {
      url = "github:NousResearch/hermes-agent";
      # Keep Hermes on its upstream Nixpkgs pin. Its Python runtime needs a
      # newer SQLite than the stable host input currently provides.
    };
  };

  outputs =
    {
      self,
      home-manager,
      hermes-agent,
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

        pc = mkDeveloperSystem [
          ./hosts/pc/configuration.nix
        ];

        laptop = mkDeveloperSystem [
          ./hosts/laptop/configuration.nix
        ];

        tobias-serv01 = nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            hermes-agent.nixosModules.default
            ./hosts/tobias-serv01/configuration.nix
          ];
        };
      };
    };
}
