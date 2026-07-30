// Package consoleplugin registers this plugin with the OpenShift console by
// creating the cluster-scoped ConsolePlugin object that names the plugin's
// Service.
//
// It exists because a bundle cannot ship that object. `operator-sdk bundle
// validate` rejects ConsolePlugin as a bundle manifest — "unsupported media
// type registry+v1 for bundle object" — in every release up to 1.39.2, and the
// community pipeline runs one of those. OLM itself accepts the kind and
// installs it happily, which is why nothing on a cluster ever showed this.
//
// Creating it at startup buys something the manifest could not, and that is
// the better reason to do it: OLM templates nothing inside a cluster-scoped
// manifest, so a shipped ConsolePlugin has to name its Service's namespace
// literally, and an installation into any other namespace produces a plugin
// the console cannot reach. Read from the downward API, the namespace is
// whatever the pod is actually running in.
package consoleplugin

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/yaml"
)

// Resource is the ConsolePlugin GVR. Named here rather than inline so the two
// callers and the tests cannot disagree about it.
var Resource = schema.GroupVersionResource{
	Group:    "console.openshift.io",
	Version:  "v1",
	Resource: "consoleplugins",
}

const (
	apiVersion = "console.openshift.io/v1"
	kind       = "ConsolePlugin"
)

// Load reads a ConsolePlugin from YAML and points every Service reference in
// it at namespace.
//
// The document comes from a ConfigMap the chart renders, mounted into the
// container rather than fetched, so this needs no permission to read it and
// the object's shape stays in the chart beside the comments explaining it.
// Only the namespace is decided here, because only the namespace is unknown
// until the pod is running.
func Load(data []byte, namespace string) (*unstructured.Unstructured, error) {
	if namespace == "" {
		return nil, fmt.Errorf("no namespace given")
	}

	var obj unstructured.Unstructured
	if err := yaml.Unmarshal(data, &obj.Object); err != nil {
		return nil, fmt.Errorf("parsing ConsolePlugin: %w", err)
	}
	if obj.GetAPIVersion() != apiVersion || obj.GetKind() != kind {
		return nil, fmt.Errorf(
			"expected %s %s, got %s %s",
			apiVersion, kind, obj.GetAPIVersion(), obj.GetKind(),
		)
	}
	if obj.GetName() == "" {
		return nil, fmt.Errorf("the ConsolePlugin has no name")
	}

	// The backend the console fetches assets from.
	if err := unstructured.SetNestedField(
		obj.Object, namespace, "spec", "backend", "service", "namespace",
	); err != nil {
		return nil, fmt.Errorf("setting the backend namespace: %w", err)
	}

	// And every proxy alias, which is how the browser reaches that same
	// Service with the browsing user's token. Missing them would leave the
	// object half-corrected: assets from the right place, API calls from
	// wherever the chart happened to be rendered.
	proxies, found, err := unstructured.NestedSlice(obj.Object, "spec", "proxy")
	if err != nil {
		return nil, fmt.Errorf("reading spec.proxy: %w", err)
	}
	if found {
		for i, p := range proxies {
			entry, ok := p.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("spec.proxy[%d] is not an object", i)
			}
			if err := unstructured.SetNestedField(
				entry, namespace, "endpoint", "service", "namespace",
			); err != nil {
				return nil, fmt.Errorf("setting spec.proxy[%d] namespace: %w", i, err)
			}
			proxies[i] = entry
		}
		if err := unstructured.SetNestedSlice(obj.Object, proxies, "spec", "proxy"); err != nil {
			return nil, fmt.Errorf("writing spec.proxy: %w", err)
		}
	}

	return &obj, nil
}

// Apply creates the ConsolePlugin, or brings an existing one up to date.
//
// Every replica runs this at startup, so two of them race on a fresh install
// and the loser has to recover rather than fail: a create that comes back
// AlreadyExists is a success with extra steps. Updates go through
// RetryOnConflict for the same reason.
//
// The whole object is replaced rather than patched. Nothing else is supposed
// to be editing it, and a plugin that quietly kept someone's hand-edited proxy
// alias would be harder to explain than one that overwrites it on restart.
func Apply(ctx context.Context, client dynamic.Interface, obj *unstructured.Unstructured) (created bool, err error) {
	plugins := client.Resource(Resource)

	_, err = plugins.Create(ctx, obj, metav1.CreateOptions{})
	if err == nil {
		return true, nil
	}
	if !apierrors.IsAlreadyExists(err) {
		return false, fmt.Errorf("creating ConsolePlugin %s: %w", obj.GetName(), err)
	}

	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current, err := plugins.Get(ctx, obj.GetName(), metav1.GetOptions{})
		if err != nil {
			return err
		}
		next := obj.DeepCopy()
		// The one field the server owns and a blind update would reject.
		next.SetResourceVersion(current.GetResourceVersion())
		_, err = plugins.Update(ctx, next, metav1.UpdateOptions{})
		return err
	})
	if err != nil {
		return false, fmt.Errorf("updating ConsolePlugin %s: %w", obj.GetName(), err)
	}
	return false, nil
}
