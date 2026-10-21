#!/bin/sh
# Validate the final image for the checked GitLab commit without uploading it.
set -eu

# A failed retry must not retain reports from an earlier invocation.
rm -f hosted-build.json hosted-image.env

: "${CI_COMMIT_SHA:?GitLab commit SHA is required}"

hosted_build_dir=$(mktemp -d)
trap 'rm -rf "$hosted_build_dir"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$hosted_build_dir"
umask 077

hosted_image="dsh-hosted-workspaces:$CI_COMMIT_SHA"
buildctl-daemonless.sh build \
  --frontend dockerfile.v0 \
  --local context=. \
  --local dockerfile=deploy/hosted-workspaces \
  --opt "build-arg:DSH_SOURCE_COMMIT=$CI_COMMIT_SHA" \
  --opt platform=linux/amd64 \
  --metadata-file "$hosted_build_dir/hosted-build.json" \
  --output "type=image,name=$hosted_image,push=false"

mv "$hosted_build_dir/hosted-build.json" hosted-build.json
