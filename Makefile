MISE_EXEC := mise exec --
GO := $(MISE_EXEC) go
GOLANGCI_LINT := $(MISE_EXEC) golangci-lint
GOVULNCHECK := $(MISE_EXEC) govulncheck

.PHONY: dev deps down build go-build web fmt lint lint-fix vuln test e2e check check-all

dev:
	docker compose --profile dev up --build

deps:
	docker compose up -d

down:
	docker compose --profile dev down -v

build:
	docker build -t strata:dev .

web:
	cd web && npm ci && npm run build

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
	$(GO) test -race -count=1 -tags=e2e -timeout=5m -v ./e2e/...

check: lint vuln go-build test

check-all: check e2e
