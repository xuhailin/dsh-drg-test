#!/bin/sh
# Install pinned BuildKit tools in the non-root CI job without starting Docker.
set -eu

rm -f hosted-build.json hosted-image.env
: "${CI_COMMIT_SHA:?GitLab commit SHA is required}"
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
hosted_archive="$hosted_builder_dir/buildkit.tar.gz"
if ! wget -q -T 60 -O "$hosted_archive" https://github.com/moby/buildkit/releases/download/v0.34.1/buildkit-v0.34.1.linux-amd64.tar.gz; then
  echo 'Downloading BuildKit v0.34.1 failed' >&2
  exit 1
fi
if ! printf '%s  %s\n' a59539daf547fe0958efe2d07e41c0a6944e1112a66d7e519ec1cf5b673ef15b "$hosted_archive" | sha256sum -c -; then
  echo 'BuildKit archive checksum verification failed' >&2
  exit 1
fi
tar -xzf "$hosted_archive" -C "$hosted_builder_dir/tools" --strip-components=1 bin/buildctl bin/buildkitd bin/buildkit-runc
rm "$hosted_archive"

hosted_wrapper="$hosted_builder_dir/tools/buildctl-daemonless.sh"
if ! wget -q -T 60 -O "$hosted_wrapper" https://raw.githubusercontent.com/moby/buildkit/v0.34.1/examples/buildctl-daemonless/buildctl-daemonless.sh; then
  echo 'Downloading the BuildKit daemonless script failed' >&2
  exit 1
fi
if ! printf '%s  %s\n' 680e47bc3db72d10b092d41057575b60ec5fc0d6e784bb765cff8f6a7e3e5f6a "$hosted_wrapper" | sha256sum -c -; then
  echo 'BuildKit daemonless script checksum verification failed' >&2
  exit 1
fi
chmod 755 "$hosted_wrapper"

sh deploy/hosted-workspaces/ci-image.sh
