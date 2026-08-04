package policy

import (
	"errors"
	"testing"
)

func newDefault(t *testing.T) *Policy {
	t.Helper()
	p, err := New(DefaultDenyGlobs)
	if err != nil {
		t.Fatalf("compiling default policy: %v", err)
	}
	return p
}

func TestAllowsOrdinaryConfigFiles(t *testing.T) {
	p := newDefault(t)
	for _, path := range []string{
		"/etc/hosts",
		"/etc/resolv.conf",
		"/etc/sysctl.conf",
		"/etc/cron.d/rogue",
		"/usr/bin/ls",
		"/etc/kubernetes/manifests/etcd-pod.yaml",
	} {
		if got, err := p.Check(path); err != nil {
			t.Errorf("Check(%q) = error %v, want allowed", path, err)
		} else if got != path {
			t.Errorf("Check(%q) = %q, want the path unchanged", path, got)
		}
	}
}

func TestDeniesSecretMaterial(t *testing.T) {
	p := newDefault(t)
	for _, path := range []string{
		"/etc/kubernetes/static-pod-resources/etcd-certs/secrets/etcd-all-certs/etcd-serving.crt",
		"/etc/kubernetes/kubelet.conf",
		"/etc/kubernetes/kubeconfig",
		"/root/.ssh/authorized_keys",
		"/home/core/.ssh/id_rsa",
		"/etc/ssh/ssh_host_rsa_key",
		"/etc/shadow",
		"/var/lib/kubelet/pods/abc/volumes/secret/token",
		"/some/where/tls.key",
		"/some/where/ca.pem",
	} {
		if _, err := p.Check(path); err == nil {
			t.Errorf("Check(%q) = allowed, want denied", path)
		}
	}
}

func TestDeniesTraversal(t *testing.T) {
	p := newDefault(t)
	// Cleaning "/etc/kubernetes/../etc/shadow" yields "/etc/shadow", which the
	// deny list catches; but a caller sending ".." is probing, so reject it
	// outright rather than quietly rewriting the request.
	for _, path := range []string{
		"/etc/kubernetes/../etc/shadow",
		"/etc/../etc/hosts",
		"/..",
		"/a/b/../../etc/hosts",
	} {
		if _, err := p.Check(path); err == nil {
			t.Errorf("Check(%q) = allowed, want denied", path)
		}
	}
}

func TestRejectsMalformedPaths(t *testing.T) {
	p := newDefault(t)
	for _, path := range []string{"", "etc/hosts", "relative", "\x00/etc/hosts"} {
		if _, err := p.Check(path); err == nil {
			t.Errorf("Check(%q) = allowed, want rejected", path)
		}
	}
	if _, err := p.Check("/etc/\x00shadow"); err == nil {
		t.Error("Check with embedded NUL = allowed, want rejected")
	}
}

func TestNormalisesRedundantSeparators(t *testing.T) {
	p := newDefault(t)
	got, err := p.Check("/etc//./hosts")
	if err != nil {
		t.Fatalf("Check = error %v, want allowed", err)
	}
	if got != "/etc/hosts" {
		t.Errorf("Check = %q, want %q", got, "/etc/hosts")
	}
}

func TestDeniedErrorNamesTheRule(t *testing.T) {
	p := newDefault(t)
	_, err := p.Check("/etc/shadow")
	var denied *ErrDenied
	if !errors.As(err, &denied) {
		t.Fatalf("Check returned %T, want *ErrDenied", err)
	}
	if denied.Reason == "" {
		t.Error("ErrDenied.Reason is empty; the caller cannot tell why")
	}
}

func TestDoubleStarDoesNotLeakIntoSingleStar(t *testing.T) {
	// "*" must not cross a separator, or "/etc/*" would deny everything below
	// /etc rather than just its direct children.
	p, err := New([]string{"/etc/*"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := p.Check("/etc/hosts"); err == nil {
		t.Error("Check(/etc/hosts) = allowed, want denied by /etc/*")
	}
	if _, err := p.Check("/etc/sub/hosts"); err != nil {
		t.Errorf("Check(/etc/sub/hosts) = denied, want allowed: %v", err)
	}
}

func TestEmptyPolicyAllowsEverything(t *testing.T) {
	// An operator who deliberately clears the deny list gets what they asked
	// for; the user's RBAC is still enforced by the API server.
	p, err := New(nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := p.Check("/etc/shadow"); err != nil {
		t.Errorf("Check = %v, want allowed under an empty policy", err)
	}
}

func TestDeniesAGlobOutsideASCII(t *testing.T) {
	// The bytes that matter are the ones in the *pattern*. A glob is quoted a
	// byte at a time, and under string(g[i]) — a conversion from an integer —
	// each byte above 0x7F became the UTF-8 encoding of the code point with
	// that value, so the pattern could no longer match the name it was written
	// from. It denied nothing, and nothing said so: New returns no error, the
	// rule appears in Patterns(), and `go vet` exempts the conversion because
	// its operand is a byte. Only a path that should have been refused and was
	// not could show it, and that is this test.
	p, err := New([]string{"/etc/pässe/**"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := p.Check("/etc/pässe/key.pem"); err == nil {
		t.Error("Check = allowed, want denied by /etc/pässe/**")
	}
	if _, err := p.Check("/etc/passe/key.pem"); err != nil {
		t.Errorf("Check = denied, want allowed: a different directory: %v", err)
	}

	// A non-ASCII byte on the *path* side was never the problem — a star
	// matches bytes and does not care what they spell. Pinned so that the fix
	// is not later mistaken for something the path needed too.
	p, err = New([]string{"/etc/segreti/*"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := p.Check("/etc/segreti/päßwörter"); err == nil {
		t.Error("Check = allowed, want denied by /etc/segreti/*")
	}
}

func TestCommentsAndBlanksAreIgnored(t *testing.T) {
	p, err := New([]string{"# a comment", "", "  ", "/etc/shadow"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if len(p.Patterns()) != 1 {
		t.Errorf("Patterns() = %v, want just the one real pattern", p.Patterns())
	}
}
