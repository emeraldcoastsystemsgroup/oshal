# Docker to Kubernetes test app

This folder is a tiny self-contained demo that shows the exact workflow we want for larger services later:

1. Build the app into a Docker image locally.
2. Run it with Docker Compose.
3. Reuse the same image in Kubernetes.

## Files

- `server.js` - tiny Node HTTP app with `/` and `/health`
- `Dockerfile` - container image definition
- `docker-compose.yml` - local Docker runtime
- `k8s/` - Kubernetes manifests for the same image

## Run in Docker locally

From PowerShell:

```powershell
Set-Location examples/docker-k8s-test-app
docker compose up --build -d
curl.exe http://localhost:8081/health
curl.exe http://localhost:8081/
```

Stop it:

```powershell
docker compose down
```

## Move the same image to Kubernetes

Build the image first:

```powershell
docker build -t oshal-test-app:local .
```

If you use Docker Desktop Kubernetes, that local image is usually available directly.

If you use `kind`, load the image into the cluster:

```powershell
kind load docker-image oshal-test-app:local
```

Apply the manifests:

```powershell
kubectl apply -k .\k8s
kubectl get pods -n oshal-demo
kubectl port-forward -n oshal-demo service/oshal-test-app 8081:80
```

Then open:

- `http://localhost:8081/health`
- `http://localhost:8081/`

## Why this helps

This is the smallest possible example of the pattern we want for your real services:

- one app
- one image
- local Docker first
- same container promoted into Kubernetes
