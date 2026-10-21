#!/bin/sh
set -eu

deployment_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_dir=$(git -C "$deployment_dir" rev-parse --show-toplevel)
source_commit=$(git -C "$repository_dir" rev-parse HEAD)

exec docker build \
  --file "$deployment_dir/Dockerfile" \
  --tag "${HOSTED_IMAGE:-dsh-hosted-workspaces:local}" \
  --build-arg "DSH_SOURCE_COMMIT=$source_commit" \
  "$@" \
  "$repository_dir"
