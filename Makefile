# Todo lo que corre el CI se corre igual aquí: `make ci`. Los pipelines de GitHub y GitLab son envoltorios finos de estos objetivos.
# Requisitos: Node 22, make, Docker (PostgreSQL desechable, escáneres, imagen). `make ayuda` lista los objetivos.
SHELL := /bin/sh
PG ?= 16
.DEFAULT_GOAL := ayuda
.PHONY: ayuda deps lint formato portabilidad test cobertura matriz-pg esquema test-e2e scan auditar build build-multiarch helm-check compose-check sbom alertas pines ci

ayuda: ## Lista los objetivos
	@grep -E "^[a-z0-9-]+:.*## " $(MAKEFILE_LIST) | sed -E "s/:.*## /\t/" | column -t -s "$$(printf '\t')"

deps: ## Instala dependencias (npm ci)
	cd mvp && npm ci

lint: ## ESLint, formato y tipos (tsc --checkJs)
	cd mvp && npm run -s lint && npm run -s formato:verificar && npm run -s tipos

formato: ## Aplica el formato (Prettier)
	cd mvp && npm run -s formato

portabilidad: ## Guardia: sin SDK de proveedor, capas limpias, process.env solo en config
	./scripts/verificar-portabilidad.sh

test: ## Pruebas unitarias y de integración contra PostgreSQL real (PG=14|15|16|17; usa DATABASE_URL si existe)
	./scripts/ci/probar.sh $(PG)

cobertura: ## Cobertura mínima 80 % en dominio/ y aplicacion/
	cd mvp && npm run -s cobertura

matriz-pg: ## Pruebas contra PostgreSQL 14, 15, 16 y 17
	./scripts/ci/matriz-postgres.sh

esquema: ## El esquema se aplica dos veces y migra desde el esquema viejo
	./scripts/ci/esquema-dos-veces.sh

test-e2e: ## Pruebas de navegador (Playwright)
	./scripts/ci/e2e.sh

auditar: ## npm audit (falla con severidad alta) y licencias permitidas
	cd mvp && npm run -s auditar && npm run -s licencias

scan: auditar ## Escaneos: gitleaks, Semgrep, Trivy, Checkov (+ npm audit y licencias)
	./scripts/ci/escanear.sh todo

sbom: ## SBOM CycloneDX en sbom/ipam.cdx.json
	cd mvp && npm run -s sbom

build: ## Construye la imagen (una arquitectura) y la escanea con Trivy
	IPAM_GUARDAR_TAR=1 ./scripts/ci/construir-imagen.sh local
	./scripts/ci/escanear.sh trivy-imagen imagen.tar

build-multiarch: ## Construye amd64 y arm64 (sin publicar)
	./scripts/ci/construir-imagen.sh multiarch

helm-check: ## helm lint y helm template en tres escenarios + kube-linter
	./scripts/ci/helm-check.sh

compose-check: ## docker compose up con healthchecks
	./scripts/ci/compose-check.sh

alertas: ## Valida alertas y dashboard (jq, promtool, tofu validate)
	./scripts/ci/validar-alertas.sh

pines: ## Verifica que los digests y commits fijados existen
	node scripts/ci/verificar-pines.js

ci: portabilidad lint cobertura test esquema helm-check alertas scan sbom build compose-check test-e2e ## TODO lo anterior (lo que corre el CI)
	@echo "make ci: todo en verde"
