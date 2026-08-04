// Package policy decides which node paths this service is willing to read.
//
// The AIDE daemon pod we exec into runs privileged with the node's root
// filesystem bind-mounted at /hostroot. That makes an unrestricted read
// endpoint equivalent to cluster takeover on a control-plane node: etcd
// certificates, the kubelet kubeconfig and every service account signing key
// live under /etc/kubernetes. The user's own RBAC is the primary control, but
// this deny list exists so that "can exec into the file-integrity namespace"
// does not silently become "can read every secret on the host".
package policy

import (
	"fmt"
	"path"
	"regexp"
	"strings"
)

// DefaultDenyGlobs is applied unless the operator overrides it.
//
// Patterns are matched against the node-absolute path (no /hostroot prefix).
// "**" matches across separators, "*" and "?" do not.
var DefaultDenyGlobs = []string{
	"/etc/kubernetes/static-pod-resources/**",
	"/etc/kubernetes/kubelet.conf",
	"/etc/kubernetes/kubeconfig",
	"/etc/kubernetes/**/kubeconfig*",
	"/etc/kubernetes/**/*.key",
	"/etc/machine-config-daemon/**",
	"/root/.ssh/**",
	"/home/**/.ssh/**",
	"/etc/ssh/*_key",
	"/var/lib/kubelet/pods/**",
	"/var/lib/etcd/**",
	"**/*.key",
	"**/*.pem",
	"**/id_rsa",
	"**/id_ecdsa",
	"**/id_ed25519",
	"**/.git-credentials",
	"**/shadow",
	"**/gshadow",
}

// Policy answers whether a path may be read.
type Policy struct {
	deny    []*regexp.Regexp
	sources []string
}

// New compiles a policy from glob patterns.
func New(globs []string) (*Policy, error) {
	p := &Policy{}
	for _, g := range globs {
		g = strings.TrimSpace(g)
		if g == "" || strings.HasPrefix(g, "#") {
			continue
		}
		re, err := compileGlob(g)
		if err != nil {
			return nil, fmt.Errorf("invalid deny pattern %q: %w", g, err)
		}
		p.deny = append(p.deny, re)
		p.sources = append(p.sources, g)
	}
	return p, nil
}

// compileGlob translates a shell-ish glob into an anchored regexp.
//
// Ordering matters: "**" has to be consumed before the single "*" case, or the
// first star would match a path separator and the second would be left over.
//
// The default case quotes a one-byte *slice*, never string(g[i]). That
// conversion is from an integer, so it yields the UTF-8 encoding of the code
// point with that value: a byte of 0xC3 becomes the two bytes U+00C3 is written
// with, and the pattern can then never match the path it came from. Every glob
// containing a character outside ASCII would compile without complaint and
// match nothing — a deny rule that denies nothing, in silence. `go vet` does not
// catch it either: stringintconv exempts conversions from byte and rune, which
// is exactly what this one is.
func compileGlob(g string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(g); i++ {
		switch {
		case strings.HasPrefix(g[i:], "**"):
			b.WriteString(".*")
			i++ // consume the second star
		case g[i] == '*':
			b.WriteString("[^/]*")
		case g[i] == '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(g[i : i+1]))
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

// ErrDenied is returned for a path the policy rejects. The message is safe to
// show to the caller: it names the rule, never the file's contents.
type ErrDenied struct {
	Path   string
	Reason string
}

func (e *ErrDenied) Error() string {
	return fmt.Sprintf("reading %q is not allowed: %s", e.Path, e.Reason)
}

// Check validates and normalises a requested node path.
//
// It returns the cleaned path to use. Callers must use the returned value, not
// the caller-supplied one: cleaning is what removes "..", and matching the deny
// list against an uncleaned path would let "/etc/kubernetes/../etc/shadow"
// through.
func (p *Policy) Check(requested string) (string, error) {
	if requested == "" {
		return "", &ErrDenied{Path: requested, Reason: "path is empty"}
	}
	if !strings.HasPrefix(requested, "/") {
		return "", &ErrDenied{Path: requested, Reason: "path must be absolute"}
	}
	if strings.ContainsRune(requested, 0) {
		return "", &ErrDenied{Path: requested, Reason: "path contains a NUL byte"}
	}
	// Reject rather than silently rewrite: a caller sending ".." is either
	// confused or probing, and neither deserves a best-effort answer.
	for _, seg := range strings.Split(requested, "/") {
		if seg == ".." {
			return "", &ErrDenied{Path: requested, Reason: `path must not contain ".."`}
		}
	}

	clean := path.Clean(requested)
	if !strings.HasPrefix(clean, "/") {
		return "", &ErrDenied{Path: requested, Reason: "path must be absolute"}
	}

	for i, re := range p.deny {
		if re.MatchString(clean) {
			return "", &ErrDenied{
				Path:   clean,
				Reason: fmt.Sprintf("it matches the denied pattern %q", p.sources[i]),
			}
		}
	}
	return clean, nil
}

// Patterns returns the configured deny globs, for logging at startup.
func (p *Policy) Patterns() []string {
	return append([]string(nil), p.sources...)
}
