{{/*
Name of the plugin, and of nearly everything the chart creates.

Deliberately *not* derived from the release name: this is the ConsolePlugin
name, which the frontend hardcodes as PLUGIN_NAME to build its proxy URL
(src/constants.ts). Two releases in one cluster would collide, and that is the
honest outcome — the console keys plugins by name, so there is only one slot.
*/}}
{{- define "file-integrity-console-plugin.name" -}}
{{- default .Chart.Name .Values.plugin.name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "file-integrity-console-plugin.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "file-integrity-console-plugin.labels" -}}
helm.sh/chart: {{ include "file-integrity-console-plugin.chart" . }}
{{ include "file-integrity-console-plugin.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "file-integrity-console-plugin.selectorLabels" -}}
app: {{ include "file-integrity-console-plugin.name" . }}
app.kubernetes.io/name: {{ include "file-integrity-console-plugin.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: {{ include "file-integrity-console-plugin.name" . }}
{{- end }}

{{/*
Create the name of the secret containing the certificate
*/}}
{{- define "file-integrity-console-plugin.certificateSecret" -}}
{{ default (printf "%s-cert" (include "file-integrity-console-plugin.name" .)) .Values.plugin.certificateSecretName }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "file-integrity-console-plugin.serviceAccountName" -}}
{{- if .Values.plugin.serviceAccount.create }}
{{- default (include "file-integrity-console-plugin.name" .) .Values.plugin.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.plugin.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the ConfigMap holding the deny lists
*/}}
{{- define "file-integrity-console-plugin.policyConfigMap" -}}
{{- printf "%s-policy" (include "file-integrity-console-plugin.name" .) }}
{{- end }}

{{/*
Whether a policy ConfigMap is needed at all
*/}}
{{- define "file-integrity-console-plugin.hasPolicyConfigMap" -}}
{{- if or .Values.backend.denyList .Values.backend.extraDenyList }}true{{- end }}
{{- end }}

{{/*
The ConsolePlugin object, in one place.

Rendered either as a manifest of its own or as the body of a ConfigMap the
init container applies, and defined here so those two never drift. The
namespace written here is the one `helm template` was pointed at; in
initContainer mode it is replaced at startup by the pod's own, read through the
downward API, because OLM fills nothing in inside a cluster-scoped manifest.
*/}}
{{- define "file-integrity-console-plugin.consolePluginObject" -}}
apiVersion: console.openshift.io/v1
kind: ConsolePlugin
metadata:
  name: {{ template "file-integrity-console-plugin.name" . }}
  labels:
    {{- include "file-integrity-console-plugin.labels" . | nindent 4 }}
spec:
  displayName: {{ default (printf "%s Plugin" (include "file-integrity-console-plugin.name" .)) .Values.plugin.description }}
  i18n:
    loadType: Preload
  backend:
    type: Service
    service:
      name: {{ template "file-integrity-console-plugin.name" . }}
      namespace: {{ .Release.Namespace }}
      port: {{ .Values.plugin.port }}
      basePath: {{ .Values.plugin.basePath }}
  proxy:
    # authorization: UserToken makes the console forward the logged-in user's
    # token to us. Without it the backend would see no credentials and reject
    # every request — by design, it never falls back to its own identity.
    #
    # Declared even when backend.features.fileRetrieve is off. The switch that
    # matters is --enable-file-retrieve on the backend, which answers 501 and
    # asks for no cluster credentials at all; dropping the proxy instead would
    # make the console answer 404, which the UI can only report as "no scan pod
    # found on this node" — the wrong reason.
    - alias: fio-backend
      authorization: UserToken
      endpoint:
        type: Service
        service:
          name: {{ template "file-integrity-console-plugin.name" . }}
          namespace: {{ .Release.Namespace }}
          port: {{ .Values.plugin.port }}
{{- end }}

{{/*
Name of the ConfigMap the init container reads the ConsolePlugin from
*/}}
{{- define "file-integrity-console-plugin.consolePluginConfigMap" -}}
{{- printf "%s-consoleplugin" (include "file-integrity-console-plugin.name" .) }}
{{- end }}

{{/*
Whether the ConsolePlugin is created by an init container rather than shipped
*/}}
{{- define "file-integrity-console-plugin.selfRegisters" -}}
{{- if eq .Values.plugin.consolePlugin.mode "initContainer" }}true{{- end }}
{{- end }}

{{/*
Create the name of the patcher
*/}}
{{- define "file-integrity-console-plugin.patcherName" -}}
{{- printf "%s-patcher" (include "file-integrity-console-plugin.name" .) }}
{{- end }}

{{/*
Create the name of the service account the patcher Jobs run as
*/}}
{{- define "file-integrity-console-plugin.patcherServiceAccountName" -}}
{{- if .Values.plugin.patcherServiceAccount.create }}
{{- default (printf "%s-patcher" (include "file-integrity-console-plugin.name" .)) .Values.plugin.patcherServiceAccount.name }}
{{- else }}
{{- default "default" .Values.plugin.patcherServiceAccount.name }}
{{- end }}
{{- end }}
