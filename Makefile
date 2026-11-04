# QAtlas — build, test and packaging entry points (deployment: deploy/README.md).
#
#   make dev-db      Postgres for local development (127.0.0.1:55432)
#   make build       web (real API mode) + runner + backend binary → dist/
#   make test        go test + web unit tests + runner tests
#   make docker      qatlas-server / qatlas-worker images
#   make release     dist/qatlas-<version>-linux-<arch>.tar.gz for deploy/install.sh
#
# Override VERSION=…, GOARCH=…, IMAGE_PREFIX=registry.example.com/ as needed.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
GOARCH ?= amd64
IMAGE_PREFIX ?=
PNPM ?= corepack pnpm
GO ?= go
DOCKER ?= docker

DIST := $(CURDIR)/dist
RELEASE_NAME := qatlas-$(VERSION)-linux-$(GOARCH)
RELEASE_DIR := $(DIST)/$(RELEASE_NAME)
LDFLAGS := -s -w -X main.version=$(VERSION)

export COREPACK_ENABLE_DOWNLOAD_PROMPT := 0

.PHONY: help deps dev-db dev-db-down build build-web build-runner build-backend \
	test test-backend test-web test-runner docker docker-server docker-worker release clean

help: ## list targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

# Re-install workspace dependencies only when the lockfile changes.
node_modules/.modules.yaml: pnpm-lock.yaml package.json web/package.json runner/package.json demo-target/package.json
	$(PNPM) install --frozen-lockfile
	@touch $@

deps: node_modules/.modules.yaml ## install workspace dependencies (pnpm, frozen lockfile)

dev-db: ## start the development Postgres (deploy/docker-compose.dev.yml)
	$(DOCKER) compose -f deploy/docker-compose.dev.yml up -d

dev-db-down: ## stop the development Postgres (data volume is kept)
	$(DOCKER) compose -f deploy/docker-compose.dev.yml down

# ------------------------------------------------------------------ build ---
build: build-web build-runner build-backend ## web + runner + backend → dist/
	@echo "built $(VERSION): dist/qatlas, dist/web, runner/dist"

# The real-mode SPA goes to dist/web so it never clobbers web/dist (the mock-mode
# build used by the web e2e tests).
build-web: deps ## SPA in real API mode → dist/web
	cd web && $(PNPM) exec tsc -b
	cd web && VITE_API_MODE=real $(PNPM) exec vite build --outDir $(DIST)/web --emptyOutDir

build-runner: deps ## runner (TypeScript) → runner/dist
	$(PNPM) --filter @qatlas/runner build

build-backend: ## qatlas binary (static, CGO off) → dist/qatlas
	@mkdir -p $(DIST)
	cd backend && CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(DIST)/qatlas ./cmd/qatlas

# ------------------------------------------------------------------- test ---
test: test-backend test-web test-runner ## all test suites

# Integration tests need QATLAS_TEST_DATABASE_URL (make dev-db); they skip without it.
test-backend: ## go vet + go test ./...
	cd backend && $(GO) vet ./... && $(GO) test ./...

test-web: deps ## web unit tests (vitest)
	$(PNPM) --filter web test

test-runner: deps ## runner integration tests (needs Playwright 1.64.1 browsers)
	$(PNPM) --filter @qatlas/runner test

# ----------------------------------------------------------------- docker ---
docker: docker-server docker-worker ## build both images, tagged $(VERSION)

docker-server:
	$(DOCKER) build -f deploy/Dockerfile.server --build-arg VERSION=$(VERSION) \
		-t $(IMAGE_PREFIX)qatlas-server:$(VERSION) .

docker-worker:
	$(DOCKER) build -f deploy/Dockerfile.worker --build-arg VERSION=$(VERSION) \
		-t $(IMAGE_PREFIX)qatlas-worker:$(VERSION) .

# ---------------------------------------------------------------- release ---
# Layout (what deploy/install.sh expects):
#   VERSION  bin/qatlas  web/  runner/{dist,package.json,package-lock.json}
#   deploy/{install.sh,rollback.sh,qatlas.env.example,README.md,systemd/*.service}
# runner/package-lock.json is generated for the production dependency only
# (playwright, pinned exactly), so the target host needs just node + npm.
release: build-web build-runner ## tarball for manual installs → dist/qatlas-<version>-linux-<arch>.tar.gz
	rm -rf $(RELEASE_DIR) $(RELEASE_DIR).tar.gz $(RELEASE_DIR).tar.gz.sha256
	mkdir -p $(RELEASE_DIR)/bin $(RELEASE_DIR)/runner $(RELEASE_DIR)/deploy/systemd
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=$(GOARCH) $(GO) build -trimpath -ldflags "$(LDFLAGS)" \
		-o $(RELEASE_DIR)/bin/qatlas ./cmd/qatlas
	cp -R $(DIST)/web $(RELEASE_DIR)/web
	cp -R runner/dist $(RELEASE_DIR)/runner/dist
	node -e 'const p=require("./runner/package.json"); const {name,version,description,type,main,engines,dependencies}=p; process.stdout.write(JSON.stringify({name,version,private:true,description,type,main,engines,dependencies},null,2)+"\n")' > $(RELEASE_DIR)/runner/package.json
	cd $(RELEASE_DIR)/runner && npm install --package-lock-only --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
	cp deploy/install.sh deploy/rollback.sh deploy/qatlas.env.example deploy/README.md $(RELEASE_DIR)/deploy/
	cp deploy/systemd/*.service $(RELEASE_DIR)/deploy/systemd/
	chmod 0755 $(RELEASE_DIR)/deploy/install.sh $(RELEASE_DIR)/deploy/rollback.sh
	printf '%s\n' "$(VERSION)" > $(RELEASE_DIR)/VERSION
	tar -C $(DIST) --owner=0 --group=0 --numeric-owner -czf $(RELEASE_DIR).tar.gz $(RELEASE_NAME)
	cd $(DIST) && sha256sum $(RELEASE_NAME).tar.gz > $(RELEASE_NAME).tar.gz.sha256
	@echo "release: $(RELEASE_DIR).tar.gz"

clean: ## remove dist/
	rm -rf $(DIST)
