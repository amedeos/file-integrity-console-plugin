package consoleplugin

import (
	"context"
	"errors"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

const doc = `
apiVersion: console.openshift.io/v1
kind: ConsolePlugin
metadata:
  name: file-integrity-console-plugin
spec:
  displayName: File Integrity
  backend:
    type: Service
    service:
      name: file-integrity-console-plugin
      namespace: PLACEHOLDER
      port: 9443
      basePath: /
  proxy:
    - alias: fio-backend
      authorization: UserToken
      endpoint:
        type: Service
        service:
          name: file-integrity-console-plugin
          namespace: PLACEHOLDER
          port: 9443
`

func namespaceOf(t *testing.T, obj *unstructured.Unstructured, fields ...string) string {
	t.Helper()
	v, found, err := unstructured.NestedString(obj.Object, fields...)
	if err != nil || !found {
		t.Fatalf("reading %v: found=%v err=%v", fields, found, err)
	}
	return v
}

func TestLoadRewritesEveryNamespace(t *testing.T) {
	obj, err := Load([]byte(doc), "somewhere-else")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if got := namespaceOf(t, obj, "spec", "backend", "service", "namespace"); got != "somewhere-else" {
		t.Errorf("backend namespace = %q, want somewhere-else", got)
	}

	proxies, _, err := unstructured.NestedSlice(obj.Object, "spec", "proxy")
	if err != nil {
		t.Fatalf("reading proxies: %v", err)
	}
	if len(proxies) != 1 {
		t.Fatalf("got %d proxies, want 1", len(proxies))
	}
	entry := proxies[0].(map[string]any)
	ns, _, _ := unstructured.NestedString(entry, "endpoint", "service", "namespace")
	if ns != "somewhere-else" {
		t.Errorf("proxy namespace = %q, want somewhere-else", ns)
	}
}

// The proxy alias is what carries the browsing user's token. A rewrite that
// corrected the backend and forgot the proxy would serve the assets from the
// right place and send every API call to a Service that may not exist — and
// the symptom would be a plugin that loads and then fails only on use.
func TestLoadLeavesNothingPointingAtTheOldNamespace(t *testing.T) {
	obj, err := Load([]byte(doc), "elsewhere")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	out, err := obj.MarshalJSON()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(out), "PLACEHOLDER") {
		t.Errorf("the rendered object still names the old namespace:\n%s", out)
	}
}

func TestLoadRejectsTheWrongKind(t *testing.T) {
	for name, in := range map[string]string{
		"a Service":       "apiVersion: v1\nkind: Service\nmetadata:\n  name: x\n",
		"no name":         "apiVersion: console.openshift.io/v1\nkind: ConsolePlugin\nspec: {}\n",
		"not YAML at all": "\tnope\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Load([]byte(in), "ns"); err == nil {
				t.Fatal("expected an error, got none")
			}
		})
	}
}

func TestLoadNeedsANamespace(t *testing.T) {
	if _, err := Load([]byte(doc), ""); err == nil {
		t.Fatal("expected an error when the namespace is empty")
	}
}

func newFake(objects ...runtime.Object) *fake.FakeDynamicClient {
	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(
		Resource.GroupVersion().WithKind("ConsolePluginList"),
		&unstructured.UnstructuredList{},
	)
	return fake.NewSimpleDynamicClientWithCustomListKinds(
		scheme,
		map[schema.GroupVersionResource]string{Resource: "ConsolePluginList"},
		objects...,
	)
}

func TestApplyCreatesWhenAbsent(t *testing.T) {
	obj, err := Load([]byte(doc), "ns")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	client := newFake()

	created, err := Apply(context.Background(), client, obj)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !created {
		t.Error("expected the object to be reported as created")
	}
	if _, err := client.Resource(Resource).Get(
		context.Background(), obj.GetName(), metav1.GetOptions{},
	); err != nil {
		t.Fatalf("the object was not created: %v", err)
	}
}

// Two replicas start together on a fresh install, so one of them loses the
// create. Losing must not be a failure.
func TestApplyUpdatesWhenAnotherReplicaWonTheRace(t *testing.T) {
	obj, err := Load([]byte(doc), "ns")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	existing, err := Load([]byte(doc), "the-old-namespace")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	client := newFake(existing)

	created, err := Apply(context.Background(), client, obj)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if created {
		t.Error("expected the object to be reported as updated, not created")
	}

	got, err := client.Resource(Resource).Get(
		context.Background(), obj.GetName(), metav1.GetOptions{},
	)
	if err != nil {
		t.Fatalf("reading back: %v", err)
	}
	if ns := namespaceOf(t, got, "spec", "backend", "service", "namespace"); ns != "ns" {
		t.Errorf("namespace after update = %q, want ns", ns)
	}
}

func TestApplyReportsAnUnexpectedFailure(t *testing.T) {
	obj, err := Load([]byte(doc), "ns")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	client := newFake()
	client.PrependReactor("create", "consoleplugins",
		func(k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, apierrors.NewForbidden(
				Resource.GroupResource(), obj.GetName(), errors.New("nope"),
			)
		})

	if _, err := Apply(context.Background(), client, obj); err == nil {
		t.Fatal("expected the forbidden error to be reported")
	}
}
