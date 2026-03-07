MISE_EXEC := mise exec --
GO := $(MISE_EXEC) go
BUN := $(MISE_EXEC) bun
GOLANGCI_LINT := $(MISE_EXEC) golangci-lint
GOVULNCHECK := $(MISE_EXEC) govulncheck

.PHONY: dev deps down build go-build web web-install web-check web-test web-build web-dev fmt lint lint-fix vuln test e2e e2e-cluster examples check check-all cluster cluster-down docs-dev docs-build

dev:
	docker compose --profile dev up --build

cluster:
	docker compose --profile cluster up --build

deps:
	docker compose up -d

down:
	docker compose --profile dev down -v

cluster-down:
	docker compose --profile cluster down -v

build:
	docker build -t strata:dev .

web-install:
	cd web && $(BUN) install

web-check:
	cd web && $(BUN) run check
	cd web && $(BUN) run typecheck
	cd web/apps/api && $(BUN) test

web-build:
	cd web/apps/ui && $(BUN) run build

web-dev:
	cd web/apps/api && $(BUN) run dev

go-build:
	$(GO) build ./...

fmt:
	$(GOLANGCI_LINT) run --fix ./...

lint:
	$(GOLANGCI_LINT) run ./...

lint-fix:
	$(GOLANGCI_LINT) run --fix ./...

vuln:
	$(GOVULNCHECK) ./...

test:
	$(GO) test -race -count=1 ./...

e2e:
	$(GO) test -race -count=1 -tags=e2e -timeout=15m -v ./e2e/...

e2e-cluster:
	docker compose --profile cluster up --build -d
	@echo "Waiting for cluster..."
	@until curl -sf http://localhost:8080/healthz > /dev/null 2>&1; do sleep 1; done
	STRATA_E2E_URL=http://localhost:8080 $(GO) test -race -count=1 -tags=e2e -timeout=15m -v ./e2e/...; \
	status=$$?; \
	docker compose --profile cluster down -v; \
	exit $$status

examples:
	$(GO) test -race -count=1 -tags=e2e -timeout=15m -v -run TestExamples ./e2e/...

check: lint vuln go-build test

check-web: web-install web-check

check-all: check check-web e2e

docs-dev:
	cd docs && npm run dev

docs-build:
	cd docs && npm run build
