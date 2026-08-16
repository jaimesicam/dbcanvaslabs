# DBCanvas Labs — deployment and dev process control.
#
# The deployed shape is one container: the Go backend with the React SPA embedded,
# holding the host's Docker socket so it can provision real k3d + CNPG lab environments
# as sibling containers. Docker and Docker Compose are the only things the host needs —
# Go, Node and k3d all live inside the image. `make up` is the whole story.
#
# The dev-* targets are the other loop: backend and Vite as two native processes, for
# iterating on the frontend without rebuilding an image. Those need the toolchain.

SHELL := /bin/bash

COMPOSE := docker compose

# Echoed URLs only — the real values come from .env via docker-compose.yml.
APP_PORT ?= $(shell test -f .env && grep -E '^APP_PORT=' .env | cut -d= -f2 || echo 8090)

DEV_BACKEND_PORT  ?= 8090
DEV_FRONTEND_PORT ?= 5174

SERVER_DIR := server
BINARY     := $(SERVER_DIR)/dbonlinetest-server

# The lab toolbox image (toolbox/Dockerfile) — one sibling container per lab environment,
# carrying the tools the minimal k3s node containers lack (jq, curl, psql, openssl, yq).
# Built ahead of time and never at attempt time: provisioning already takes minutes of real
# cluster building, and an apt-get on top of that would be minutes more per attempt. The tag
# is duplicated in server/toolbox.go — bump both together.
TOOLBOX_IMAGE ?= dbcanvas-labs-toolbox
TOOLBOX_TAG   ?= 1
TOOLBOX_REF   := $(TOOLBOX_IMAGE):$(TOOLBOX_TAG)
RUN_DIR    := .run
BACKEND_LOG  := $(RUN_DIR)/backend.log
FRONTEND_LOG := $(RUN_DIR)/frontend.log

# The PID listening on a port — the only reliable handle on "our" dev process.
listener = $$(lsof -tiTCP:$(1) -sTCP:LISTEN 2>/dev/null)

.PHONY: up down restart logs status build clean env toolbox toolbox-ensure \
        dev dev-down dev-restart dev-logs dev-logs-backend dev-logs-frontend dev-build help
.DEFAULT_GOAL := help

## up: build the image if needed and start the app (the deployed shape)
up: env toolbox-ensure
	@$(COMPOSE) up --build -d
	@echo
	@echo "  DBCanvas Labs is up → http://localhost:$(APP_PORT)"
	@echo "  logs: make logs   ·   stop: make down"

## down: stop and remove the app container (lab environments are left running)
down:
	@$(COMPOSE) down
	@echo
	@echo "note: any provisioned lab environment is still running in Docker, but the"
	@echo "      attempt registry is in memory, so it is no longer reachable. The next"
	@echo "      'make up' reclaims it automatically; 'make clean' does it now."

## restart: recreate the app container
restart: down up

## logs: follow the app's logs
logs:
	@$(COMPOSE) logs -f

## status: show the app container and any lab environments it owns
status:
	@$(COMPOSE) ps || true
	@echo
	@n=$$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -c '^dbonlinetest-' || true); \
		echo "lab environments: $${n:-0}"; \
		for net in $$(docker network ls --format '{{.Name}}' 2>/dev/null | grep '^dbonlinetest-' || true); do \
			echo "  dbol-$${net#dbonlinetest-}"; \
		done

## build: build both images without starting anything
build: env toolbox
	@$(COMPOSE) build

## toolbox: (re)build the lab toolbox image
#
# Built on the host daemon rather than inside the app image, because lab environments are
# siblings of the app container: the toolbox has to exist where the k3d nodes do.
toolbox:
	@echo "building $(TOOLBOX_REF) …"
	@docker build -t $(TOOLBOX_REF) toolbox
	@echo "built $(TOOLBOX_REF)"

# Build only when the tag is missing, so `make up` stays quick on an unchanged checkout.
# Use `make toolbox` to force a rebuild after editing toolbox/.
toolbox-ensure:
	@docker image inspect $(TOOLBOX_REF) >/dev/null 2>&1 \
		|| $(MAKE) --no-print-directory toolbox

## env: create .env from .env.example (only if missing)
env:
	@test -f .env || { cp .env.example .env && echo "Created .env from .env.example"; }

## clean: stop the app, then tear down every lab environment it owns
#
# Docker-only on purpose: the host is not required to have k3d installed, so this
# removes a cluster's real objects by name rather than asking k3d to do it. A k3d
# cluster is just containers (k3d-<cluster>-server-0 / -agent-N / -serverlb), an image
# volume, and the network — plus this app's own SeaweedFS and toolbox containers per
# attempt. Both are attached to the attempt's network, so leaving either behind makes the
# network removal below fail and leaks a /16.
clean: down
	@echo
	@for net in $$(docker network ls --format '{{.Name}}' 2>/dev/null | grep '^dbonlinetest-' || true); do \
		id=$${net#dbonlinetest-}; \
		echo "deleting lab environment dbol-$$id …"; \
		ids=$$(docker ps -aq --filter "name=^/k3d-dbol-$$id-" 2>/dev/null); \
		[ -n "$$ids" ] && docker rm -f $$ids >/dev/null 2>&1 || true; \
		docker rm -f seaweedfs-$$id toolbox-$$id >/dev/null 2>&1 || true; \
		docker volume rm k3d-dbol-$$id-images >/dev/null 2>&1 || true; \
		docker network rm $$net >/dev/null 2>&1 || true; \
	done
	@ids=$$(docker ps -aq --filter "name=^/k3d-dbol-" 2>/dev/null); \
		[ -n "$$ids" ] && docker rm -f $$ids >/dev/null 2>&1 && echo "removed stray k3d-dbol-* containers" || true
	@echo "lab environments cleared (cached images are kept — they keep provisioning fast)"

# ------------------------------------------------------------------ native dev loop

## dev: run backend + Vite natively (needs Go, Node and k3d on the host)
dev: $(RUN_DIR) dev-build
	@if [ -n "$(call listener,$(DEV_BACKEND_PORT))" ]; then \
		echo "backend   already running on :$(DEV_BACKEND_PORT)"; \
	else \
		echo "starting backend on :$(DEV_BACKEND_PORT) …"; \
		( cd $(SERVER_DIR) && APP_PORT=$(DEV_BACKEND_PORT) nohup ./dbonlinetest-server >> ../$(BACKEND_LOG) 2>&1 & ) ; \
	fi
	@if [ -n "$(call listener,$(DEV_FRONTEND_PORT))" ]; then \
		echo "frontend  already running on :$(DEV_FRONTEND_PORT)"; \
	else \
		echo "starting frontend on :$(DEV_FRONTEND_PORT) …"; \
		nohup npm run dev >> $(FRONTEND_LOG) 2>&1 & \
	fi
	@$(MAKE) --no-print-directory _dev-wait
	@echo
	@echo "  open http://localhost:$(DEV_FRONTEND_PORT)  (Vite proxies /api to :$(DEV_BACKEND_PORT))"
	@echo "  logs: make dev-logs"

# Poll rather than sleep a fixed amount: the backend sweeps orphaned lab clusters from a
# previous run before it starts listening, which can take a few seconds.
_dev-wait:
	@for i in $$(seq 1 60); do \
		if [ -n "$(call listener,$(DEV_BACKEND_PORT))" ] && [ -n "$(call listener,$(DEV_FRONTEND_PORT))" ]; then exit 0; fi; \
		sleep 0.5; \
	done; \
	echo "timed out waiting for both to listen — check 'make dev-logs'"; exit 1

## dev-down: stop the native backend and frontend
dev-down:
	@for p in $(DEV_BACKEND_PORT) $(DEV_FRONTEND_PORT); do \
		pid=$$(lsof -tiTCP:$$p -sTCP:LISTEN 2>/dev/null); \
		if [ -n "$$pid" ]; then \
			kill $$pid 2>/dev/null || true; \
			for i in $$(seq 1 20); do \
				kill -0 $$pid 2>/dev/null || break; \
				sleep 0.25; \
			done; \
			kill -0 $$pid 2>/dev/null && kill -9 $$pid 2>/dev/null || true; \
			echo "stopped :$$p"; \
		else \
			echo ":$$p was not running"; \
		fi; \
	done

## dev-restart: stop both native processes, then start them again
dev-restart:
	@$(MAKE) --no-print-directory dev-down
	@echo
	@$(MAKE) --no-print-directory dev

## dev-logs: follow both native process logs
dev-logs:
	@touch $(BACKEND_LOG) $(FRONTEND_LOG)
	@tail -f $(BACKEND_LOG) $(FRONTEND_LOG)

## dev-logs-backend: follow the native backend log only
dev-logs-backend:
	@touch $(BACKEND_LOG); tail -f $(BACKEND_LOG)

## dev-logs-frontend: follow the native frontend log only
dev-logs-frontend:
	@touch $(FRONTEND_LOG); tail -f $(FRONTEND_LOG)

## dev-build: compile the backend binary and install frontend deps if needed
dev-build: $(BINARY) node_modules

# The backend is run as a compiled binary rather than `go run .`, deliberately: `go run`
# builds a temporary binary and execs it as a *child*, so stopping "the process" leaves
# the real server listening and orphans every lab environment it owns. One binary, one PID.
$(BINARY): $(wildcard $(SERVER_DIR)/*.go) $(SERVER_DIR)/go.mod
	@echo "building backend …"
	@cd $(SERVER_DIR) && go build -o dbonlinetest-server .

node_modules: package.json
	@echo "installing frontend dependencies …"
	@npm install
	@touch node_modules

$(RUN_DIR):
	@mkdir -p $(RUN_DIR)

## help: list the available targets
help:
	@echo "DBCanvas Labs"
	@echo
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  make /' | sed 's/: /\t— /' | expand -t 26
	@echo
	@echo "  deployed: http://localhost:$(APP_PORT)   (docker + docker compose only)"
	@echo "  dev:      http://localhost:$(DEV_FRONTEND_PORT)   (needs Go, Node and k3d on the host)"
