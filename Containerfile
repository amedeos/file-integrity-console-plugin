# Three stages, one image: the compiled plugin assets and the Go binary that
# serves them. The console fetches the assets from this service and proxies the
# file-retrieve API to the same port, so shipping them separately would buy
# nothing but a second Deployment to keep in sync.

# ---------------------------------------------------------------- web assets
FROM registry.access.redhat.com/ubi9/nodejs-22:latest AS web

USER 0
WORKDIR /opt/app-root/src

# Dependencies first, so editing a component does not re-resolve the tree.
# .yarn/releases carries the pinned Yarn 4 binary (yarnPath in .yarnrc.yml);
# there is no corepack download at build time, which also means no network
# beyond the registry.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
RUN node .yarn/releases/yarn-4.14.1.cjs install --immutable

COPY tsconfig.json webpack.config.ts console-extensions.json ./
COPY locales ./locales
COPY src ./src
RUN node .yarn/releases/yarn-4.14.1.cjs build

# ------------------------------------------------------------------- backend
FROM registry.access.redhat.com/ubi9/go-toolset:1.24 AS backend

USER 0
WORKDIR /opt/app-root/src

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./
# CGO off: the runtime image is ubi-minimal and we want a binary that does not
# depend on which glibc happens to be in it.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
      -o /tmp/file-integrity-console-plugin ./cmd/server

# ------------------------------------------------------------------- runtime
FROM registry.access.redhat.com/ubi9/ubi-minimal:latest

LABEL name="file-integrity-console-plugin" \
      summary="OpenShift console plugin for the File Integrity Operator" \
      description="Node-by-node view of Red Hat File Integrity Operator (AIDE) scan results." \
      io.k8s.display-name="File Integrity Console Plugin" \
      io.openshift.tags="openshift,console-plugin,file-integrity,compliance"

COPY --from=backend /tmp/file-integrity-console-plugin /usr/bin/file-integrity-console-plugin
COPY --from=web /opt/app-root/src/dist /opt/app-root/web
COPY LICENSE /licenses/LICENSE

# Arbitrary non-root UID, as OpenShift's restricted-v2 SCC assigns one anyway.
# Nothing is written at runtime, so the chart can and does set
# readOnlyRootFilesystem.
USER 1001
EXPOSE 9443

ENTRYPOINT ["/usr/bin/file-integrity-console-plugin"]
