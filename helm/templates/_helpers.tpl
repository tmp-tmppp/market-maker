{{/* Name of every object of the release. */}}
{{- define "market-maker.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels that select the Pods; never change them after the first install (selectors are immutable). The value of
     app.kubernetes.io/name is the chart name, which trading's NetworkPolicy lists as an allowed caller of its internal port. */}}
{{- define "market-maker.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Labels on every object. */}}
{{- define "market-maker.labels" -}}
{{ include "market-maker.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Restricted security context of every container. */}}
{{- define "market-maker.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* Name of the ConfigMap with the runtime configuration file (kept apart from the environment ConfigMap). */}}
{{- define "market-maker.runtimeConfigMap" -}}
{{ include "market-maker.fullname" . }}-runtime
{{- end -}}

{{/* The directory the runtime ConfigMap is mounted at, and the file in it that RUNTIME_CONFIG_FILE names. */}}
{{- define "market-maker.runtimeDir" -}}
/etc/market-maker/runtime
{{- end -}}

{{- define "market-maker.runtimeFile" -}}
{{ include "market-maker.runtimeDir" . }}/runtime.env
{{- end -}}

{{/* The base URL of trading's internal port (TRADING_URL). */}}
{{- define "market-maker.tradingUrl" -}}
http://{{ .Values.trading.host }}:{{ .Values.trading.port }}
{{- end -}}
