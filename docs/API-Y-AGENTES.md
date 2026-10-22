# API y agentes

La referencia exacta es el contrato **OpenAPI 3.1** que sirve el propio IPAM: `GET /api/v1/openapi.json`. Para **verlo y probarlo en el navegador**, abre **`/api.html`** (enlace «API» arriba a la derecha de la interfaz): cada llamada tiene «Try it out»; con **Authorize** pegas un token para probar como un agente. También puedes importar el JSON en Postman o Insomnia. Esta guía es el recorrido práctico. Todos los ejemplos usan rangos **ficticios** y variables de entorno; **nunca pegues un token real en un chat, un commit ni un log**.

```bash
export IPAM_URL=https://ipam-poc.onrender.com     # tu instancia
export IPAM_TOKEN=...                              # un token «agente» (ver más abajo); viene de tu gestor de secretos
```

## 1 · Autenticación
| Quién | Cómo |
|---|---|
| Agente / pipeline | `Authorization: Bearer $IPAM_TOKEN` (no necesita nada más) |
| Persona con SSO | Cookie de sesión (la interfaz) |
| POC | Basic (`-u usuario:clave`) y la cabecera `X-Requested-With: ipam` en peticiones que modifican datos |

Un token Bearer se evalúa **primero**, en cualquier modo. Roles: `lector < agente < solicitante < admin`; los tokens son `lector` o `agente`.

## 2 · Crear un token (lo hace un admin)
En la interfaz: pestaña **Tokens**. Por API:
```bash
curl -s -u admin:"$CLAVE" -H 'X-Requested-With: ipam' -H 'Content-Type: application/json' \
  -d '{"nombre":"agente-redes","rol":"agente","expira_dias":30,"cuota_reservas":10}' \
  "$IPAM_URL/api/v1/tokens"
```
La respuesta trae el token **una sola vez** (`ipam_` + 43 caracteres). Guárdalo en el gestor de secretos del pipeline. En la base solo queda su hash SHA-256.

## 3 · Flujo del agente: reservar → aprobar → confirmar (o liberar)
**Ver qué pools hay y cuánto espacio libre**
```bash
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/pools"
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/pools/dev-nodos/libres?mascara=24"
```
**Cuánto queda por máscara**
```bash
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/pools/dev-nodos/disponibilidad"
```
Devuelve `total`, `ocupadas`, `libres` y, por cada máscara, `direcciones`, `utilizables`, `bloques_libres` y `direcciones_libres` (cuenta asignaciones y reservas vigentes).

**Reservar** (idempotente con `Idempotency-Key`: si el pipeline reintenta, no duplica)
```bash
curl -s -H "Authorization: Bearer $IPAM_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: mr-1234-dev-nodos" \
  -d '{"pool":"dev-nodos","mascara":24,"vpc":"vpc-ejemplo-nuevo","ticket":"DEMO-9","ttl_horas":24}' \
  "$IPAM_URL/api/v1/reservas"
```
También puedes indicar `ambiente` y `tipo` en vez de `pool` para que el IPAM elija el pool, o un `cidr` concreto. Respuestas: `201` creada; `200` con `repetida: true` si la misma clave ya tiene reserva viva; `409` si el rango choca o la clave pertenece a una reserva liberada o expirada; `429` si superas la cuota.

**Consultar**
```bash
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/reservas?estado=reservada"
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/reservas/<id>"
```
**Confirmar** (solo después de que una persona aprobó; `aprobado_por` y `referencia` son obligatorios para un token)
```bash
curl -s -X POST -H "Authorization: Bearer $IPAM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"aprobado_por":"ana@empresa.example","referencia":"https://gitlab.example/redes/-/merge_requests/12"}' \
  "$IPAM_URL/api/v1/reservas/<id>/confirmar"
```
**Liberar** (si falla o se rechaza)
```bash
curl -s -X DELETE -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/reservas/<id>"
```
Si nadie confirma ni libera, la reserva **expira sola** (24 h por defecto, 72 h máximo).

**Direcciones IP fijas** (interfaces de router, switch, firewall…): el agente registra la IP y el IPAM la ubica sola en su segmento.
```bash
curl -s -H "Authorization: Bearer $IPAM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"ip":"10.220.16.1","dispositivo":"rtr-core-01","interfaz":"Gi0/1","rol":"gateway"}' \
  "$IPAM_URL/api/v1/direcciones"
# ¿Qué IP tiene cada interfaz de un equipo?
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/direcciones?q=rtr-core-01"
```
Si la IP está fuera de todo segmento asignado, es una **excepción**: agrega `"excepcion":"motivo"`. Si cae en varios pools (rangos privados repetidos en distintos ambientes), la respuesta es `422 ip_ambigua` con `opciones`: repite con `"pool":"…"`. Roles: `rol` ∈ `interfaz`, `gateway`, `gestion`, `loopback`, `vip`, `servidor`, `otro`. Editar: `PATCH /api/v1/direcciones/{id}`; eliminar: solo admin.

**Pools (bloques base, solo admin)**: `POST /api/v1/pools` (`id`, `tipo`, `ambiente`, `proveedor`, `cidr` de /8 a /30), `PATCH /api/v1/pools/{id}` (tipo y proveedor) y `DELETE /api/v1/pools/{id}` (solo vacío). Un pool no puede solaparse con otro del mismo proveedor y ambiente.

## 4 · Errores y límites
Los errores son JSON con `error`, `mensaje` y `request_id` (el mismo que viaja en los logs y la auditoría; pásalo al soporte). Códigos habituales: `400` validación, `401` sin credenciales, `403` rol insuficiente, `404`, `409` solapamiento o estado inválido, `429` límite o cuota (con `Retry-After`). El límite por minuto es configurable ([CONFIGURACION](CONFIGURACION.md)).

## 5 · Compatibilidad
Las rutas `/api/...` sin versión siguen funcionando como alias de `/api/v1/...`. Las nuevas integraciones deben usar `/api/v1`. El contrato se valida contra las respuestas reales en las pruebas automáticas.

## 6 · Ejemplo de pipeline
Un pipeline completo (OpenTofu con aprobación manual y `confirmar-ipam` / `liberar-ipam`) está en [ops/gitlab](ops/gitlab/README.md). El contrato del YAML de entrada: [CONTRATO-YAML-REDES](CONTRATO-YAML-REDES.md).
