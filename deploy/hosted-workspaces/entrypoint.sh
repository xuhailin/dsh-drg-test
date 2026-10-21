#!/bin/sh
set -eu
umask 077

mode=${1:-runtime}
if [ "$#" -gt 0 ]; then shift; fi
if [ "$mode" = gateway ]; then
  : "${HOSTED_ENTRY_HOST:?HOSTED_ENTRY_HOST must name the gateway alias on its entry network}"
  HOSTED_BIND_IP=$(node --input-type=module -e '
    import { lookup } from "node:dns/promises";
    const { address } = await lookup(process.env.HOSTED_ENTRY_HOST, { family: 4 });
    process.stdout.write(address);
  ')
  export HOSTED_BIND_IP
elif [ -z "${HOSTED_BIND_IP:-}" ]; then
  HOSTED_BIND_IP=$(node --input-type=module -e '
    import { networkInterfaces } from "node:os";
    const interfaces = networkInterfaces();
    const addresses = [...(interfaces.eth0 ?? []), ...Object.values(interfaces).flat()];
    const primary = addresses.find(address => address && address.family === "IPv4" && !address.internal);
    if (!primary) throw new Error("No concrete container IPv4 address is available");
    process.stdout.write(primary.address);
  ')
  export HOSTED_BIND_IP
fi

case "$mode" in
  gateway)
    : "${DSH_HOME:?DSH_HOME must name the persistent gateway home}"
    mkdir -p "$DSH_HOME/profiles/gateway"
    if [ ! -e "$DSH_HOME/profiles/gateway/package.json" ]; then
      cp /opt/dsh/deploy/hosted-workspaces/profile/package.json "$DSH_HOME/profiles/gateway/package.json"
    fi
    if [ ! -e "$DSH_HOME/profiles/gateway/node_modules" ]; then
      ln -s /opt/dsh/node_modules "$DSH_HOME/profiles/gateway/node_modules"
    fi
    cd /opt/dsh
    exec node /opt/dsh/apps/cli/lib/bin.js --profile gateway "$@"
    ;;
  runtime)
    : "${HOSTED_PUBLIC_URL:?HOSTED_PUBLIC_URL must name the public user origin}"
    authority=$(node --input-type=module -e 'process.stdout.write(new URL(process.env.HOSTED_PUBLIC_URL).host)')
    mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" /home/node/workspace
    cd /home/node/workspace
    exec node /opt/dsh/apps/cli/lib/bin.js web \
      --host "$HOSTED_BIND_IP" \
      --port "${HOSTED_RUNTIME_PORT:-3080}" \
      --no-open \
      --public-url "$HOSTED_PUBLIC_URL" \
      --trusted-host "$authority" "$@"
    ;;
  *)
    exec "$mode" "$@"
    ;;
esac
