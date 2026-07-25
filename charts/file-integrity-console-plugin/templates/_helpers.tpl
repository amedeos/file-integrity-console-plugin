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
