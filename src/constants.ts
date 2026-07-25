/**
 * Constants mirrored from the File Integrity Operator.
 *
 * Source of truth: github.com/openshift/file-integrity-operator
 *   - pkg/common/constants.go
 *   - pkg/common/var.go
 *
 * Keep these in sync when bumping the supported operator version.
 */

/** The operator only ever watches this namespace (pkg/common/var.go). */
export const FIO_NAMESPACE = 'openshift-file-integrity';

/** i18n namespace, must match locales/<lang>/<ns>.json. */
export const I18N_NS = 'plugin__file-integrity-console-plugin';

/** Must match consolePlugin.name in package.json. */
export const PLUGIN_NAME = 'file-integrity-console-plugin';

/** Proxy alias declared in the ConsolePlugin resource. */
export const BACKEND_PROXY_ALIAS = 'fio-backend';

/** Console-proxied base URL of our backend. */
export const BACKEND_BASE_URL = `/api/proxy/plugin/${PLUGIN_NAME}/${BACKEND_PROXY_ALIAS}`;

/** Key inside the result ConfigMap holding the AIDE report. */
export const INTEGRITY_LOG_CONTENT_KEY = 'integritylog';

export const ANNOTATIONS = {
  /** Present (any value) => `integritylog` is gzip-then-base64 encoded. */
  compressed: 'file-integrity.openshift.io/compressed',
  filesAdded: 'file-integrity.openshift.io/files-added',
  filesChanged: 'file-integrity.openshift.io/files-changed',
  filesRemoved: 'file-integrity.openshift.io/files-removed',
  errorMsg: 'file-integrity.openshift.io/log-errormsg',
  /** Set on the FileIntegrity CR: comma separated node list, or empty for all. */
  reinit: 'file-integrity.openshift.io/re-init',
  /** Set on the FileIntegrity CR: re-init every currently failing node. */
  reinitOnFailed: 'file-integrity.openshift.io/re-init-on-failed',
  /** Managed by the operator while a re-init is in flight. Read-only for us. */
  holdoff: 'file-integrity.openshift.io/holdoff',
} as const;

export const LABELS = {
  owner: 'file-integrity.openshift.io/owner',
  node: 'file-integrity.openshift.io/node',
  resultLog: 'file-integrity.openshift.io/result-log',
} as const;

/**
 * The operator replaces an oversized report with this sentence
 * (cmd/manager/logcollector_util.go). We surface it as "truncated"
 * rather than trying to parse it.
 */
export const TRUNCATED_MARKERS = [
  'is too large for a configMap',
  'fetch it from /etc/kubernetes/aide.log on node',
];
