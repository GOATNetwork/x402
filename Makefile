# Top-level Makefile for the canton/initial-port branch.
# Targets are canton-related only; per-package upstream builds are unaffected.

.PHONY: help canton-up canton-down canton-smoke canton-e2e build test clean

help: ## Show this help
	@awk 'BEGIN{FS=":.*##"; printf "Usage: make <target>\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

canton-up: ## Start Canton localnet (docker)
	@bash scripts/canton-up.sh

canton-down: ## Stop Canton localnet
	@bash scripts/canton-down.sh

canton-smoke: canton-up ## Build DAR + upload + allocate parties + mint initial Holding
	@bash scripts/canton-smoke.sh

canton-init: ## Mint initial Holding into Alice's wallet (post-`compose up`)
	@bash scripts/canton-init.sh

canton-e2e: ## End-to-end smoke (canton localnet round-trip)
	@bash scripts/e2e-smoke.sh

build: ## Build all Go modules on this branch
	@go build ./...

test: ## Run Go tests across all canton modules
	@go test ./goatx402-receipt/... ./goatx402-facilitator/... ./goatx402-merchant/... ./goatx402-canton-cli/... -count=1

clean: ## Remove build artefacts + state dir (does NOT touch the canton docker volume)
	@rm -rf goatx402-facilitator/bin goatx402-merchant/bin goatx402-canton-cli/bin
	@rm -rf state logs/e2e
