# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash bubblewrap ca-certificates curl git poppler-utils procps python3 ripgrep util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.28.5

FROM base AS build
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential musl-tools \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/dsh
COPY . .
ARG DSH_SOURCE_COMMIT
ENV CI=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN test -n "$DSH_SOURCE_COMMIT" \
    || { echo 'DSH_SOURCE_COMMIT is required; use deploy/hosted-workspaces/build-image.sh' >&2; exit 1; }
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @deepseek-ai/node-addon-system-workspace run build:native
RUN DSH_CLIENT_COMMIT_HASH="$DSH_SOURCE_COMMIT" node deploy/hosted-workspaces/build-artifacts.mjs

FROM base AS runtime
WORKDIR /opt/dsh
COPY --from=build /opt/dsh /opt/dsh
RUN install -d -o node -g node -m 700 /home/node/.dsh /home/node/.agents \
    && install -d -o node -g node -m 700 /home/node/workspace \
    && chmod 700 /home/node \
    && chmod 755 /opt/dsh/deploy/hosted-workspaces/entrypoint.sh
ENV HOME=/home/node \
    DSH_HOME=/home/node/.dsh \
    DSH_AGENTS_HOME=/home/node/.agents \
    PATH=/opt/dsh/node_modules/.bin:$PATH \
    NARB_DISABLE_NATIVE_CACHE=1 \
    NODE_ENV=production
USER 1000:1000
WORKDIR /home/node/workspace
EXPOSE 3080
ENTRYPOINT ["/opt/dsh/deploy/hosted-workspaces/entrypoint.sh"]
CMD ["runtime"]
