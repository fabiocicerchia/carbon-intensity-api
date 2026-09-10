# The version code-quality.yml pins, so `make lint` and CI cannot disagree
# about what the rules are. The rules themselves live in biome.jsonc.
BIOME_VERSION := 2.5.6
PORT ?= 8000

# Every verb this repository exposes lives here; `make` on its own prints them.
# FC-GEN-057: the same eight verbs in every repo, each either wired or a
# declared no-op that says why. None of them exit 0 quietly.

.DEFAULT_GOAL := help

.PHONY: help setup install build run test lint format analyze sync verify

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

# The offline pipeline, deliberately: it builds data/ from the committed annual
# snapshot, so it is reproducible and needs no provider tokens. `make sync` is
# the one that goes to the network.
build: ## Build data/ from the annual snapshot, no network
	npm run pipeline:offline

run: ## Serve data/ locally on PORT (default 8000)
	PORT=$(PORT) npm run serve

test: ## Run the tests (node:test)
	npm test

lint: ## Lint and check formatting, at the pinned biome version
	npx --yes @biomejs/biome@$(BIOME_VERSION) ci --files-ignore-unknown=true --no-errors-on-unmatched .

format: ## Rewrite the tree with biome, at the same pinned version
	npx --yes @biomejs/biome@$(BIOME_VERSION) format --write .

sync: ## Build with live providers and push data/ to the bucket
	./sync.sh

verify: ## Check every provider still answers as the pipeline expects
	npm run verify

# --- Declared no-ops (FC-GEN-058) ---
# These exit 0 and say why. They are listed under "Not applicable" in the README.

setup: ## Not applicable — there is nothing to set up
	@echo "Nothing to set up: Node >= 20 is the only requirement, and there is no"
	@echo "pre-commit config in this repo. See README > Not applicable."

install: ## Not applicable — this project has no dependencies
	@echo "Nothing to install: package.json declares no dependencies and no dev"
	@echo "dependencies, on purpose. See README > Not applicable."

analyze: ## Not applicable — there is nothing a scanner would find
	@echo "Nothing to scan: no dependencies, so no dependency vulnerabilities."
	@echo "CodeQL reads the source from .github/workflows/codeql.yml."
	@echo "See README > Not applicable."
