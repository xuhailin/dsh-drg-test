#!/bin/sh
# Install pinned BuildKit tools in the non-root CI job without starting Docker.
set -eu

rm -f hosted-build.json hosted-image.env
: "${CI_COMMIT_SHA:?GitLab commit SHA is required}"
: "${HOSTED_DOCKER_MIRROR:?The CI image build requires a Docker image mirror host}"
if [ "$(id -u)" -eq 0 ]; then
  echo 'The image build requires a non-root job user' >&2
  exit 1
fi
if [ ! -w . ]; then
  echo 'The image build requires a writable project checkout' >&2
  exit 1
fi

hosted_builder_dir=$(mktemp -d /tmp/dsh-hosted-builder.XXXXXX)
trap 'rm -rf "$hosted_builder_dir"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$hosted_builder_dir"
mkdir -m 700 "$hosted_builder_dir/tools" "$hosted_builder_dir/run"
export PATH="$hosted_builder_dir/tools:$PATH"
export XDG_RUNTIME_DIR="$hosted_builder_dir/run"
unset DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH

echo 'Hosted image: checking rootless user namespaces'
rootlesskit sh -c 'test "$(id -u)" -eq 0'

echo 'Hosted image: downloading pinned BuildKit tools'
# These linux/amd64 layers belong to moby/buildkit:v0.34.1-rootless.
hosted_archive="$hosted_builder_dir/buildkit.tar.gz"
if ! wget -q -T 60 -O "$hosted_archive" "https://$HOSTED_DOCKER_MIRROR/v2/moby/buildkit/blobs/sha256:b9232ce353952be4ec1a619f30a143abad77c15849fe08ee2048d76a087b08a9"; then
  echo 'Downloading BuildKit v0.34.1 failed' >&2
  exit 1
fi
if ! printf '%s  %s\n' b9232ce353952be4ec1a619f30a143abad77c15849fe08ee2048d76a087b08a9 "$hosted_archive" | sha256sum -c -; then
  echo 'BuildKit archive checksum verification failed' >&2
  exit 1
fi
tar -xzf "$hosted_archive" -C "$hosted_builder_dir/tools" --strip-components=2 usr/bin/buildctl usr/bin/buildkitd usr/bin/buildkit-runc
rm "$hosted_archive"

hosted_wrapper_archive="$hosted_builder_dir/buildkit-wrapper.tar.gz"
if ! wget -q -T 60 -O "$hosted_wrapper_archive" "https://$HOSTED_DOCKER_MIRROR/v2/moby/buildkit/blobs/sha256:568ffaf392598b50b911b61e6f0f97c23d04c27834249a1da0983a244c05919b"; then
  echo 'Downloading the BuildKit daemonless script layer failed' >&2
  exit 1
fi
if ! printf '%s  %s\n' 568ffaf392598b50b911b61e6f0f97c23d04c27834249a1da0983a244c05919b "$hosted_wrapper_archive" | sha256sum -c -; then
  echo 'BuildKit daemonless layer checksum verification failed' >&2
  exit 1
fi
tar -xzf "$hosted_wrapper_archive" -C "$hosted_builder_dir/tools" --strip-components=2 usr/bin/buildctl-daemonless.sh
rm "$hosted_wrapper_archive"
hosted_wrapper="$hosted_builder_dir/tools/buildctl-daemonless.sh"
if ! printf '%s  %s\n' 680e47bc3db72d10b092d41057575b60ec5fc0d6e784bb765cff8f6a7e3e5f6a "$hosted_wrapper" | sha256sum -c -; then
  echo 'BuildKit daemonless script checksum verification failed' >&2
  exit 1
fi
chmod 755 "$hosted_wrapper"

sh deploy/hosted-workspaces/ci-image.sh
