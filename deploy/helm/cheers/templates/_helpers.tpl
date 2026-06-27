{{/* Base name + fullname (release-prefixed, DNS-safe, ≤63 chars). */}}
{{- define "cheers.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cheers.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Common + selector labels. */}}
{{- define "cheers.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "cheers.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: cheers
{{- end -}}

{{/* Per-component selector labels. Usage: include "cheers.selectorLabels" (dict "ctx" . "component" "gateway") */}}
{{- define "cheers.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cheers.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Component resource names (release-prefixed). */}}
{{- define "cheers.gateway.fullname" -}}{{ include "cheers.fullname" . }}-gateway{{- end -}}
{{- define "cheers.frontend.fullname" -}}{{ include "cheers.fullname" . }}-frontend{{- end -}}
{{- define "cheers.postgres.fullname" -}}{{ include "cheers.fullname" . }}-postgres{{- end -}}
{{- define "cheers.rustfs.fullname" -}}{{ include "cheers.fullname" . }}-rustfs{{- end -}}
{{- define "cheers.redis.fullname" -}}{{ include "cheers.fullname" . }}-redis{{- end -}}

{{/* The Secret name in use (existing override or chart-managed). */}}
{{- define "cheers.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "cheers.fullname" . }}-secrets
{{- end -}}
{{- end -}}

{{/* Image ref with optional global registry prefix. Usage: include "cheers.image" (dict "ctx" . "repository" "x" "tag" "y") */}}
{{- define "cheers.image" -}}
{{- $reg := .ctx.Values.imageRegistry -}}
{{- $repo := .repository -}}
{{- $tag := default .ctx.Chart.AppVersion .tag -}}
{{- if $reg -}}{{ printf "%s/%s:%s" $reg $repo $tag }}{{- else -}}{{ printf "%s:%s" $repo $tag }}{{- end -}}
{{- end -}}

{{/* DATABASE_URL for the gateway (postgres bundled or external via postgres.externalUrl). */}}
{{- define "cheers.databaseUrl" -}}
postgresql://{{ .Values.postgres.username }}:$(POSTGRES_PASSWORD)@{{ include "cheers.postgres.fullname" . }}:5432/{{ .Values.postgres.database }}
{{- end -}}
