{ self }:

{ lib, ... }:

{
  name = "beach-bar-merge";

  nodes.machine = { pkgs, ... }: {
    imports = [ self.nixosModules.beach-bar-merge ];

    services.beach-bar-merge = {
      enable = true;
      port = 3000;
      nginx = {
        enable = true;
        domain = "merge.test";
        enableACME = false;
      };
    };

    # The test VM has no ACME, so serve the vhost over plain HTTP.
    services.nginx.virtualHosts."merge.test".forceSSL = lib.mkForce false;

    networking.hosts."127.0.0.1" = [ "merge.test" ];
    environment.systemPackages = [
      pkgs.curl
      pkgs.jq
    ];
  };

  testScript = ''
    machine.wait_for_unit("beach-bar-merge.service")
    machine.wait_for_open_port(3000)

    # The game shell and its prebuilt bundle are served from the store.
    machine.succeed("curl -sf http://127.0.0.1:3000/ | grep -q 'Beach Bar Merge'")
    machine.succeed("test $(curl -sf http://127.0.0.1:3000/app.js | wc -c) -gt 1000")
    machine.succeed("curl -sf http://127.0.0.1:3000/styles.css >/dev/null")

    # An empty leaderboard is still well-formed JSON.
    machine.succeed(
        "curl -sf http://127.0.0.1:3000/api/leaderboard | jq -e '.entries | type == \"array\"'"
    )

    # A game handed out by the server carries a token and a seed.
    machine.succeed(
        "curl -sf -X POST http://127.0.0.1:3000/api/game "
        "| jq -e '.token and (.seed | type == \"number\")'"
    )

    # Cross-site posts are refused.
    machine.succeed(
        "test 403 = $(curl -s -o /dev/null -w '%{http_code}' -X POST "
        "-H 'Sec-Fetch-Site: cross-site' http://127.0.0.1:3000/api/game)"
    )

    # The leaderboard database lands in the state directory, not the store.
    machine.succeed("test -f /var/lib/beach-bar-merge/scores.sqlite")

    # nginx fronts the same content.
    machine.wait_for_unit("nginx.service")
    machine.succeed("curl -sf http://merge.test/ | grep -q 'Beach Bar Merge'")
  '';
}
