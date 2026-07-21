// Package log wires the facilitator's structured-logging contract:
//
//   - JSONL output (one event per line, schema-stable order_id correlation)
//   - deep-walk redaction of every name in PLAN.md §9.2 rule 4
//
// PLAN §9.2 rule 4 names (mirrored in Task 10):
//
//     Authorization, X-Payer-Token, ADMIN_TOKEN/X-Admin-Token, X-PAYMENT,
//     signature, publicKey,
//     payload_hash / submissionPayloadHash / receiptPayloadHash,
//     participantSig, dedupId, command_id, payment_request_contract_id
//
// The redaction layer is a slog.Handler middleware that walks every attribute
// tree (including any.Value carrying maps/slices/structs) and rewrites any
// value whose path-leaf key matches the redact list. Surface-key matching is
// not enough — receipt envelopes are routinely logged under
// `order_events.reason`, so the walker must descend through nested
// maps/structs/slices to catch `signature` etc. anywhere in the payload.
package log

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"strings"
)

// RedactedPlaceholder is the literal value swapped in for any redacted leaf.
// Use a stable token so log-shippers and tests can grep for it.
const RedactedPlaceholder = "[REDACTED]"

// SensitiveKeys is the canonical §9.2 rule-4 redact list. Names are matched
// case-insensitively because slog/JSON producers normalise casing
// inconsistently across upstream libraries (`Authorization` vs `authorization`,
// `X-PAYMENT` vs `x-payment`).
//
// Adding a new sensitive name? Update this list AND extend the
// `TestRedaction_AllRule4Names` table in log_test.go.
var SensitiveKeys = []string{
	"Authorization",
	"authorization",
	"X-Payer-Token",
	"x-payer-token",
	"ADMIN_TOKEN",
	"X-Admin-Token",
	"x-admin-token",
	"X-PAYMENT",
	"x-payment",
	"signature",
	"publicKey",
	"public_key",
	"payload_hash",
	"submissionPayloadHash",
	"receiptPayloadHash",
	"participantSig",
	"dedupId",
	"dedup_id",
	"command_id",
	"commandId",
	"payment_request_contract_id",
	"paymentRequestContractId",
}

type sensitiveSet map[string]struct{}

func newSensitiveSet(keys []string) sensitiveSet {
	s := make(sensitiveSet, len(keys))
	for _, k := range keys {
		s[strings.ToLower(k)] = struct{}{}
	}
	return s
}

func (s sensitiveSet) contains(key string) bool {
	_, ok := s[strings.ToLower(key)]
	return ok
}

// Options controls logger construction.
type Options struct {
	// Level is the minimum slog level. Zero value = LevelInfo.
	Level slog.Level
	// AddSource attaches caller information when true.
	AddSource bool
	// ExtraSensitive lets a caller append project-specific redact keys.
	// (Useful for tests or for follow-up Flow 4 rules.)
	ExtraSensitive []string
}

// New constructs a slog.Logger backed by the JSON handler wrapped in the
// deep-walk redactor.
func New(w io.Writer, opts Options) *slog.Logger {
	if w == nil {
		w = io.Discard
	}
	base := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level:     opts.Level,
		AddSource: opts.AddSource,
	})
	keys := append([]string{}, SensitiveKeys...)
	keys = append(keys, opts.ExtraSensitive...)
	return slog.New(&redactHandler{
		inner:     base,
		sensitive: newSensitiveSet(keys),
	})
}

// WithOrderID returns a logger bound to an order_id correlator. Per
// CLAUDE.md §4: every log line that touches an order MUST carry order_id.
func WithOrderID(l *slog.Logger, orderID string) *slog.Logger {
	if l == nil {
		l = slog.Default()
	}
	return l.With(slog.String("order_id", orderID))
}

// redactHandler is the slog middleware that deep-walks every attribute.
type redactHandler struct {
	inner     slog.Handler
	sensitive sensitiveSet
}

func (h *redactHandler) Enabled(ctx context.Context, lvl slog.Level) bool {
	return h.inner.Enabled(ctx, lvl)
}

func (h *redactHandler) Handle(ctx context.Context, r slog.Record) error {
	scrubbed := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	r.Attrs(func(a slog.Attr) bool {
		scrubbed.AddAttrs(h.scrubAttr(a))
		return true
	})
	return h.inner.Handle(ctx, scrubbed)
}

func (h *redactHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	scrubbed := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		scrubbed = append(scrubbed, h.scrubAttr(a))
	}
	return &redactHandler{inner: h.inner.WithAttrs(scrubbed), sensitive: h.sensitive}
}

func (h *redactHandler) WithGroup(name string) slog.Handler {
	return &redactHandler{inner: h.inner.WithGroup(name), sensitive: h.sensitive}
}

// scrubAttr applies the redaction policy:
//
//  1. If the attribute's KEY is sensitive, replace the whole VALUE with the
//     placeholder regardless of value shape.
//  2. Otherwise, recurse into the value — slog Groups, generic any-values
//     carrying maps/slices/structs all get walked.
func (h *redactHandler) scrubAttr(a slog.Attr) slog.Attr {
	if h.sensitive.contains(a.Key) {
		return slog.String(a.Key, RedactedPlaceholder)
	}
	v := a.Value.Resolve()
	switch v.Kind() {
	case slog.KindGroup:
		grp := v.Group()
		out := make([]slog.Attr, 0, len(grp))
		for _, sub := range grp {
			out = append(out, h.scrubAttr(sub))
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(out...)}
	case slog.KindAny:
		return slog.Any(a.Key, h.deepScrub(v.Any()))
	default:
		return a
	}
}

// deepScrub walks an arbitrary value recursively, rewriting any map/struct
// field whose key matches the sensitive set. The output is always a
// JSON-marshalable value (map/slice/scalar) so the underlying JSON handler
// can encode it directly.
//
// The walker collapses unsupported types (chan, func, complex) to their
// string form via fmt.Sprintf so we never panic on an unexpected payload —
// safer than dropping, and matches slog's default behaviour for unknown
// attribute values.
func (h *redactHandler) deepScrub(v any) any {
	if v == nil {
		return nil
	}
	// Fast path for json.RawMessage / []byte — decode then walk.
	switch raw := v.(type) {
	case json.RawMessage:
		return h.scrubJSON(raw)
	case []byte:
		// Heuristic: only treat as JSON if it starts with '{' or '[' — random
		// byte slices get base64'd by JSON anyway, which is fine.
		trimmed := strings.TrimSpace(string(raw))
		if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
			return h.scrubJSON(raw)
		}
		return string(raw)
	}

	rv := reflect.ValueOf(v)
	for rv.Kind() == reflect.Pointer || rv.Kind() == reflect.Interface {
		if rv.IsNil() {
			return nil
		}
		rv = rv.Elem()
	}
	switch rv.Kind() {
	case reflect.Map:
		out := make(map[string]any, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			key := fmt.Sprintf("%v", iter.Key().Interface())
			if h.sensitive.contains(key) {
				out[key] = RedactedPlaceholder
				continue
			}
			out[key] = h.deepScrub(iter.Value().Interface())
		}
		return out
	case reflect.Struct:
		// Round-trip through JSON to honour json tags and to surface only
		// the exported fields a consumer would actually see in logs.
		bs, err := json.Marshal(rv.Interface())
		if err != nil {
			return fmt.Sprintf("%+v", rv.Interface())
		}
		return h.scrubJSON(bs)
	case reflect.Slice, reflect.Array:
		out := make([]any, rv.Len())
		for i := 0; i < rv.Len(); i++ {
			out[i] = h.deepScrub(rv.Index(i).Interface())
		}
		return out
	case reflect.String:
		return rv.String()
	case reflect.Bool:
		return rv.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return rv.Uint()
	case reflect.Float32, reflect.Float64:
		return rv.Float()
	default:
		return fmt.Sprintf("%v", v)
	}
}

// scrubJSON parses raw JSON bytes, walks the tree, and returns a Go-typed
// representation with sensitive keys redacted. Invalid JSON falls back to
// the original string.
func (h *redactHandler) scrubJSON(b []byte) any {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return string(b)
	}
	return h.scrubAny(v)
}

func (h *redactHandler) scrubAny(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if h.sensitive.contains(k) {
				out[k] = RedactedPlaceholder
				continue
			}
			out[k] = h.scrubAny(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = h.scrubAny(val)
		}
		return out
	default:
		return v
	}
}
