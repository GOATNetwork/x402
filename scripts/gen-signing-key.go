// gen-signing-key — generate an Ed25519 key pair, write base64(raw 64-byte
// private key) + base64(32-byte public key) to two files.
//
// Output format matches what goatx402-facilitator's LoadParticipantSigningKey
// expects (base64 of the 64-byte ed25519 private key: 32-byte seed + 32-byte
// pubkey concatenated). Pub side matches merchant's loadPubKey (base64 of
// raw 32-byte pubkey).
//
// Usage:
//   go run scripts/gen-signing-key.go state/participant-signing.b64 state/participant-pubkey.b64
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: gen-signing-key <priv-path> <pub-path>")
		os.Exit(2)
	}
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ed25519 keygen:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(os.Args[1], []byte(base64.StdEncoding.EncodeToString(priv)+"\n"), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "write priv:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(os.Args[2], []byte(base64.StdEncoding.EncodeToString(pub)+"\n"), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "write pub:", err)
		os.Exit(1)
	}
}
