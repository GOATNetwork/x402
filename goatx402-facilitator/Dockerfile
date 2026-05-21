# Multi-stage build for the goatx402-facilitator binary.
#
# Builder stage compiles inside the upstream Go 1.25 image; we copy the
# canton port's go.work + every module it lists in so Go's workspace mode
# can resolve cross-module imports (goatx402-receipt, ../goatx402-facilitator).
#
# Runtime is distroless/static-debian12 — no shell, no package manager,
# tiny attack surface.

# syntax=docker/dockerfile:1.7

FROM golang:1.25-bookworm AS builder

WORKDIR /src

# Copy only the modules facilitator actually needs. Generate a slim
# go.work inside the builder so the missing siblings (merchant,
# canton-cli) don't fail workspace resolution.
COPY goatx402-sdk-server-go/ ./goatx402-sdk-server-go/
COPY goatx402-receipt/ ./goatx402-receipt/
COPY goatx402-facilitator/ ./goatx402-facilitator/

RUN cat > go.work <<'EOF'
go 1.25.0

use (
	./goatx402-sdk-server-go
	./goatx402-receipt
	./goatx402-facilitator
)
EOF

# Pre-fetch all deps so the build step can be incremental.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    cd goatx402-facilitator && go build -o /out/facilitator ./cmd/server

# ---------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/facilitator /usr/local/bin/facilitator

# docs/canton-receipt.schema.json may be referenced by the running facilitator
# at fixture-load time (e.g. for /readyz contract checks).
COPY --from=builder /src/goatx402-facilitator/internal/store/migrations /etc/goatx402/migrations

# The facilitator listens on 8080 by default (config.go).
EXPOSE 8080

# Run as the distroless nonroot user (uid 65532).
USER nonroot:nonroot

ENTRYPOINT ["/usr/local/bin/facilitator"]
