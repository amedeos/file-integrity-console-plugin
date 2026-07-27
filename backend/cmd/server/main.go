// Command server serves the File Integrity console plugin.
//
// It does two unrelated jobs from one process so the chart ships one Deployment
// and one Service:
//   - static hosting of the compiled plugin assets, which the console fetches
//     from the ConsolePlugin `backend` service;
//   - a small API for reading a file from a node, which the console reaches
//     through the ConsolePlugin `proxy` entry declared with
//     `authorization: UserToken`.
//
// Everything the API does is done with the *caller's* credentials. See
// internal/authz for why that matters.
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	k8serrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/openshift/file-integrity-console-plugin/backend/internal/authz"
	"github.com/openshift/file-integrity-console-plugin/backend/internal/nodefile"
	"github.com/openshift/file-integrity-console-plugin/backend/internal/policy"
)

type config struct {
	listen         string
	certFile       string
	keyFile        string
	staticDir      string
	namespace      string
	maxBytes       int64
	denyFile       string
	extraDenyFile  string
	enableRetrieve bool
}

type server struct {
	cfg     config
	factory *authz.ClientFactory
	policy  *policy.Policy
	reader  *nodefile.Reader
	log     *slog.Logger
}

// Every setting can be given as a flag or as an environment variable, and the
// variable is only the flag's default, so a flag on the command line still wins.
//
// The environment is not a convenience here, it is the only channel an OLM
// install has. A Subscription can override a container's env
// (`spec.config.env`, merged by name — newer wins) and can mount volumes, but
// it cannot touch the container's args: those come from the CSV, and editing
// the CSV is editing something OLM owns and reconciles. So a plugin installed
// from OperatorHub could not be configured at all while these were flags only —
// most visibly, file retrieve could never be turned on, and the interface told
// the administrator to go and change Helm values that do not exist on that
// path.
//
// The chart therefore passes the tunable settings as env and the structural
// ones as flags. Flags keep working unchanged, which is what the two-container
// test recipe in AGENTS.md relies on.
//
// The mapping is mechanical — upper-case the flag, hyphens to underscores,
// prefix — so a name can always be derived rather than looked up. The prefix is
// PLUGIN_ rather than FIO_ only because `--fio-namespace` would otherwise
// become FIO_FIO_NAMESPACE, which reads like a typo and would be copied as one.
const envPrefix = "PLUGIN_"

func envName(flagName string) string {
	return envPrefix + strings.ToUpper(strings.ReplaceAll(flagName, "-", "_"))
}

func envString(flagName, fallback string) string {
	if v, ok := os.LookupEnv(envName(flagName)); ok {
		return v
	}
	return fallback
}

// A malformed value is fatal rather than ignored. Silently falling back to the
// default would mean an administrator who wrote `PLUGIN_ENABLE_FILE_RETRIEVE=yes`
// gets a running pod that does not do what they asked, and nothing anywhere
// says so.
func envBool(flagName string, fallback bool) bool {
	v, ok := os.LookupEnv(envName(flagName))
	if !ok {
		return fallback
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s=%q is not a boolean\n", envName(flagName), v)
		os.Exit(2)
	}
	return parsed
}

func envInt64(flagName string, fallback int64) int64 {
	v, ok := os.LookupEnv(envName(flagName))
	if !ok {
		return fallback
	}
	parsed, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s=%q is not an integer\n", envName(flagName), v)
		os.Exit(2)
	}
	return parsed
}

func main() {
	var cfg config
	flag.StringVar(&cfg.listen, "listen", envString("listen", ":9443"), "address to listen on")
	flag.StringVar(&cfg.certFile, "tls-cert-file", envString("tls-cert-file", "/var/cert/tls.crt"), "TLS certificate; serve plain HTTP if empty")
	flag.StringVar(&cfg.keyFile, "tls-key-file", envString("tls-key-file", "/var/cert/tls.key"), "TLS private key")
	flag.StringVar(&cfg.staticDir, "static-dir", envString("static-dir", "/opt/app-root/web"), "directory holding the built plugin assets")
	flag.StringVar(&cfg.namespace, "fio-namespace", envString("fio-namespace", "openshift-file-integrity"), "namespace the File Integrity Operator runs in")
	flag.Int64Var(&cfg.maxBytes, "max-file-bytes", envInt64("max-file-bytes", 1<<20), "maximum number of bytes to read from a node file")
	flag.StringVar(&cfg.denyFile, "deny-list-file", envString("deny-list-file", ""), "file with one deny glob per line, replacing the built-in defaults")
	flag.StringVar(&cfg.extraDenyFile, "extra-deny-list-file", envString("extra-deny-list-file", ""), "file with one deny glob per line, added to whichever list is in effect")
	// False here while the chart's value is true, and the difference is
	// deliberate. This default only applies when nothing sets it — which in
	// practice means the binary running outside a cluster, as in the
	// two-container console test in AGENTS.md. Enabling the feature makes the
	// process build a Kubernetes client at startup, and rest.InClusterConfig()
	// has nothing to read there, so the container would exit instead of serving
	// the assets it was started for. An installation always says what it wants;
	// a bare run cannot, and the answer that still works is off.
	flag.BoolVar(&cfg.enableRetrieve, "enable-file-retrieve", envBool("enable-file-retrieve", false), "enable reading files from nodes")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	globs := policy.DefaultDenyGlobs
	if cfg.denyFile != "" {
		loaded, err := loadDenyFile(cfg.denyFile)
		if err != nil {
			log.Error("reading deny list", "error", err)
			os.Exit(1)
		}
		globs = loaded
	}
	// Kept separate from the replacing list so an installation can harden the
	// defaults without copying them, which is how a copy goes stale and starts
	// allowing what a newer default would have denied.
	if cfg.extraDenyFile != "" {
		extra, err := loadDenyFile(cfg.extraDenyFile)
		if err != nil {
			log.Error("reading extra deny list", "error", err)
			os.Exit(1)
		}
		globs = append(append([]string(nil), globs...), extra...)
	}
	pol, err := policy.New(globs)
	if err != nil {
		log.Error("compiling deny list", "error", err)
		os.Exit(1)
	}

	srv := &server{
		cfg:    cfg,
		policy: pol,
		log:    log,
		reader: &nodefile.Reader{Namespace: cfg.namespace, MaxBytes: cfg.maxBytes},
	}

	// Only reach for cluster credentials when the feature that needs them is
	// on, so the plugin still serves its assets outside a cluster.
	if cfg.enableRetrieve {
		factory, err := authz.NewClientFactory()
		if err != nil {
			log.Error("building Kubernetes client factory", "error", err)
			os.Exit(1)
		}
		srv.factory = factory
	}

	log.Info("starting",
		"listen", cfg.listen,
		"staticDir", cfg.staticDir,
		"namespace", cfg.namespace,
		"fileRetrieveEnabled", cfg.enableRetrieve,
		"maxFileBytes", cfg.maxBytes,
		"denyPatterns", len(pol.Patterns()),
	)

	httpServer := &http.Server{
		Addr:              cfg.listen,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}

	if cfg.certFile != "" && cfg.keyFile != "" {
		err = httpServer.ListenAndServeTLS(cfg.certFile, cfg.keyFile)
	} else {
		log.Warn("serving plain HTTP; the console requires HTTPS for plugin backends")
		err = httpServer.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func loadDenyFile(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return strings.Split(string(raw), "\n"), nil
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /api/v1/nodes/{node}/file", s.handleNodeFile)

	assets := http.FileServer(http.Dir(s.cfg.staticDir))
	mux.Handle("/", cacheHeaders(assets))
	return mux
}

// cacheHeaders keeps plugin-manifest.json fresh while letting the hashed asset
// files be cached: the console re-reads the manifest to discover a new build,
// so a stale one pins users to the previous version.
func cacheHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "plugin-manifest.json") {
			w.Header().Set("Cache-Control", "no-cache")
		} else if strings.HasSuffix(r.URL.Path, ".js") || strings.HasSuffix(r.URL.Path, ".css") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		next.ServeHTTP(w, r)
	})
}

type errorResponse struct {
	Error string `json:"error"`
}

type fileResponse struct {
	Node          string `json:"node"`
	Path          string `json:"path"`
	Size          int    `json:"size"`
	Truncated     bool   `json:"truncated"`
	SHA256        string `json:"sha256"`
	Binary        bool   `json:"binary"`
	ContentBase64 string `json:"contentBase64"`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, format string, args ...any) {
	writeJSON(w, status, errorResponse{Error: fmt.Sprintf(format, args...)})
}

func (s *server) handleNodeFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	if !s.cfg.enableRetrieve {
		writeError(w, http.StatusNotImplemented,
			"reading files from nodes is disabled in this installation")
		return
	}

	node := r.PathValue("node")
	requestedPath := r.URL.Query().Get("path")
	fileIntegrity := r.URL.Query().Get("fileIntegrity")
	if node == "" || requestedPath == "" {
		writeError(w, http.StatusBadRequest, "both a node and a path are required")
		return
	}

	token, err := authz.BearerToken(r)
	if err != nil {
		// Never fall back to this pod's own service account: doing so would
		// hand every caller the privileges of the backend.
		s.log.Warn("rejected unauthenticated request", "node", node, "path", requestedPath)
		writeError(w, http.StatusUnauthorized,
			"no bearer token was forwarded; the console proxy must use authorization: UserToken")
		return
	}

	// Validate before authenticating so a denied path is never even attributed
	// to a user session, and so probing costs nothing.
	cleanPath, err := s.policy.Check(requestedPath)
	if err != nil {
		var denied *policy.ErrDenied
		if errors.As(err, &denied) {
			s.log.Warn("denied by policy",
				"node", node, "path", requestedPath, "reason", denied.Reason)
			writeError(w, http.StatusForbidden, "%s", denied.Error())
			return
		}
		writeError(w, http.StatusBadRequest, "%s", err.Error())
		return
	}

	user, err := s.factory.ForToken(token)
	if err != nil {
		s.log.Error("building user client", "error", err)
		writeError(w, http.StatusInternalServerError, "could not build a client for your session")
		return
	}

	username, err := user.WhoAmI(ctx)
	if err != nil {
		if k8serrors.IsUnauthorized(err) {
			writeError(w, http.StatusUnauthorized, "your session is not valid")
			return
		}
		s.log.Error("resolving caller identity", "error", err)
		writeError(w, http.StatusInternalServerError, "could not resolve your identity")
		return
	}

	allowed, reason, err := user.CanExec(ctx, s.cfg.namespace)
	if err != nil {
		s.log.Error("access review failed", "user", username, "error", err)
		writeError(w, http.StatusInternalServerError, "could not check your permissions")
		return
	}
	if !allowed {
		s.audit(username, node, cleanPath, "denied-rbac", reason)
		writeError(w, http.StatusForbidden,
			"you are not allowed to exec into pods in %s, which is required to read files from a node",
			s.cfg.namespace)
		return
	}

	pod, err := s.reader.FindPod(ctx, user, node, fileIntegrity)
	if err != nil {
		var noPod *nodefile.ErrNoPod
		if errors.As(err, &noPod) {
			s.audit(username, node, cleanPath, "no-pod", "")
			writeError(w, http.StatusNotFound, "%s", noPod.Error())
			return
		}
		if k8serrors.IsForbidden(err) {
			s.audit(username, node, cleanPath, "denied-rbac", err.Error())
			writeError(w, http.StatusForbidden, "%s", err.Error())
			return
		}
		s.log.Error("finding scan pod", "user", username, "node", node, "error", err)
		writeError(w, http.StatusInternalServerError, "could not find the scan pod for this node")
		return
	}

	result, err := s.reader.Read(ctx, user, pod, cleanPath)
	if err != nil {
		var readErr *nodefile.ErrRead
		if errors.As(err, &readErr) {
			s.audit(username, node, cleanPath, "read-failed", readErr.Error())
			writeError(w, http.StatusNotFound, "%s", readErr.Error())
			return
		}
		if k8serrors.IsForbidden(err) {
			s.audit(username, node, cleanPath, "denied-rbac", err.Error())
			writeError(w, http.StatusForbidden, "%s", err.Error())
			return
		}
		s.log.Error("reading node file", "user", username, "node", node, "error", err)
		writeError(w, http.StatusInternalServerError, "could not read the file from the node")
		return
	}

	s.audit(username, node, cleanPath, "allowed", fmt.Sprintf("%d bytes", len(result.Content)))
	writeJSON(w, http.StatusOK, fileResponse{
		Node:          node,
		Path:          cleanPath,
		Size:          len(result.Content),
		Truncated:     result.Truncated,
		SHA256:        result.SHA256,
		Binary:        result.Binary,
		ContentBase64: base64.StdEncoding.EncodeToString(result.Content),
	})
}

// audit records every attempt to read a node file, allowed or not.
//
// This is the record of who looked at what on which node. It is deliberately
// emitted for denials too, since a run of denials is the interesting signal —
// and denials are the part the API server cannot log for us, because a request
// stopped by the deny list or by a missing token never reaches it.
//
// A log line, not a Kubernetes Event. Emitting an Event as the caller fails for
// precisely the users whose attempts matter most: someone denied pods/exec is
// usually also denied create events, and an unauthenticated request has no user
// to act as. Emitting it as this pod's own ServiceAccount would give that
// account the only permission it otherwise needs, and would let unauthenticated
// callers drive writes, since the deny-list check runs before authentication.
// The authoritative trail is the API server's audit log, which records the
// pods/exec with the caller, the pod and the full command including the path.
func (s *server) audit(user, node, path, outcome, detail string) {
	s.log.Info("node file access",
		"audit", true,
		"user", user,
		"node", node,
		"path", path,
		"outcome", outcome,
		"detail", detail,
	)
}
