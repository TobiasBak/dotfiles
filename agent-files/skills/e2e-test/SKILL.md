---
name: e2e-test
description: "Run end-to-end tests against Vitec infrastructure services. Triggers: 'run e2e tests', 'end-to-end test', 'test against infrastructure', 'run integration tests', 'e2e'."
license: MIT
compatibility: opencode
---

# e2e-test

Run end-to-end tests against the Vitec infrastructure services running in Docker containers.

## When to use
- When you need to run end-to-end tests against the actual services
- When validating the load testing framework works against real endpoints
- When the user says "run e2e tests", "end-to-end test", or similar

## Prerequisites

The infrastructure repository must exist at `../thesis-vitec-infrastructure` relative to this project.

## Services

The docker-compose.yml runs these services:

| Service | Port | Description |
|---------|------|-------------|
| converter | 8000 | Base converter service |
| word-prediction | 8001 | Word prediction API |
| ocr | 8002 | OCR service |
| word-list | 8003 | Word list service |
| stt | 8004 | Speech-to-text API |
| voice-service | 8005 | Voice service |
| grammar | 8006 | Grammar checking |
| dictionary | 8007 | Dictionary service |
| word-info | 8008 | Word info service |
| gui | 8501 | Streamlit GUI |

## Steps

1. **Start the infrastructure containers**
   ```bash
   cd ../thesis-vitec-infrastructure && docker compose up -d
   ```

2. **Wait for services to be healthy**
   ```bash
   # Check if services are responding
   curl -s http://localhost:8000/health || echo "converter not ready"
   curl -s http://localhost:8004/health || echo "stt not ready"
   ```

3. **Run the end-to-end tests**
   ```bash
   cd ../thesis-project
   E2E=true uv run pytest tests/ -v
   ```

4. **Stop containers when done (optional)**
   ```bash
   cd ../thesis-vitec-infrastructure && docker compose down
   ```

## Guidelines

- Always ensure containers are running before executing tests
- Use `docker compose up -d` to run containers in detached mode
- Check service health before running tests to avoid false failures
- The `E2E=true` flag enables tests that hit the actual running services
- Without `E2E=true`, only unit and integration tests run (no external calls)
