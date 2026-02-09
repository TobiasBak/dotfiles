---
name: e2e-k8
description: "Run end-to-end tests against Vitec infrastructure services deployed on Kind Kubernetes cluster. Triggers: 'run e2e k8s tests', 'kubernetes e2e', 'kind e2e', 'e2e-k8'."
license: MIT
compatibility: opencode
---

# e2e-k8

Run end-to-end tests against the Vitec infrastructure services deployed on a local Kind Kubernetes cluster.

## When to use
- When you need to run end-to-end tests against services running in Kubernetes
- When validating the load testing framework works in a K8s environment
- When the user says "run e2e k8s tests", "kubernetes e2e", "kind e2e", or similar

## Dependencies

This skill requires a running Kind cluster with Vitec services. Use the `/setup-k8` skill to set up the cluster before running tests.

## Steps

1. **Ensure cluster is running and healthy**

   Use the `/setup-k8` skill to set up the Kind cluster and deploy services if not already running.

   ```bash
   # Check cluster exists
   kind get clusters | grep -q "^vitec$" || echo "ERROR: Cluster 'vitec' not found. Run /setup-k8 first."

   # Check all pods are ready
   kubectl get pods -n vitec
   kubectl wait --for=condition=ready pod --all -n vitec --timeout=60s
   ```

2. **Verify logs directory is mounted**
   ```bash
   # The Kind extraMounts requires this directory to exist on the host
   mkdir -p .logs/tests

   # Verify the directory exists
   ls -la .logs/tests || echo "ERROR: .logs/tests directory not found"
   ```

3. **Verify services are responding**
   ```bash
   # Port-forward services if not already forwarded
   kubectl port-forward -n vitec svc/converter 8000:8000 &
   kubectl port-forward -n vitec svc/stt 8004:8004 &
   sleep 2

   curl -s http://localhost:8000/openapi.json > /dev/null && echo "converter OK" || echo "converter not ready"
   curl -s http://localhost:8004/openapi.json > /dev/null && echo "stt OK" || echo "stt not ready"
   ```

4. **Run the end-to-end tests**
   ```bash
   K8S=true uv run pytest tests/e2e/ -v

   # For parallel execution (faster):
   K8S=true uv run pytest tests/e2e/ -n 4

   # To include long-running 30s tests:
   K8S=true LONG_TESTS=true uv run pytest tests/e2e/ -v
   ```

5. **Delete cluster when done (optional)**
   ```bash
   kind delete cluster --name vitec
   ```

## Guidelines

- Ensure the cluster is running before executing tests (use `/setup-k8`)
- The `K8S=true` flag enables tests that hit the actual running services
- Without `K8S=true`, only unit and integration tests run (no external calls)
- Check pod status with `kubectl get pods -n vitec` if tests fail
- View logs with `kubectl logs -n vitec deployment/<service-name>` for debugging
