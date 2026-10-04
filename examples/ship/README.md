# Ship flow samples

One small app per supported stack, used by the `ship` CI job (see [docs/ship.md](../../docs/ship.md)):

| Folder         | Stack                               | Port | Health     |
| -------------- | ----------------------------------- | ---- | ---------- |
| `spring-maven` | Spring Boot 4.1 with Maven, Java 21 | 8081 | Actuator   |
| `node`         | Node.js with npm, no dependencies   | 3000 | `/healthz` |
| `python`       | FastAPI served by uvicorn           | 8000 | `/health`  |
| `go`           | Go standard library                 | 8080 | `/healthz` |

None of them has a Dockerfile, CI file, or chart: `kodra-agent ship` adds those.
