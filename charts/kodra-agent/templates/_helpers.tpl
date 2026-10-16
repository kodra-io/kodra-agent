{{- define "kodra-agent.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "kodra-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kodra-agent.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "kodra-agent.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "kodra-agent.serviceAccountName" -}}
{{- .Values.serviceAccount.name | default .Release.Name -}}
{{- end -}}

{{- define "kodra-agent.image" -}}
{{- $repo := .Values.image.repository -}}
{{- if .Values.image.registry -}}
{{- $parts := splitList "/" $repo -}}
{{- if and (gt (len $parts) 1) (or (contains "." (first $parts)) (contains ":" (first $parts))) -}}
{{- $repo = join "/" (rest $parts) -}}
{{- end -}}
{{- $repo = printf "%s/%s" (trimSuffix "/" .Values.image.registry) $repo -}}
{{- end -}}
{{- printf "%s:%s" $repo (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{- /*
Whether a hostname is an in-cluster service: <service>.<namespace>.svc[.cluster.local], or
<service>.<namespace> when the last label is not a public top-level domain (gitlab.com is
public, prometheus.monitoring is not). Use the .svc form to be certain.
*/ -}}
{{- define "kodra-agent.inCluster" -}}
{{- $labels := splitList "." . -}}
{{- if and (ge (len $labels) 3) (eq (index $labels 2) "svc") -}}true
{{- else if and (eq (len $labels) 2) (not (regexMatch "^([a-z]{2}|com|net|org|io|dev|app|cloud|ai|co|info|biz|xyz|tech|site|online|example|local|internal|corp|lan)$" (last $labels))) -}}true
{{- end -}}
{{- end -}}
