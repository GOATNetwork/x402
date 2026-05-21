# Multi-stage build for the x402-canton CLI.
# Useful for e2e-runner service in docker-compose, plus baking the same
# binary that local devs would `go build` into a portable image.

# syntax=docker/dockerfile:1.7

FROM golang:1.25-bookworm AS builder

WORKDIR /src

# Slim workspace — only what the CLI needs.
COPY goatx402-sdk-server-go/ ./goatx402-sdk-server-go/
COPY goatx402-receipt/ ./goatx402-receipt/
COPY goatx402-canton-cli/ ./goatx402-canton-cli/

RUN cat > go.work <<'EOF'
go 1.25.0

use (
	./goatx402-sdk-server-go
	./goatx402-receipt
	./goatx402-canton-cli
)
EOF

RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    cd goatx402-canton-cli && \
      CGO_ENABLED=0 GOOS=linux go build -o /out/x402-canton ./cmd/x402-canton

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/x402-canton /usr/local/bin/x402-canton
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/x402-canton"]
