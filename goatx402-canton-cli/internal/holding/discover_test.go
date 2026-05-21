package holding

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDiscover_FlagWins(t *testing.T) {
	// flag wins even when env and fixture are present.
	in := ResolveInput{
		Flag:    "00deadbeef:flagcid",
		Env:     "00deadbeef:envcid",
		Payer:   "Alice",
		HomeDir: "/nowhere",
		ReadFile: func(string) ([]byte, error) {
			return []byte(`{"Alice":"00deadbeef:fixturecid"}`), nil
		},
	}
	got, err := Discover(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ContractID != "00deadbeef:flagcid" {
		t.Fatalf("flag did not win: got %q", got.ContractID)
	}
	if got.Source != "flag" {
		t.Fatalf("expected source=flag, got %q", got.Source)
	}
}

func TestDiscover_EnvWinsWhenFlagEmpty(t *testing.T) {
	in := ResolveInput{
		Env:     "00deadbeef:envcid",
		Payer:   "Alice",
		HomeDir: "/nowhere",
		ReadFile: func(string) ([]byte, error) {
			return []byte(`{"Alice":"00deadbeef:fixturecid"}`), nil
		},
	}
	got, err := Discover(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ContractID != "00deadbeef:envcid" {
		t.Fatalf("env did not win over fixture: got %q", got.ContractID)
	}
	if got.Source != "env" {
		t.Fatalf("expected source=env, got %q", got.Source)
	}
}

func TestDiscover_FixtureWhenFlagAndEnvEmpty(t *testing.T) {
	in := ResolveInput{
		Payer:   "Alice",
		HomeDir: "/somehome",
		ReadFile: func(p string) ([]byte, error) {
			want := filepath.Join("/somehome", ".goat-canton", "source-holding.json")
			if p != want {
				t.Fatalf("fixture path mismatch: got %q, want %q", p, want)
			}
			return []byte(`{"Alice":"00deadbeef:fixturecid","Bob":"otherbob"}`), nil
		},
	}
	got, err := Discover(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ContractID != "00deadbeef:fixturecid" {
		t.Fatalf("expected fixture cid, got %q", got.ContractID)
	}
	if got.Source != "fixture" {
		t.Fatalf("expected source=fixture, got %q", got.Source)
	}
}

func TestDiscover_MissingAllLayersReturnsErrMissing(t *testing.T) {
	in := ResolveInput{
		Payer:   "Alice",
		HomeDir: "/somehome",
		ReadFile: func(string) ([]byte, error) {
			return nil, os.ErrNotExist
		},
	}
	_, err := Discover(in)
	if !errors.Is(err, ErrMissing) {
		t.Fatalf("expected ErrMissing, got %v", err)
	}
}

func TestDiscover_FixturePresentButNoEntryForPayer(t *testing.T) {
	in := ResolveInput{
		Payer:   "Charlie",
		HomeDir: "/somehome",
		ReadFile: func(string) ([]byte, error) {
			return []byte(`{"Alice":"alicecid"}`), nil
		},
	}
	_, err := Discover(in)
	if !errors.Is(err, ErrMissing) {
		t.Fatalf("expected ErrMissing for absent partyId, got %v", err)
	}
}

func TestDiscover_FixtureMalformedJSONReturnsErrMissing(t *testing.T) {
	in := ResolveInput{
		Payer:   "Alice",
		HomeDir: "/somehome",
		ReadFile: func(string) ([]byte, error) {
			return []byte("not-json"), nil
		},
	}
	_, err := Discover(in)
	if !errors.Is(err, ErrMissing) {
		t.Fatalf("expected ErrMissing for malformed JSON, got %v", err)
	}
}

func TestDiscover_NoPayerNoFlagNoEnv(t *testing.T) {
	_, err := Discover(ResolveInput{})
	if !errors.Is(err, ErrMissing) {
		t.Fatalf("expected ErrMissing when nothing supplied, got %v", err)
	}
}

func TestFixturePath(t *testing.T) {
	got := FixturePath("/home/dev")
	want := filepath.Join("/home/dev", ".goat-canton", "source-holding.json")
	if got != want {
		t.Fatalf("FixturePath: got %q, want %q", got, want)
	}
}
