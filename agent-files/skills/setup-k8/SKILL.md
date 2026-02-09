---
name: setup-k8
description: "Set up a local Kind Kubernetes cluster with Vitec infrastructure services. Triggers: 'setup k8s cluster', 'kind setup', 'create kind cluster', 'setup-k8'."
license: MIT
compatibility: opencode
---

# setup-k8

Set up and manage a local Kind Kubernetes cluster with Vitec infrastructure services.

## When to use
- When you need to set up a Kind cluster for development or testing
- When deploying Vitec services to a local Kubernetes environment
- When the user says "setup k8s cluster", "kind setup", "create kind cluster", or similar
- Before running end-to-end tests that require a Kubernetes environment

## Prerequisites

- Docker installed and running
- Kind installed (`kind` CLI available)
- kubectl installed and configured
- The infrastructure repository must exist at `../thesis-vitec-infrastructure` relative to this project

## Services

The Kubernetes deployment runs these services in the `vitec` namespace:

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

1. **Check if Kind cluster already exists**
   ```bash
   kind get clusters 2>/dev/null | grep -q "^vitec$" && echo "Cluster 'vitec' already exists" || echo "Cluster needs to be created"
   ```

2. **Ensure logs directory exists**
   ```bash
   # The Kind extraMounts requires this directory to exist on the host
   mkdir -p .logs/tests
   ```

3. **Create Kind cluster (only if not already running)**
   ```bash
   # Use local kind-config.yaml which includes extraMounts for test logs
   if ! kind get clusters 2>/dev/null | grep -q "^vitec$"; then
     kind create cluster --config k8s/kind-config.yaml --name vitec
   fi
   ```

   Note: The local `k8s/kind-config.yaml` includes extraMounts that map `.logs/tests`
   into the Kind node for persistent test result storage.

4. **Build and load Docker image**
   ```bash
   cd ../thesis-vitec-infrastructure
   docker build -t vitec-service-base .
   kind load docker-image vitec-service-base --name vitec
   ```

5. **Apply Kubernetes manifests**
   ```bash
   cd ../thesis-vitec-infrastructure
   kubectl apply -f k8s/namespace.yaml
   kubectl apply -f k8s/configmap.yaml
   kubectl apply -f k8s/shared-data-pvc.yaml
   kubectl apply -f k8s/services/
   ```

6. **Wait for pods to be ready**
   ```bash
   kubectl wait --for=condition=ready pod --all -n vitec --timeout=120s
   ```

## Guidelines

- Always check if the cluster exists before creating to avoid errors
- Use `kubectl wait` to ensure pods are ready before proceeding
- Check pod status with `kubectl get pods -n vitec` if deployment fails
- View logs with `kubectl logs -n vitec deployment/<service-name>` for debugging
- Restart deployments with `kubectl rollout restart deployment/<name> -n vitec`

## Useful Commands

```bash
# Check cluster status
kind get clusters

# Check pod status
kubectl get pods -n vitec

# View logs for a service
kubectl logs -n vitec deployment/gui

# Describe a pod for debugging
kubectl describe pod -n vitec <pod-name>

# Restart a deployment
kubectl rollout restart deployment/gui -n vitec

# Get all resources in namespace
kubectl get all -n vitec

# Delete the cluster
kind delete cluster --name vitec
```
