{{- define "ipam.name" -}}{{ .Release.Name }}-ipam{{- end -}}
{{- define "ipam.labels" -}}
app.kubernetes.io/name: ipam
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "ipam.selector" -}}
app.kubernetes.io/name: ipam
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "ipam.secretName" -}}{{ default (printf "%s-secrets" (include "ipam.name" .)) .Values.secrets.existingSecret }}{{- end -}}
{{- define "ipam.pgHost" -}}{{ include "ipam.name" . }}-db{{- end -}}
{{- define "ipam.backupRepoMounts" -}}
{{- $b := .Values.postgres.backup -}}
{{- if eq $b.repo.type "posix" }}
- {name: repo, mountPath: {{ $b.repo.path }}}
{{- else if eq $b.repo.gcs.keyType "service" }}
- {name: gcs-key, mountPath: /etc/pgbackrest-gcs, readOnly: true}
{{- end }}
{{- end -}}
{{- define "ipam.backupRepoVolumes" -}}
{{- $b := .Values.postgres.backup -}}
{{- if eq $b.repo.type "posix" }}
- name: repo
  persistentVolumeClaim: {claimName: {{ include "ipam.pgHost" . }}-respaldos}
{{- else if eq $b.repo.gcs.keyType "service" }}
- name: gcs-key
  secret: {secretName: {{ $b.repo.gcs.keySecret }}}
{{- end }}
{{- end -}}
