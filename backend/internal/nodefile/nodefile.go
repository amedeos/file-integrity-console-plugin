// Package nodefile reads a single file from a cluster node.
//
// It does so by exec'ing into the File Integrity Operator's AIDE DaemonSet pod
// that already runs on that node. That pod is privileged and bind-mounts the
// node's root filesystem at /hostroot, which is exactly the view AIDE reported
// on — so the bytes we return are the bytes AIDE compared. Reusing it also
// means we never create a privileged workload of our own.
package nodefile

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"

	"github.com/openshift/file-integrity-console-plugin/backend/internal/authz"
)

const (
	// Labels the operator puts on its AIDE pods (pkg/common/constants.go).
	podLabelKey   = "file-integrity.openshift.io/pod"
	ownerLabelKey = "file-integrity.openshift.io/owner"

	// Container inside the AIDE DaemonSet pod, and the node root it mounts.
	daemonContainer = "daemon"
	hostRoot        = "/hostroot"
)

// ErrNoPod means no usable AIDE pod runs on the requested node.
type ErrNoPod struct {
	Node string
}

func (e *ErrNoPod) Error() string {
	return fmt.Sprintf("no running File Integrity scan pod found on node %q", e.Node)
}

// ErrRead reports a failure of the read command itself, carrying whatever the
// container wrote to stderr so the caller learns *why* (missing file, EACCES).
type ErrRead struct {
	Path   string
	Stderr string
	Err    error
}

func (e *ErrRead) Error() string {
	if e.Stderr != "" {
		return fmt.Sprintf("reading %q on the node failed: %s", e.Path, strings.TrimSpace(e.Stderr))
	}
	return fmt.Sprintf("reading %q on the node failed: %v", e.Path, e.Err)
}

func (e *ErrRead) Unwrap() error { return e.Err }

// Result is the outcome of a successful read.
type Result struct {
	Content   []byte
	Truncated bool
	SHA256    string
	Binary    bool
}

// Reader reads node files as a given user.
type Reader struct {
	Namespace string
	MaxBytes  int64
}

// FindPod locates the AIDE pod for a node.
//
// fileIntegrity narrows the search when several FileIntegrity resources cover
// overlapping node sets; empty means "any".
func (r *Reader) FindPod(
	ctx context.Context,
	user *authz.UserClient,
	node string,
	fileIntegrity string,
) (*corev1.Pod, error) {
	selector := podLabelKey
	if fileIntegrity != "" {
		selector = fmt.Sprintf("%s,%s=%s", podLabelKey, ownerLabelKey, fileIntegrity)
	}

	pods, err := user.Clientset.CoreV1().Pods(r.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: selector,
		FieldSelector: fields.OneTermEqualSelector("spec.nodeName", node).String(),
	})
	if err != nil {
		return nil, fmt.Errorf("listing scan pods: %w", err)
	}

	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.Status.Phase != corev1.PodRunning || pod.DeletionTimestamp != nil {
			continue
		}
		// A pod whose daemon container is still starting cannot be exec'd into.
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.Name == daemonContainer && cs.Ready {
				return pod, nil
			}
		}
	}
	return nil, &ErrNoPod{Node: node}
}

// Read returns up to MaxBytes of the file at nodePath.
//
// nodePath must already have been validated by the policy package; it is
// joined to /hostroot here and passed as a distinct argv element, never
// interpolated into a shell command, so a path containing shell metacharacters
// cannot become a command.
func (r *Reader) Read(
	ctx context.Context,
	user *authz.UserClient,
	pod *corev1.Pod,
	nodePath string,
) (*Result, error) {
	// Ask for one byte more than the limit so a file exactly at the limit is
	// not misreported as truncated.
	limit := r.MaxBytes + 1
	command := []string{
		"/usr/bin/head",
		"-c", strconv.FormatInt(limit, 10),
		"--", hostRoot + nodePath,
	}

	req := user.Clientset.CoreV1().RESTClient().
		Post().
		Resource("pods").
		Namespace(pod.Namespace).
		Name(pod.Name).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: daemonContainer,
			Command:   command,
			Stdin:     false,
			Stdout:    true,
			Stderr:    true,
			TTY:       false,
		}, scheme.ParameterCodec)

	exec, err := newExecutor(user, req.URL())
	if err != nil {
		return nil, fmt.Errorf("preparing exec: %w", err)
	}

	var stdout, stderr bytes.Buffer
	if err := exec.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdout: &stdout,
		Stderr: &stderr,
	}); err != nil {
		return nil, &ErrRead{Path: nodePath, Stderr: stderr.String(), Err: err}
	}
	// `head` exits 0 but writes to stderr when the file is unreadable, which
	// would otherwise look like a successful read of an empty file.
	if stdout.Len() == 0 && stderr.Len() > 0 {
		return nil, &ErrRead{Path: nodePath, Stderr: stderr.String()}
	}

	content := stdout.Bytes()
	truncated := int64(len(content)) > r.MaxBytes
	if truncated {
		content = content[:r.MaxBytes]
	}

	sum := sha256.Sum256(content)
	return &Result{
		Content:   content,
		Truncated: truncated,
		SHA256:    hex.EncodeToString(sum[:]),
		Binary:    bytes.IndexByte(content, 0) >= 0,
	}, nil
}

// newExecutor prefers the WebSocket transport and falls back to SPDY, which is
// what remotecommand's fallback executor does; both are needed because older
// API servers do not speak the WebSocket protocol.
func newExecutor(user *authz.UserClient, u *url.URL) (remotecommand.Executor, error) {
	spdy, err := remotecommand.NewSPDYExecutor(user.Config, "POST", u)
	if err != nil {
		return nil, err
	}
	ws, err := remotecommand.NewWebSocketExecutor(user.Config, "GET", u.String())
	if err != nil {
		return spdy, nil
	}
	return remotecommand.NewFallbackExecutor(ws, spdy, func(error) bool { return true })
}
