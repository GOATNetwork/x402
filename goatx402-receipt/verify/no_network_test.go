package verify_test

import (
	"bytes"
	"os/exec"
	"strings"
	"testing"
)

// TestNoNetworkImports is the build-time guard required by §6.4 and Task 5:
// the offline verifier MUST NOT depend on net*, transitively or directly. We
// shell out to `go list -deps .` from this test's working directory (the
// verify package) and walk the dependency closure. Any entry whose path is
// "net" or starts with "net/" fails the test.
//
// Skips if the `go` toolchain is unavailable so test runs inside minimal
// containers do not flake; CI invokes this from a host that always has the
// toolchain present.
func TestNoNetworkImports(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not on PATH; skipping network-import guard")
	}

	cmd := exec.Command("go", "list", "-deps", ".")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list -deps .: %v (stderr: %s)", err, stderr.String())
	}

	var offenders []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		pkg := strings.TrimSpace(line)
		if pkg == "" {
			continue
		}
		// Standard-library net package OR any net/* sub-package is forbidden.
		// We also forbid third-party packages whose import path starts with
		// "net/" — there are no real-world libraries with that prefix today,
		// but the rule keeps the guard simple and conservative.
		if pkg == "net" || strings.HasPrefix(pkg, "net/") {
			offenders = append(offenders, pkg)
		}
	}

	if len(offenders) > 0 {
		t.Fatalf("verify package transitively imports forbidden network package(s): %s",
			strings.Join(offenders, ", "))
	}
}
