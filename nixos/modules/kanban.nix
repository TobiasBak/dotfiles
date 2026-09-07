{ pkgs, ... }:

let
  containerService = "docker-kanban";
  containerServiceUnit = "${containerService}.service";
  enhancementsScript = pkgs.writeText "kanban-enhancements.js" (
    builtins.readFile ./kanban-enhancements.js
  );
  enhancementsStylesheet = pkgs.writeText "kanban-enhancements.css" (
    builtins.readFile ./kanban-enhancements.css
  );
in
{
  virtualisation.oci-containers = {
    backend = "docker";
    containers.kanban = {
      image = "baldissaramatheus/tasks.md:3.3.0@sha256:fd3e212fd5619794598418c049feda17810dae4438a84c00a0fb06fe3621b97a";
      ports = [ "127.0.0.1:8080:8080" ];
      volumes = [
        "/srv/nas/files/kanban/tasks:/tasks:rw"
        "/srv/nas/files/kanban/config:/config:rw"
      ];
      environment = {
        PUID = "1000";
        PGID = "100";
        TITLE = "Work board";
        BASE_PATH = "/kanban";
        LOCAL_IMAGES_CLEANUP_INTERVAL = "0";
      };
      extraOptions = [
        "--init"
        "--security-opt=no-new-privileges:true"
        "--cap-drop=ALL"
        "--cap-add=CHOWN"
        "--cap-add=DAC_OVERRIDE"
        "--cap-add=SETGID"
        "--cap-add=SETUID"
      ];
    };
  };

  systemd.services.kanban-directories = {
    description = "Create Tasks.md persistent directories";
    requires = [ "srv-nas.mount" ];
    after = [ "srv-nas.mount" ];
    before = [ containerServiceUnit ];
    unitConfig.AssertPathIsMountPoint = "/srv/nas";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      ${pkgs.coreutils}/bin/install -d -m 0750 -o 1000 -g 100 \
        /srv/nas/files/kanban \
        /srv/nas/files/kanban/tasks \
        /srv/nas/files/kanban/config
    '';
  };

  systemd.services.${containerService} = {
    requires = [
      "srv-nas.mount"
      "kanban-directories.service"
    ];
    after = [
      "srv-nas.mount"
      "kanban-directories.service"
    ];
    unitConfig.AssertPathIsMountPoint = "/srv/nas";
  };

  services.nginx = {
    enable = true;
    virtualHosts.kanban = {
      default = true;
      listen = [
        {
          addr = "0.0.0.0";
          port = 80;
        }
      ];
      extraConfig = ''
        if ($http_sec_fetch_site = "cross-site") {
          return 403;
        }
      '';
      locations = {
        "= /kanban".return = "308 /kanban/";
        "= /kanban/enhancements.js" = {
          alias = enhancementsScript;
          extraConfig = ''
            default_type application/javascript;
            add_header Cache-Control "no-cache";
          '';
        };
        "= /kanban/enhancements.css" = {
          alias = enhancementsStylesheet;
          extraConfig = ''
            default_type text/css;
            add_header Cache-Control "no-cache";
          '';
        };
        "/kanban/" = {
          proxyPass = "http://127.0.0.1:8080";
          extraConfig = ''
            proxy_http_version 1.1;
            proxy_set_header Accept-Encoding "";
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_hide_header Access-Control-Allow-Origin;
            proxy_hide_header Access-Control-Allow-Methods;
            proxy_hide_header Access-Control-Allow-Headers;
            proxy_hide_header Access-Control-Allow-Credentials;
            proxy_hide_header Access-Control-Expose-Headers;
            proxy_hide_header Access-Control-Max-Age;
            sub_filter_once on;
            sub_filter '</body>' '<script defer src="/kanban/enhancements.js"></script></body>';
          '';
        };
      };
    };
  };

  systemd.services.nginx = {
    wants = [ containerServiceUnit ];
    after = [ containerServiceUnit ];
  };

  # Tailscale is the access boundary. Nginx listens on the host, while the
  # firewall admits HTTP only through tailscale0.
  networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 80 ];
}
