.PHONY: build test test-gateway test-control-plane e2e benchmark run-control-plane run-gateway

# Assumes control-plane's venv is activated for the control-plane/e2e/
# benchmark targets (`python` resolves to it) — see README.md Quickstart.

build:
	cd gateway && npm run build

test: test-gateway test-control-plane

test-gateway:
	cd gateway && npm test

test-control-plane:
	cd control-plane && python -m pytest -v

e2e: build
	python test/integration/run_e2e.py

benchmark: build
	python benchmark/run_benchmark.py

run-control-plane:
	cd control-plane && python -m uvicorn app.main:app --port 8000

run-gateway: build
	cd gateway && node dist/src/index.js
