{{/*
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — shared label/name helpers for the oshal chart.
2 | maintainer@emeraldcoastsystemsgroup.com   | 0.2.0 — oshal.activeBots helper: the selected fleet preset (fleet: kernel|full; custom = none) concatenated with the bots: extras, deduped by name (an extra that names a preset bot overrides nothing — first entry wins, so presets stay canonical).
*/}}

{{/* Common labels stamped on every object. */}}
{{- define "oshal.labels" -}}
app.kubernetes.io/part-of: oshal
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
oshal.io/role: {{ .Values.role }}
{{- if .Values.contributor }}
oshal.io/contributor: {{ .Values.contributor }}
{{- end }}
{{- end }}

{{/* The bot list to render: fleet preset + custom extras, deduped by name. */}}
{{- define "oshal.activeBots" -}}
{{- $preset := list -}}
{{- if ne .Values.fleet "custom" -}}
{{- $preset = index .Values.fleets .Values.fleet | default list -}}
{{- end -}}
{{- $seen := dict -}}
{{- $out := list -}}
{{- range concat $preset (.Values.bots | default list) -}}
{{- if not (hasKey $seen .name) -}}
{{- $_ := set $seen .name true -}}
{{- $out = append $out . -}}
{{- end -}}
{{- end -}}
{{- toJson $out -}}
{{- end }}

{{/* Tailscale hostname for this cluster's relay. */}}
{{- define "oshal.tailnetHostname" -}}
{{- if .Values.tailnet.hostname -}}
{{ .Values.tailnet.hostname }}
{{- else if eq .Values.role "main" -}}
oshal-main
{{- else -}}
oshal-botpod{{ if .Values.contributor }}-{{ .Values.contributor }}{{ end }}
{{- end -}}
{{- end }}

{{/* ACL tag for this cluster's relay. */}}
{{- define "oshal.tailnetTag" -}}
{{- if .Values.tailnet.tag -}}
{{ .Values.tailnet.tag }}
{{- else if eq .Values.role "main" -}}
tag:oshal-main
{{- else -}}
tag:oshal-botpod
{{- end -}}
{{- end }}
