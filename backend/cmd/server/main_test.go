package main

import "testing"

// The environment is the only channel an OLM install has for configuration: a
// Subscription can override a container's env but not its args. So these three
// helpers are the whole difference between a setting an administrator wrote and
// a setting that was ignored, and the interesting cases are the ones where an
// answer is still produced when it should not be.

func TestEnvName(t *testing.T) {
	for flagName, want := range map[string]string{
		"enable-file-retrieve": "PLUGIN_ENABLE_FILE_RETRIEVE",
		"max-file-bytes":       "PLUGIN_MAX_FILE_BYTES",
		"listen":               "PLUGIN_LISTEN",
	} {
		if got := envName(flagName); got != want {
			t.Errorf("envName(%q) = %q, want %q", flagName, got, want)
		}
	}
}

func TestEnvStringUnsetKeepsFallback(t *testing.T) {
	if got := envString("fio-namespace", "openshift-file-integrity"); got != "openshift-file-integrity" {
		t.Errorf("got %q, want the fallback", got)
	}
}

func TestEnvStringEmptyIsAValue(t *testing.T) {
	// Not the same as unset. `--tls-cert-file=` is how the two-container test
	// recipe asks for plain HTTP, and PLUGIN_TLS_CERT_FILE="" has to mean the same
	// thing rather than quietly restoring the default path.
	t.Setenv("PLUGIN_TLS_CERT_FILE", "")
	if got := envString("tls-cert-file", "/var/cert/tls.crt"); got != "" {
		t.Errorf("got %q, want the empty value that was set", got)
	}
}

func TestEnvBool(t *testing.T) {
	for value, want := range map[string]bool{
		"true":  true,
		"True":  true,
		"1":     true,
		"false": false,
		"0":     false,
	} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("PLUGIN_ENABLE_FILE_RETRIEVE", value)
			if got := envBool("enable-file-retrieve", false); got != want {
				t.Errorf("%q gave %v, want %v", value, got, want)
			}
		})
	}
}

func TestEnvBoolUnsetKeepsFallback(t *testing.T) {
	if envBool("enable-file-retrieve", false) {
		t.Error("unset should leave file retrieve off")
	}
}

func TestEnvInt64(t *testing.T) {
	t.Setenv("PLUGIN_MAX_FILE_BYTES", "2097152")
	if got := envInt64("max-file-bytes", 1<<20); got != 2097152 {
		t.Errorf("got %d, want 2097152", got)
	}
}

func TestEnvInt64UnsetKeepsFallback(t *testing.T) {
	if got := envInt64("max-file-bytes", 1<<20); got != 1<<20 {
		t.Errorf("got %d, want the fallback", got)
	}
}
