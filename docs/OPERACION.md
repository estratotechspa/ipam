# Operación: respaldos y exposición del servicio

## 1. Respaldos incrementales (PostgreSQL incluido en el chart)

Con una base administrada (Cloud SQL, RDS…) usa sus respaldos nativos y deja `postgres.backup.enabled=false`.
Con el PostgreSQL del chart, `postgres.backup.enabled=true` agrega **pgBackRest**: archivado continuo de WAL + respaldos
completos e incrementales a un bucket de GCS.

### Política por defecto
| Qué | Cuándo | Retención |
|---|---|---|
| Respaldo **completo** | domingo 02:00 UTC (`schedule.fullDay`, `schedule.hour`) | 4 completos (≈ 4 semanas) |
| Respaldo **incremental** | resto de los días 02:00 UTC | se vence junto con su completo |
| **WAL** (cada cambio) | continuo (`archive_timeout=300` s) | los necesarios para los respaldos vigentes |
| **Prueba de restauración** | día 1 de cada mes | restaura el último respaldo en un directorio temporal, arranca una instancia y cuenta filas; deja el resultado en el log del contenedor `respaldos` |

Con WAL continuo se puede **volver a cualquier instante** dentro de la retención (RPO de minutos, no de un día). Los respaldos son por bloques y empaquetados (`repo1-block`, `repo1-bundle`) y comprimidos con zstd.

### Puesta en marcha con un bucket de GCS
1. Bucket (sugerido: ubicación regional, acceso uniforme, **sin** acceso público), p. ej. `gs://cliente-ipam-respaldos`.
2. Cuenta de servicio con `roles/storage.objectAdmin` **solo sobre ese bucket**.
3. Credenciales, una de dos:
   - **Workload Identity (recomendado en GKE):** enlazar la ServiceAccount de Kubernetes con la de Google y pasar `postgres.backup.serviceAccountAnnotations."iam\.gke\.io/gcp-service-account"=ipam-backup@PROYECTO.iam.gserviceaccount.com` con `repo.gcs.keyType=auto`.
   - **Llave JSON:** `kubectl -n ipam create secret generic gcs-respaldos --from-file=key.json=llave.json` y `repo.gcs.keyType=service`, `repo.gcs.keySecret=gcs-respaldos`.
4. Redes sin salida a Internet: `repo.gcs.endpoint` con el endpoint privado (Private Service Connect).
5. Valores:
   ```yaml
   postgres:
     backup:
       enabled: true
       image: REGISTRO/ipam-postgres:16      # construida desde mvp/postgres (publicar.yml la publica)
       repo: {type: gcs, path: /ipam, gcs: {bucket: cliente-ipam-respaldos, keyType: auto}}
   ```
6. Al arrancar, el contenedor `respaldos` crea el *stanza* y hace un primer respaldo completo. Revisar:
   `kubectl -n ipam logs ipam-ipam-db-0 -c respaldos` y `kubectl -n ipam exec ipam-ipam-db-0 -c respaldos -- pgbackrest --stanza=ipam info`.

### Restaurar (recuperación ante desastre)
Se probó en un clúster de prueba (repositorio `posix`) borrando datos y volviendo a un instante anterior.
1. Apagar la app y la base: `kubectl -n ipam scale deploy/ipam-ipam --replicas=0 && kubectl -n ipam scale statefulset/ipam-ipam-db --replicas=0`.
2. Lanzar un pod con la misma imagen, el mismo ConfigMap `…-db-pgbackrest` y el volumen de datos `data-<release>-ipam-db-0`:
   ```yaml
   apiVersion: v1
   kind: Pod
   metadata: {name: restaurar-ipam, namespace: ipam}
   spec:
     restartPolicy: Never
     securityContext: {runAsNonRoot: true, runAsUser: 70, runAsGroup: 70, fsGroup: 70, seccompProfile: {type: RuntimeDefault}}
     containers:
       - name: restaurar
         image: REGISTRO/ipam-postgres:16
         securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
         # Último estado:           [pgbackrest, --stanza=ipam, --delta, restore]
         # A un instante concreto:  [pgbackrest, --stanza=ipam, --delta, --type=time, "--target=2026-10-20 22:45:53+00", --target-action=promote, restore]
         command: [pgbackrest, --stanza=ipam, --delta, --type=time, "--target=AAAA-MM-DD HH:MM:SS+00", --target-action=promote, restore]
         volumeMounts:
           - {name: data, mountPath: /var/lib/postgresql/data}
           - {name: cfg, mountPath: /etc/pgbackrest, readOnly: true}
           - {name: tmp, mountPath: /tmp}
           # con GCS y llave JSON añade además el volumen del Secret en /etc/pgbackrest-gcs
     volumes:
       - {name: data, persistentVolumeClaim: {claimName: data-ipam-ipam-db-0}}
       - {name: cfg, configMap: {name: ipam-ipam-db-pgbackrest}}
       - {name: tmp, emptyDir: {}}
   ```
   (Con repositorio `posix` hay que montar también el volumen del repositorio en su ruta. Con Workload Identity, usar la ServiceAccount de la base.)
3. Cuando el pod termine (`Succeeded`): `kubectl -n ipam delete pod restaurar-ipam`, subir de nuevo la base (`replicas=1`) y luego la app.
4. Tras una recuperación a un instante, hacer un respaldo completo: `kubectl -n ipam exec ipam-ipam-db-0 -c respaldos -- pgbackrest --stanza=ipam --type=full backup`.
5. **Restaurar en otro clúster** (por ejemplo, el del cliente): instalar el chart con otros valores, apuntando a un bucket vacío, y cargar los datos con el respaldo lógico JSON (`/api/exportar.json` → `/api/importar`, ver README). La restauración física de pgBackRest sirve para recuperar **la misma** base.

### Qué vigilar
- `pg_stat_archiver.failed_count` > 0 o un `ERROR` reciente en el log de `respaldos`: si el archivado de WAL falla, los WAL se acumulan en el volumen de datos y pueden llenarlo. Conviene una alerta sobre el volumen y sobre esos logs.
- `pgbackrest info` debe mostrar `status: ok` y un respaldo del día.
- El resultado mensual de la prueba de restauración (`prueba-restauracion: OK …`).

## 2. Exponer el servicio en una URL interna del cliente

Un solo valor manda: `config.publicUrl` (o, si está activado el ingress, `https://<ingress.host>`).

```yaml
ingress:
  enabled: true
  className: nginx                       # la del ingress controller del cliente
  host: ipam.cliente.interno.cl
  tls: [{secretName: ipam-tls, hosts: [ipam.cliente.interno.cl]}]   # cert-manager con la CA interna o un Secret propio
  annotations: {}                        # p. ej. cert-manager.io/cluster-issuer: ca-interna
config:
  trustProxy: "1"                        # saltos de proxy delante de la app
  hsts: true                             # si el acceso es siempre por HTTPS
networkPolicy:
  ingressFrom:                           # opcional: solo el ingress controller puede llegar a la app
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: ingress-nginx}}
```
- **Gateway API** en lugar de Ingress: `httpRoute.enabled=true`, `httpRoute.parentRefs=[{name: gateway-interno, namespace: infra}]`.
- **TLS terminado fuera del clúster** (balanceador del cliente): `ingress.tls` vacío y `config.publicUrl=https://ipam.cliente.interno.cl`; la cookie de sesión sale `Secure` porque la URL pública es https.
- **DNS:** un registro A/CNAME de `ipam.cliente.interno.cl` hacia el ingress o balanceador (lo administra el cliente).
- **Login:** registrar `https://ipam.cliente.interno.cl/auth/callback` como URI de redirección en el proveedor OIDC y, si usa Jira, apuntar su webhook a `https://ipam.cliente.interno.cl/webhook/jira`.
- Se probó en un clúster de prueba con nginx-ingress: ruteo por nombre de host (un host desconocido da 404), TLS terminado con el certificado entregado y `PUBLIC_URL` deducido del host.

## 3. De la POC (estratotech.cl) al tenant del cliente
1. Instalar el chart en el clúster del cliente con **sus** valores: dominio, imagen de su registro (`BASE_IMAGE`/`BUILD_IMAGE` si exigen sus bases), proveedor OIDC, bucket, marca, StorageClass.
2. En la POC: *Respaldo JSON* (admin). En el cliente: `POST /api/importar` con ese archivo.
3. Registrar la nueva URL de retorno en su proveedor OIDC y la del webhook en su Jira.
4. Apagar la POC. Nada de EstratoTech queda en el código ni en la imagen: solo en los valores de la POC.

## 4. Operación de la aplicación

- **Errores internos:** la API nunca devuelve el mensaje de un error inesperado; responde `{"error":"interno","id":"1a2b3c4d"}` y el detalle completo queda en el log del contenedor con ese mismo `id` (`[error 1a2b3c4d] POST /api/…`). Para investigar un reporte: `kubectl -n ipam logs deploy/ipam-ipam | grep 1a2b3c4d`.
- **Retención:** `RETENCION_DIAS` (chart: `config.retencionDias`, 365 por defecto) borra de `eventos` y `auditoria` lo más antiguo que ese plazo. Corre al arrancar y cada 24 h en cada réplica (es idempotente). Si la auditoría debe conservarse más tiempo por política, súbelo o usa `0` (sin purga) y archiva la tabla por tu cuenta. El índice `eventos_ts_idx` lo crea el esquema.
- **Apagado ordenado:** con SIGTERM/SIGINT la app deja de aceptar conexiones (`/api/health` responde 503 para que el balanceador deje de enviarle tráfico), termina las peticiones en curso y la sincronización con Jira pendiente, cierra el pool de PostgreSQL y sale con 0. Tiene `SHUTDOWN_TIMEOUT_MS` (10 s) como tope; el `terminationGracePeriodSeconds` de Kubernetes (30 s por defecto) lo cubre.
- **Base de datos lenta o caída:** una consulta se corta a los `DB_STATEMENT_TIMEOUT_MS` (15 s) y esperar una conexión libre falla a los `DB_CONNECT_TIMEOUT_MS` (5 s) en vez de colgar la petición; un error en una conexión inactiva se registra y no tumba el proceso.
- **Jira:** la sincronización saliente va en segundo plano; el resultado (`jira_ticket_creado`, `jira_ticket_actualizado`, `jira_error`) se ve en la pestaña *Jira* y en la tabla `eventos`.
