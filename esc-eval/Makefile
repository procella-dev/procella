# Procella ESC evaluator Lambda build.
#
# Matches existing Procella Lambda pattern: provided.al2023 runtime with a
# 'bootstrap' binary. Architecture is x86_64 to match infra/api.ts, infra/gc.ts
# (switch to arm64 only when the rest of the Lambdas do).

BUILD_DIR := ../.build/esc-eval
BOOTSTRAP := $(BUILD_DIR)/bootstrap
GO_SOURCES := $(shell find . -name '*.go' -not -path '*/vendor/*')

.PHONY: build clean tidy test

build: $(BOOTSTRAP)

$(BOOTSTRAP): $(GO_SOURCES) go.mod go.sum
	mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
		go build -ldflags="-s -w" -tags lambda.norpc \
		-o $(BOOTSTRAP) ./cmd/lambda

tidy:
	go mod tidy

test:
	go test ./...

clean:
	rm -rf $(BUILD_DIR)
