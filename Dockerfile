# syntax=docker/dockerfile:1
#
# DBCanvas Labs — one image, one process: the Go backend with the React SPA embedded.
# Built and run from the repo root (the frontend lives there, the backend in server/).
#
# The deployed shape is deliberately the same as dbcanvas's: a single container holding
# the host's Docker socket, driving the daemon as a sibling (Docker-out-of-Docker). The
# k3d clusters, SeaweedFS containers and networks this app creates are therefore
# siblings of this container, not children — which is why they outlive it and why
# ReapOrphans sweeps them at startup.

# ---- stage 1: build the React SPA ----
FROM node:22-alpine AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src/ ./src/
RUN npm run build      # → /web/dist

# ---- stage 2: build the Go server with the SPA embedded ----
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/*.go ./
# Overwrites the tracked placeholder at server/web/dist/index.html — this is the step
# that turns the binary from "API only" into the whole application.
COPY --from=web /web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /dbonlinetest-server .

# ---- stage 2b: the k3d binary ----
# k3d is a Docker API *client*: it asks the daemon to create the k3s node containers.
# This app already holds the daemon socket, so it runs k3d itself rather than shipping a
# side-car. The binary is static, so it works in the distroless runtime below (which has
# no shell — none is needed, the app execs it directly).
FROM alpine:3.20 AS k3d
ARG K3D_VERSION=v5.8.3
# TARGETARCH is injected by BuildKit only; the legacy builder leaves it unset. Falling back
# to the build machine's own architecture rather than to a hard-coded amd64, so that a
# legacy-builder host gets a k3d that actually runs on it. `/k3d version` below is what
# catches a wrong guess, at build time rather than at first lab.
ARG TARGETARCH
RUN apk add --no-cache curl \
 && arch="${TARGETARCH:-$(apk --print-arch | sed -e 's/^x86_64$/amd64/' -e 's/^aarch64$/arm64/')}" \
 && curl -fsSL -o /k3d "https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/k3d-linux-${arch}" \
 && chmod 0755 /k3d \
 && /k3d version

# ---- stage 3: minimal runtime ----
FROM gcr.io/distroless/static-debian12 AS runtime
COPY --from=build /dbonlinetest-server /dbonlinetest-server
COPY --from=k3d /k3d /usr/local/bin/k3d
# 0.0.0.0 inside the container: who can actually reach it is decided by the publish
# binding in docker-compose.yml, not here.
ENV APP_HOST=0.0.0.0
ENV APP_PORT=8090
ENV K3D_BIN=/usr/local/bin/k3d
ENV DOCKER_SOCK=/var/run/docker.sock
EXPOSE 8090
ENTRYPOINT ["/dbonlinetest-server"]
