# Multi-stage build for the goatx402-merchant binary.
# Same pattern as goatx402-facilitator/Dockerfile.

# syntax=docker/dockerfile:1.7

FROM golang:1.25-bookworm AS builder

WORKDIR /src

# Slim workspace — only what merchant needs.
COPY goatx402-sdk-server-go/ ./goatx402-sdk-server-go/
COPY goatx402-receipt/ ./goatx402-receipt/
COPY goatx402-merchant/ ./goatx402-merchant/

RUN cat > go.work <<'EOF'
go 1.25.0

use (
	./goatx402-sdk-server-go
	./goatx402-receipt
	./goatx402-merchant
)
EOF

RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    cd goatx402-merchant && go build -o /out/merchant ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/merchant /usr/local/bin/merchant
EXPOSE 7070
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/merchant"]
