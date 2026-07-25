// Package authz builds Kubernetes clients that act as the calling user.
//
// The console forwards the logged-in user's OAuth token to us because the
// ConsolePlugin declares `authorization: UserToken` on its proxy. We use that
// token for every API call we make on the user's behalf, so the API server
// applies their RBAC directly. This service intentionally holds no privileges
// of its own for reading node files: there is no service-account fallback, and
// a request without a token is rejected rather than served with our identity.
package authz

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	authnv1 "k8s.io/api/authentication/v1"
	authzv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// ErrNoToken means the request carried no bearer token.
var ErrNoToken = errors.New("no bearer token in the Authorization header")

// UserClient is a Kubernetes client bound to one user's credentials.
type UserClient struct {
	Clientset *kubernetes.Clientset
	Config    *rest.Config
}

// BearerToken extracts the token from an Authorization header.
func BearerToken(r *http.Request) (string, error) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return "", ErrNoToken
	}
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", ErrNoToken
	}
	token := strings.TrimSpace(header[len(prefix):])
	if token == "" {
		return "", ErrNoToken
	}
	return token, nil
}

// ClientFactory builds per-user clients from the in-cluster configuration.
type ClientFactory struct {
	base *rest.Config
}

// NewClientFactory reads the in-cluster config for its API server address and
// CA bundle only; the service account token it contains is never used to talk
// to the API server on a user's behalf.
func NewClientFactory() (*ClientFactory, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("reading in-cluster config: %w", err)
	}
	return &ClientFactory{base: cfg}, nil
}

// ForToken returns a client that authenticates as the owner of token.
func (f *ClientFactory) ForToken(token string) (*UserClient, error) {
	cfg := rest.AnonymousClientConfig(f.base)
	cfg.BearerToken = token
	// AnonymousClientConfig already drops these, but they are the whole point
	// of this function: if either survived, we would silently fall back to the
	// pod's own identity and hand the caller privileges they do not have.
	cfg.BearerTokenFile = ""
	cfg.Impersonate = rest.ImpersonationConfig{}

	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("building user client: %w", err)
	}
	return &UserClient{Clientset: clientset, Config: cfg}, nil
}

// WhoAmI resolves the caller's username.
//
// Uses SelfSubjectReview rather than TokenReview: it runs as the user, so this
// service needs no privileges at all, whereas TokenReview would require
// granting it `create tokenreviews` cluster-wide.
func (c *UserClient) WhoAmI(ctx context.Context) (string, error) {
	review, err := c.Clientset.AuthenticationV1().SelfSubjectReviews().Create(
		ctx, &authnv1.SelfSubjectReview{}, metav1.CreateOptions{},
	)
	if err != nil {
		return "", err
	}
	return review.Status.UserInfo.Username, nil
}

// CanExec reports whether the caller may create pod exec sessions in namespace.
//
// This is advisory: the API server enforces the same rule when we actually open
// the exec stream. Checking first only lets us answer with a clear 403 instead
// of a stream error.
func (c *UserClient) CanExec(ctx context.Context, namespace string) (bool, string, error) {
	review := &authzv1.SelfSubjectAccessReview{
		Spec: authzv1.SelfSubjectAccessReviewSpec{
			ResourceAttributes: &authzv1.ResourceAttributes{
				Namespace:   namespace,
				Verb:        "create",
				Resource:    "pods",
				Subresource: "exec",
			},
		},
	}
	result, err := c.Clientset.AuthorizationV1().SelfSubjectAccessReviews().Create(
		ctx, review, metav1.CreateOptions{},
	)
	if err != nil {
		return false, "", err
	}
	return result.Status.Allowed, result.Status.Reason, nil
}
