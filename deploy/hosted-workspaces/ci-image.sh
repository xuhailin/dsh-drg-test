#!/bin/sh
# Validate the final image for the checked GitLab commit without uploading it.
set -eu

# A failed retry must not retain reports from an earlier invocation.
rm -f hosted-build.json hosted-image.env

: "${CI_COMMIT_SHA:?GitLab commit SHA is required}"

# The daemonless wrapper splits BUILDKITD_FLAGS, so its config path cannot contain spaces.
hosted_build_dir=$(mktemp -d /tmp/dsh-hosted-build.XXXXXX)
trap 'rm -rf "$hosted_build_dir"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$hosted_build_dir"
umask 077

if [ -n "${HOSTED_DOCKER_MIRROR:-}" ]; then
  hosted_mirror_host=${HOSTED_DOCKER_MIRROR%%:*}
  hosted_mirror_port=${HOSTED_DOCKER_MIRROR#"$hosted_mirror_host"}
  case "$hosted_mirror_host" in
    ''|[!A-Za-z0-9]*|*[!A-Za-z0-9]|*[!A-Za-z0-9.-]*)
      echo 'HOSTED_DOCKER_MIRROR must be a DNS host or IPv4 address with an optional numeric port' >&2
      exit 1
      ;;
  esac
  case "$hosted_mirror_port" in
    :|:*[!0-9]*)
      echo 'HOSTED_DOCKER_MIRROR must be a DNS host or IPv4 address with an optional numeric port' >&2
      exit 1
      ;;
  esac
  printf '[registry."docker.io"]\n  mirrors = ["%s"]\n' "$HOSTED_DOCKER_MIRROR" > "$hosted_build_dir/buildkitd.toml"
  BUILDKITD_FLAGS="${BUILDKITD_FLAGS:+$BUILDKITD_FLAGS }--config=$hosted_build_dir/buildkitd.toml"
  export BUILDKITD_FLAGS
fi

echo 'Hosted image: checking BuildKit worker readiness'
buildctl-daemonless.sh debug workers
mkdir "$hosted_build_dir/preflight"
printf '# syntax=docker/dockerfile:1\nFROM node:24.21.0-bookworm-slim\nRUN true\n' > "$hosted_build_dir/preflight/Dockerfile"
echo 'Hosted image: building the frontend and snapshotter preflight'
buildctl-daemonless.sh build \
  --frontend dockerfile.v0 \
  --local "context=$hosted_build_dir/preflight" \
  --local "dockerfile=$hosted_build_dir/preflight" \
  --opt platform=linux/amd64 \
  --output "type=image,name=dsh-hosted-preflight:$CI_COMMIT_SHA,push=false"

hosted_image="dsh-hosted-workspaces:$CI_COMMIT_SHA"
echo 'Hosted image: building the complete application image without uploading'
buildctl-daemonless.sh build \
  --frontend dockerfile.v0 \
  --local context=. \
  --local dockerfile=deploy/hosted-workspaces \
  --opt "build-arg:DSH_SOURCE_COMMIT=$CI_COMMIT_SHA" \
  --opt platform=linux/amd64 \
  --metadata-file "$hosted_build_dir/hosted-build.json" \
  --output "type=image,name=$hosted_image,push=false"

mv "$hosted_build_dir/hosted-build.json" hosted-build.json
