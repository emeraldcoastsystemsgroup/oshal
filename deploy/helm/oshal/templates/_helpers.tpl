{{/*
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — shared label/name helpers for the oshal chart.
2 | maintainer@emeraldcoastsystemsgroup.com   | 0.2.0 — oshal.activeBots helper: the selected fleet preset (fleet: kernel|full; custom = none) concatenated with the bots: extras, deduped by name (an extra that names a preset bot overrides nothing — first entry wins, so presets stay canonical).
3 | maintainer@emeraldcoastsystemsgroup.com   | 0.5.0 — database DSN helpers (oshal.bootstrapDatabaseUrl / oshal.appDatabaseUrl / oshal.botDatabaseUrl) so the oshal_app and oshal_bot DSNs are built once, from values (infra.postgres.appPassword / botPassword, swarm.botDatabaseUrl), into the oshal-db-credentials Secret — api.yaml used to hardcode oshal_app:oshal-app-dev with no values path. oshal.validateRolePasswords refuses, at render time, a role password provision-app-role.mjs would refuse at boot (anything but the in-cluster dev default or 48-128 hex characters, or the two passwords equal), so a bad value fails `helm install` instead of crash-looping the api. oshal.credentialNameRegex is the credential-shaped name rule swarm.extraEnv is held to.
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

{{/* In-cluster superuser DSN (the api's BOOTSTRAP_DATABASE_URL only — never a bot's). */}}
{{- define "oshal.bootstrapDatabaseUrl" -}}
{{- $pg := .Values.infra.postgres -}}
postgresql://{{ $pg.user }}:{{ $pg.password }}@oshal-db:5432/{{ $pg.database }}
{{- end }}

{{/* In-cluster oshal_app DSN (the api's DATABASE_URL), password from infra.postgres.appPassword. */}}
{{- define "oshal.appDatabaseUrl" -}}
{{- $pg := .Values.infra.postgres -}}
postgresql://oshal_app:{{ $pg.appPassword }}@oshal-db:5432/{{ $pg.database }}
{{- end }}

{{/* oshal_bot DSN: swarm.botDatabaseUrl when set, else in-cluster from infra.postgres.botPassword. */}}
{{- define "oshal.botDatabaseUrl" -}}
{{- $pg := .Values.infra.postgres -}}
{{- .Values.swarm.botDatabaseUrl | default (printf "postgresql://oshal_bot:%s@oshal-db:5432/%s" $pg.botPassword $pg.database) -}}
{{- end }}

{{/*
Refuse, at render time, a runtime role password the api's bootstrap (provision-app-role.mjs) would
refuse at boot: it accepts the in-cluster dev defaults, or 48-128 hexadecimal characters, and the
two passwords must differ. Hex also means the DSN needs no URL-encoding.
*/}}
{{- define "oshal.validateRolePasswords" -}}
{{- $pg := .Values.infra.postgres -}}
{{- range $key, $dev := dict "appPassword" "oshal-app-dev" "botPassword" "oshal-bot-dev" -}}
{{- $pw := toString (index $pg $key) -}}
{{- if not (or (eq $pw $dev) (regexMatch "^[0-9a-fA-F]{48,128}$" $pw)) -}}
{{- fail (printf "infra.postgres.%s must be 48-128 hexadecimal characters (generate with: openssl rand -hex 24); the api's app-role bootstrap refuses anything else except the in-cluster dev default %q" $key $dev) -}}
{{- end -}}
{{- end -}}
{{- if eq (toString $pg.appPassword) (toString $pg.botPassword) -}}
{{- fail "infra.postgres.appPassword and infra.postgres.botPassword must differ; the api's app-role bootstrap refuses equal runtime role passwords" -}}
{{- end -}}
{{- end }}

{{/*
Credential-shaped env names. swarm.extraEnv is rendered into a ConfigMap, and a ConfigMap is not
where a credential goes: such a key fails the render (templates/shared-env-configmap.yaml).
*/}}
{{- define "oshal.credentialNameRegex" -}}
(?i)(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|KEY$|DATABASE_URL|_DSN$)
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
