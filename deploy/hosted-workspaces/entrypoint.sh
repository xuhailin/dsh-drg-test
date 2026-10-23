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
    if [ -n "${DSH_SHARED_RESOURCES_ROOT:-}" ]; then
      test -r "$DSH_SHARED_RESOURCES_ROOT/catalog.json" \
        || { echo "Shared reference catalog is unavailable; inspect the configured published directory." >&2; exit 1; }
      export DSH_BUNDLED_SKILL_DIR=/opt/dsh/deploy/hosted-workspaces/skills
    fi
    cd /home/node/workspace
    runtime_profile=web
    clinical_review=false
    if [ -n "${HOSTED_RUNTIME_PATCH_FILE:-}" ]; then
      test -r "$HOSTED_RUNTIME_PATCH_FILE" \
        || { echo "Configured runtime patch is unavailable." >&2; exit 1; }
      runtime_profile=hosted
      mkdir -p "$DSH_HOME/profiles/hosted"
      if [ ! -e "$DSH_HOME/profiles/hosted/package.json" ]; then
        cp /opt/dsh/deploy/hosted-workspaces/runtime-profile/package.json "$DSH_HOME/profiles/hosted/package.json"
      fi
      if [ ! -e "$DSH_HOME/profiles/hosted/node_modules" ]; then
        ln -s /opt/dsh/node_modules "$DSH_HOME/profiles/hosted/node_modules"
      fi
      set -- --patch "$HOSTED_RUNTIME_PATCH_FILE" "$@"
      clinical_review=$(node /opt/dsh/deploy/hosted-workspaces/clinical-presets.mjs \
        --required "$HOSTED_RUNTIME_PATCH_FILE")
    fi
    if [ "${HOSTED_MODEL_PROTOCOL:-}" = openai-responses ]; then
      if [ "$clinical_review" = true ]; then
        node /opt/dsh/deploy/hosted-workspaces/company-presets.mjs \
          /opt/dsh /tmp/dsh-company-presets.patch.yml \
          "$DSH_HOME/profiles/$runtime_profile/cordis.patch.yml" --clinical-review
      else
        node /opt/dsh/deploy/hosted-workspaces/company-presets.mjs \
          /opt/dsh /tmp/dsh-company-presets.patch.yml \
          "$DSH_HOME/profiles/$runtime_profile/cordis.patch.yml"
      fi
      set -- --patch /opt/dsh/deploy/hosted-workspaces/company-model.runtime.patch.yml \
        --patch /tmp/dsh-company-presets.patch.yml "$@"
    fi
    if [ "$clinical_review" = true ]; then
      node /opt/dsh/deploy/hosted-workspaces/clinical-presets.mjs \
        /opt/dsh /tmp/dsh-clinical-presets.patch.yml \
        "$DSH_HOME/profiles/$runtime_profile/cordis.patch.yml"
      set -- --patch /tmp/dsh-clinical-presets.patch.yml "$@"
    fi
    exec node /opt/dsh/apps/cli/lib/bin.js --profile "$runtime_profile" \
      --patch /opt/dsh/packages/bundle/synyi-web-app/cordis.patch.yml "$@" \
      --host "$HOSTED_BIND_IP" \
      --port "${HOSTED_RUNTIME_PORT:-3080}" \
      --no-open \
      --public-url "$HOSTED_PUBLIC_URL" \
      --trusted-host "$authority"
    ;;
  *)
    exec "$mode" "$@"
    ;;
esac
