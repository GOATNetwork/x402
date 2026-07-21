package goatflow

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

// calculateSignature computes HMAC-SHA256 signature for API authentication
//
// Algorithm:
// 1. Sort all parameters by key in ASCII order
// 2. Concatenate as key1=value1&key2=value2 format
// 3. Compute HMAC-SHA256 using the API secret
// 4. Return hexadecimal string
func calculateSignature(params map[string]string, secret string) string {
	// Remove sign field if present
	delete(params, "sign")

	// Get sorted keys
	keys := make([]string, 0, len(params))
	for k := range params {
		if params[k] != "" { // Ignore empty values
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)

	// Build signature string
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%s", k, params[k]))
	}
	signStr := strings.Join(parts, "&")

	// Compute HMAC-SHA256
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(signStr))
	return hex.EncodeToString(h.Sum(nil))
}

func generateRequestNonce() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err == nil {
		return hex.EncodeToString(buf[:])
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
