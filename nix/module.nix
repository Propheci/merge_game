{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.beach-bar-merge;
  inherit (lib)
    mkOption
    mkEnableOption
    mkIf
    types
    ;

  stateDirName = "beach-bar-merge";
  defaultDataDir = "/var/lib/${stateDirName}";
  usesDefaultDataDir = cfg.dataDir == defaultDataDir;
in
{
  options.services.beach-bar-merge = {
    enable = mkEnableOption "the Beach Bar Merge game server";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = ''
        The game to run. The default builds it from this repository, so the
        module works without adding {option}`nixpkgs.overlays`.
      '';
    };

    port = mkOption {
      type = types.port;
      default = 3000;
      description = "TCP port the game server listens on.";
    };

    address = mkOption {
      type = types.str;
      default = "127.0.0.1";
      example = "0.0.0.0";
      description = ''
        Address to bind. The default only accepts local connections, which is
        what you want behind {option}`services.beach-bar-merge.nginx.enable`.
      '';
    };

    dataDir = mkOption {
      type = types.path;
      default = defaultDataDir;
      description = ''
        Directory holding the leaderboard database. Left at the default it is
        managed as a systemd {var}`StateDirectory`; point it elsewhere and you
        are responsible for creating it with the right owner.
      '';
    };

    user = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        User to run as. Null uses a systemd {var}`DynamicUser`, which is the
        recommended setting.
      '';
    };

    group = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Group to run as. Null pairs with the dynamic user.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Open {option}`port` in the firewall. Leave this off when nginx or
        another reverse proxy fronts the service.
      '';
    };

    hsts = mkOption {
      type = types.bool;
      default = cfg.nginx.enable;
      defaultText = lib.literalExpression "config.services.beach-bar-merge.nginx.enable";
      description = ''
        Send a `Strict-Transport-Security` header. Only enable this when every
        request really does arrive over HTTPS.
      '';
    };

    trustProxy = mkOption {
      type = types.bool;
      default = cfg.nginx.enable;
      defaultText = lib.literalExpression "config.services.beach-bar-merge.nginx.enable";
      description = ''
        Take the client address from `X-Forwarded-For`. Enable this only when a
        proxy you control sets that header, otherwise clients can forge the
        address that rate limiting keys on.
      '';
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/beach-bar-merge.env";
      description = ''
        Path to an `EnvironmentFile` read at start-up, for values that should
        not land in the world-readable Nix store.
      '';
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        MERGE_GAME_HSTS = "1";
      };
      description = "Extra environment variables for the service.";
    };

    nginx = {
      enable = mkEnableOption "an nginx reverse proxy for the game";

      domain = mkOption {
        type = types.str;
        example = "merge.example.com";
        description = "Virtual host name to serve the game on.";
      };

      enableACME = mkOption {
        type = types.bool;
        default = true;
        description = "Request a Let's Encrypt certificate for {option}`domain`.";
      };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = (cfg.user == null) == (cfg.group == null);
        message = ''
          services.beach-bar-merge: set both `user` and `group`, or neither.
        '';
      }
      {
        assertion = cfg.nginx.enable -> cfg.nginx.domain != "";
        message = ''
          services.beach-bar-merge.nginx.enable requires `nginx.domain`.
        '';
      }
    ];

    warnings =
      lib.optional (cfg.trustProxy && !cfg.nginx.enable) ''
        services.beach-bar-merge.trustProxy is on without this module's nginx
        proxy. Make sure whatever fronts the service overwrites the
        X-Forwarded-For header, or rate limiting can be bypassed.
      ''
      ++ lib.optional (cfg.openFirewall && cfg.address == "127.0.0.1") ''
        services.beach-bar-merge.openFirewall is on but the service only binds
        127.0.0.1, so the open port reaches nothing.
      '';

    users.users = mkIf (cfg.user != null) {
      ${cfg.user} = {
        isSystemUser = true;
        group = cfg.group;
      };
    };

    users.groups = mkIf (cfg.group != null) { ${cfg.group} = { }; };

    systemd.services.beach-bar-merge = {
      description = "Beach Bar Merge game server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        NODE_ENV = "production";
        HOST = cfg.address;
        PORT = toString cfg.port;
        MERGE_GAME_DB = "${cfg.dataDir}/scores.sqlite";
        MERGE_GAME_HSTS = if cfg.hsts then "1" else "0";
        MERGE_GAME_TRUST_PROXY = if cfg.trustProxy then "1" else "0";
      }
      // cfg.environment;

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 5;

        WorkingDirectory = cfg.dataDir;
        StateDirectory = mkIf usesDefaultDataDir stateDirName;
        StateDirectoryMode = "0750";

        EnvironmentFile = mkIf (cfg.environmentFile != null) cfg.environmentFile;

        User = mkIf (cfg.user != null) cfg.user;
        Group = mkIf (cfg.group != null) cfg.group;
        DynamicUser = cfg.user == null;

        # The service reads its own store path, writes one SQLite file, and
        # answers HTTP. Nothing else needs to be reachable.
        AmbientCapabilities = lib.optional (cfg.port < 1024) "CAP_NET_BIND_SERVICE";
        CapabilityBoundingSet = if cfg.port < 1024 then [ "CAP_NET_BIND_SERVICE" ] else [ "" ];
        DevicePolicy = "closed";
        LockPersonality = true;
        MemoryDenyWriteExecute = false; # JIT
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        PrivateUsers = cfg.port >= 1024;
        ProcSubset = "pid";
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectProc = "invisible";
        ProtectSystem = "strict";
        ReadWritePaths = mkIf (!usesDefaultDataDir) [ cfg.dataDir ];
        RemoveIPC = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        UMask = "0077";
      };
    };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];

    services.nginx = mkIf cfg.nginx.enable {
      enable = true;
      recommendedProxySettings = true;
      recommendedGzipSettings = true;
      recommendedOptimisation = true;
      recommendedTlsSettings = true;

      virtualHosts.${cfg.nginx.domain} = {
        forceSSL = cfg.nginx.enableACME;
        enableACME = cfg.nginx.enableACME;
        locations."/".proxyPass = "http://${
          if cfg.address == "0.0.0.0" then "127.0.0.1" else cfg.address
        }:${toString cfg.port}";
      };
    };
  };
}
