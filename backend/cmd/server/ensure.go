package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"

	"github.com/openshift/file-integrity-console-plugin/backend/internal/consoleplugin"
)

// ensureConsolePluginCmd is the name of the subcommand, and the only argument
// that makes this binary do something other than serve.
const ensureConsolePluginCmd = "ensure-consoleplugin"

// ensureConsolePlugin registers the plugin with the console, then exits.
//
// It runs as an init container, which is a deliberate choice over a
// controller. The object it creates is written once and never drifts, so
// reconciliation would buy only the recovery of a manual deletion — and it
// would buy that at the cost of the worse failure: a controller that cannot
// create the object logs and retries forever while the pod stays Running, the
// deployment stays Ready, and the console shows nothing. This repository has
// chased that shape of silence three times. An init container that fails
// leaves the pod in Init:Error, which `oc get pods` says out loud and which
// hack/lab/bundle.sh already fails on.
func ensureConsolePlugin(args []string) {
	fs := flag.NewFlagSet(ensureConsolePluginCmd, flag.ExitOnError)
	path := fs.String("consoleplugin-file",
		envString("consoleplugin-file", "/etc/file-integrity-plugin/consoleplugin.yaml"),
		"the ConsolePlugin to apply, mounted from a ConfigMap")
	namespace := fs.String("pod-namespace", envString("pod-namespace", ""),
		"namespace this pod runs in; every Service reference is pointed at it")
	timeout := fs.Duration("timeout", 60*time.Second, "give up after this long")
	if err := fs.Parse(args); err != nil {
		os.Exit(2)
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	// Read through the downward API rather than templated in, because that is
	// the whole point: OLM fills nothing in inside a cluster-scoped manifest,
	// so a shipped ConsolePlugin has to state a namespace it cannot know.
	if *namespace == "" {
		log.Error("no namespace",
			"hint", "set PLUGIN_POD_NAMESPACE from metadata.namespace via the downward API")
		os.Exit(1)
	}

	data, err := os.ReadFile(*path)
	if err != nil {
		log.Error("reading the ConsolePlugin", "path", *path, "error", err)
		os.Exit(1)
	}

	obj, err := consoleplugin.Load(data, *namespace)
	if err != nil {
		log.Error("loading the ConsolePlugin", "path", *path, "error", err)
		os.Exit(1)
	}

	cfg, err := rest.InClusterConfig()
	if err != nil {
		log.Error("building the in-cluster config", "error", err)
		os.Exit(1)
	}
	client, err := dynamic.NewForConfig(cfg)
	if err != nil {
		log.Error("building the API client", "error", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	created, err := consoleplugin.Apply(ctx, client, obj)
	if err != nil {
		log.Error("registering the plugin with the console",
			"consolePlugin", obj.GetName(), "namespace", *namespace, "error", err)
		os.Exit(1)
	}
	log.Info("registered the plugin with the console",
		"consolePlugin", obj.GetName(), "namespace", *namespace, "created", created)
}
