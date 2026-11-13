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
  -d '{"nombre":"agente-redes","rol":"agente","expira_dias":30,"cuota_reservas":10,"alcance":["reservas","consulta"]}' \
  "$IPAM_URL/api/v1/tokens"
```
`alcance` limita el token a grupos de la API: `reservas` (reservar, consultar, liberar las propias), `consulta` (pools, disponibilidad y asignaciones, para comprobar que no haya solapamientos) y `direcciones` (IP fijas). Fuera de ellos responde `403 fuera_de_alcance`. Si lo omites, el token usa todo lo que permita su rol.

La respuesta trae el token **una sola vez** (`ipam_` + 43 caracteres). Guárdalo en el gestor de secretos del pipeline. En la base solo queda su hash SHA-256.

## 3 · Flujo del agente: reservar → un admin aprueba → el agente ve «confirmada» (o libera)
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
  -d '{"pool":"dev-nodos","mascara":24,"vpc":"vpc-ejemplo-nuevo","ticket":"DEMO-9","ttl_horas":24,"estrategia":"mejor_ajuste"}' \
  "$IPAM_URL/api/v1/reservas"
```
También puedes indicar `ambiente` y `tipo` en vez de `pool` para que el IPAM elija el pool, o un `cidr` concreto.
- **Estrategias anti-fragmentación:** `"estrategia"` acepta `mejor_ajuste` (*best-fit*, recomendado para preservar bloques grandes contiguos), `primero` (comportamiento tradicional secuencial), `biseccion` o `inverso`.
Respuestas: `201` creada; `200` con `repetida: true` si la misma clave ya tiene reserva viva; `409` si el rango choca o la clave pertenece a una reserva liberada o expirada; `429` si superas la cuota.

**Consultar**
```bash
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/reservas?estado=reservada"
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/reservas/<id>"
```
**Confirmar es solo de un admin.** Un token de servicio no puede confirmar (`403`), aunque declare quién aprobó: la aprobación humana no depende de lo que el agente diga. El admin aprueba en la interfaz (pestaña Segmentos, vista «Reservados») o con una sesión de admin: `POST /api/v1/reservas/<id>/confirmar` con `aprobado_por` y `referencia` opcionales. El agente **espera** la aprobación consultando la reserva:
```bash
# estado: reservada (falta aprobación) → confirmada (aprobada) | liberada | expirada
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/reservas/<id>"
```
El pipeline debe avanzar solo cuando `estado` sea `confirmada`.
**Liberar** (si falla o se rechaza)
```bash
curl -s -X DELETE -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/reservas/<id>"
```
Si nadie confirma ni libera, la reserva **expira sola** (72 h por defecto, 168 h como máximo).

**Reservar los rangos de un clúster GKE (en grupo, todo o nada)**
Un proyecto con clúster necesita tres rangos: la **subnet** (el rango principal de la subred) y sus rangos secundarios de Pods y Servicios. Se piden juntos; si uno no cabe, no se reserva ninguno. Cada rango sale del pool que la tabla **ambiente + uso → pool** indica (`GET /api/v1/pool-uso`; un admin la define con `PUT /api/v1/pool-uso/{ambiente}/{uso}`). El tamaño de cada rango lo define el pool: sin `mascara` se usa `mascara_defecto` del pool, y si no tiene, `400 falta_tamano`; con `mascara` debe respetar `mascara_minima` y `mascara_maxima` del pool (`400 mascara_invalida`) y estar entre `/8` y `/29`. Un proyecto **sin** clúster usa la reserva suelta de más arriba.

- **Un pedido es un solo grupo** (una sola caducidad, `ttl_horas`), de 1 a 20 rangos: puede traer varias subredes (`subred` por rango) y varios rangos del mismo uso (p. ej. dos de pods), cada uno con un `nombre` opcional (el del rango secundario).
- **Nodos y Servicios son opcionales.** Con GKE 1.29 o superior, GKE gestiona el rango de Servicios: no lo pidas.
- **Agregar a una subred existente:** `"grupo": "<id>"` suma los rangos al grupo (mismo dueño y ambiente, grupo vigente), sin reservar la subnet.
- **Ambiente:** `dev`, `qa`, `lab`, `pre`, `prod`; `prd` se acepta como alias de `prod`.
- **Simulación con contexto:** `?simular=true` devuelve además `cuota` (`usada`, `limite`, `necesaria`, `alcanza`; solo para tokens), `pools` (direcciones libres de cada pool) y `version_tabla`. No gasta cuota. Si pasas ese `version_tabla` en la reserva real y la tabla ambiente + uso → pool cambió, `409 version_tabla_cambiada`. `GET /pool-uso` trae la misma versión en la cabecera `X-Version-Tabla`.
- **Renovar:** `POST /api/v1/reservas/grupo/{id}/renovar` con `{"ttl_horas": 72}` extiende la vigencia **sin cambiar los CIDR** (nunca la acorta). El acumulado desde la creación del grupo no pasa de 168 h (`400 ttl_excede_maximo`, con cuántas horas quedan). Un grupo expirado, liberado o confirmado responde `409 grupo_no_vigente`.
- **Una sola caducidad:** un rango agregado a un grupo caduca con el grupo.
- **Buscar grupos** (para recuperarse tras una caída sin guardar el id): `GET /api/v1/reservas/grupo?clave=<Idempotency-Key>` (los tuyos), `?ticket=`, `?estado=` y `?por_expirar_horas=N` (los reservados que vencen en N horas o menos: sirve para avisar sin webhook). Un token ve solo sus grupos.
- **`subnet` en vez de `nodos` (0.6.0).** El rango principal de una subred se llama **`subnet`**, también en la tabla `pool-uso` (`PUT /pool-uso/{ambiente}/subnet`). `nodos` se sigue aceptando como alias de entrada, pero IPAM responde siempre `subnet`. El esquema 19 convierte las filas existentes de `pool_uso`: **migra antes de desplegar**.
- **CIDR exacto, solo para pruebas.** Un rango puede traer `cidr` (por ejemplo `{"uso":"subnet","cidr":"172.31.140.0/25"}`) en vez de dejar que IPAM elija. Está **apagado por defecto** y un admin lo habilita por ambiente con `CIDR_MANUAL_AMBIENTES` (p. ej. `dev`); fuera de esos ambientes responde `400 cidr_manual_no_permitido`. IPAM sigue siendo quien decide: el CIDR debe estar alineado (`cidr_desalineado`), dentro del pool de su uso (`cidr_fuera_del_pool`) y libre (`409 solapamiento`, con `sugeridos`); si trae también `mascara`, deben coincidir (`mascara_no_coincide`). Sigue siendo todo o nada, y repetir el pedido con la misma `Idempotency-Key` devuelve el mismo grupo.
- **Idempotencia:** la misma `Idempotency-Key` con los mismos parámetros devuelve el mismo grupo; con otros parámetros, `409 idempotencia_conflicto`; de un grupo liberado o expirado, `409 clave_idem_usada`.
- **Un rango de un grupo no se confirma ni se libera suelto** (`409 reserva_de_grupo`): se opera con el grupo entero.
- **Permisos del token:** `reservas` y `consulta` (o sin alcance); `GET /pool-uso` es de `consulta`. La cuota (`cuota_reservas`, 20 por defecto) cuenta cada rango; los pedidos en paralelo de un mismo token se encolan. Límite de escritura: 30 por minuto.
```bash
# ¿Qué reservaría? (no reserva nada)
curl -s -H "Authorization: Bearer $IPAM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"ambiente":"dev","proyecto":"proy-pagos","subred":"gke-principal","rangos":[{"uso":"subnet","mascara":25},{"uso":"pods","mascara":24},{"uso":"servicios","mascara":24}]}' \
  "$IPAM_URL/api/v1/reservas/lote?simular=true"
# Reservar (igual, sin ?simular): 201 con el grupo y sus tres rangos
curl -s -H "Authorization: Bearer $IPAM_TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: mr-1234-gke" -d '{…el mismo cuerpo…}' "$IPAM_URL/api/v1/reservas/lote"
# Consultar el grupo y esperar a que un admin lo apruebe: estado reservada → confirmada
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/reservas/grupo/<grupo>"
# Liberar el grupo entero (si falla o se rechaza)
curl -s -X DELETE -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/reservas/grupo/<grupo>"
```
El grupo lo **confirma solo un admin** (`POST /api/v1/reservas/grupo/{id}/confirmar`): los tres rangos pasan juntos a asignación. La cuota del token cuenta cada rango como una reserva (un clúster consume 3). Errores nuevos: `422 uso_sin_pool` (falta configurar el pool de ese uso), `409 sin_espacio` (qué uso no cupo; no se reservó nada).

**El pool es la VPC (0.5.0).** El bloque de una VPC es un **pool hijo** del pool de ambiente del que sale, con su identidad `(proveedor, proyecto, vpc)`; sus subredes salen de ese bloque y IPAM garantiza que caben dentro.
- **Subnet por VPC.** Si el pedido trae `vpc` (y `proyecto`) y existe un pool con esa identidad, la **subnet** sale de ese pool; pods y servicios siguen saliendo de `pool-uso`. `?simular=true` dice, por rango, el `pool`, el `criterio` (`vpc`, `pool_uso` o `padre`) y el `motivo`. Un nombre se normaliza (minúsculas, bordes recortados) y debe ser un nombre de GCP (`vpc_invalido`, `proyecto_invalido`, `subred_invalido`).
- **VPC sin pool.** Por defecto la subnet sale del pool de ambiente + uso como antes. Un admin puede exigir el pool de la VPC por ambiente con `EXIGIR_POOL_VPC` (p. ej. `dev,qa` o `todos`): entonces una VPC sin pool responde `422 vpc_sin_pool` y un pedido sin `vpc`, `422 vpc_requerida`.
- **Reservar el bloque de una VPC nueva:** `{"ambiente":"dev","proyecto":"proy-x","vpc":"dev-vpc-x","rangos":[{"uso":"vpc","mascara":20}]}` (opcional `padre`: el pool del que sale; por defecto el de ambiente + subnet). Va solo en su pedido. **No crea el pool:** al confirmarlo un admin (`POST /reservas/grupo/{id}/confirmar`, que devuelve `pools_creados`) nace el pool hijo; si se libera o expira, no se crea nada. Después se piden las subredes con esa `vpc` y `proyecto`. El agente nunca crea ni edita pools (`POST/PATCH /pools` son solo admin).
- **Errores:** `422 vpc_incoherente` (la VPC ya figura en ese ambiente con otro proyecto), `422 vpc_ambigua` (varios pools con esa VPC: indica el proyecto), `409 vpc_duplicada` (la VPC ya es un pool o tiene un bloque esperando confirmación), `409 sin_espacio` (el mensaje nombra el pool de la VPC), y en los pools: `422 pool_fuera_del_padre`, `409 pool_solapado`, `409 pool_con_hijos`.
- **Seguimiento:** `GET /api/v1/reservas/grupo/{id}/eventos` devuelve el historial del grupo (reservado, renovado, confirmado, liberado, expirado) a su dueño o a un admin; `GET /eventos` sigue siendo solo de admin.
- **Tamaño por defecto.** El lote usa `mascara_defecto` del pool (del pool de la VPC o del de ambiente + uso). Los pools de `lab`, `qa`, `pre` y `prod` **no traen** ese valor en una instalación real: o el agente indica siempre `mascara`, o un admin lo define con `PATCH /api/v1/pools/{id}` (`{"tipo":"Nodos","proveedor":"GCP","mascara_defecto":24}`). Los pools de VPC que nacen de un bloque heredan del padre los límites de máscara que caben.

**Consultar asignaciones (con paginación por cursor para alta escala)**
```bash
# Primera página (hasta 50 elementos)
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/asignaciones?limite=50"
# Página siguiente mediante cursor recibido en la cabecera X-Next-Cursor o propiedad siguiente_cursor
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/asignaciones?limite=50&desde_id=1250"
```
Admite filtros por `pool`, `vpc`, `proyecto`, `solicitante`, `ticket` y búsqueda de texto `q`.

**Reconciliación de Cloud Drift (0.6.0)**
Permite al agente de redes enviar el inventario de subredes descubiertas en la nube (AWS / GCP / Azure) para auditar discrepancias contra la base de datos IPAM:
```bash
curl -s -X POST -H "Authorization: Bearer $IPAM_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "subredes_nube": [
      {"subred": "10.20.1.0/24", "vpc": "vpc-prod", "proyecto": "infra", "ambiente": "prod", "proveedor": "aws"},
      {"subred": "10.20.99.0/24", "vpc": "vpc-desconocida", "proyecto": "shadow", "ambiente": "dev", "proveedor": "aws"}
    ]
  }' \
  "$IPAM_URL/api/v1/reconciliacion"
```
Respuesta JSON:
- `resumen`: contadores `{ total_nube, sincronizados, desviaciones, huerfanos_nube, discrepancias_metadata }`.
- `detalles`: arreglo de hallazgos con estado (`sincronizado`, `desviacion`, `huerfano_nube`, `discrepancia_metadata`), subred, VPC, proyecto y mensaje explicativo.
Requiere alcance `consulta`.

**Direcciones IP fijas** (interfaces de router, switch, firewall…): el agente registra la IP y el IPAM la ubica sola en su segmento.
```bash
curl -s -H "Authorization: Bearer $IPAM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"ip":"10.220.16.1","dispositivo":"rtr-core-01","interfaz":"Gi0/1","rol":"gateway"}' \
  "$IPAM_URL/api/v1/direcciones"
# ¿Qué IP tiene cada interfaz de un equipo?
curl -s -H "Authorization: Bearer $IPAM_TOKEN" "$IPAM_URL/api/v1/direcciones?q=rtr-core-01"
```
Si la IP está fuera de todo segmento asignado, es una **excepción**: agrega `"excepcion":"motivo"`. Si cae en varios pools (rangos privados repetidos en distintos ambientes), la respuesta es `422 ip_ambigua` con `opciones`: repite con `"pool":"…"`. Roles: `rol` ∈ `interfaz`, `gateway`, `gestion`, `loopback`, `vip`, `servidor`, `otro`. Editar: `PATCH /api/v1/direcciones/{id}`; eliminar: solo admin.

**Pools (bloques base, solo admin)**: `POST /api/v1/pools` (`id`, `tipo`, `ambiente`, `proveedor`, `cidr` de /8 a /30), `PATCH /api/v1/pools/{id}` (tipo y proveedor) y `DELETE /api/v1/pools/{id}` (solo vacío). Un pool no puede solaparse con **ningún** otro, aunque sea de otro ambiente o proveedor: los rangos no se repiten entre `dev`, `qa`, `lab`, `pre` y `prod` (`409 pool_solapado`).

## 4 · Errores y límites
Los errores son JSON con `error`, `mensaje` y `request_id` (el mismo que viaja en los logs y la auditoría; pásalo al soporte). Códigos habituales: `400` validación, `401` sin credenciales, `403` rol insuficiente, `404`, `409` solapamiento o estado inválido, `429` límite o cuota (con `Retry-After`). El límite por minuto es configurable ([CONFIGURACION](CONFIGURACION.md)).

## 5 · Compatibilidad
Toda la API vive bajo `/api/v1`. Los alias antiguos sin versión (`/api/pools`, `/api/solicitudes`…) se retiraron: responden 404. Solo quedan fuera de `/api/v1` la salud (`/healthz`, `/readyz`, `/api/health`), la marca (`/api/config`), `/metrics` y el webhook de Jira. El contrato se valida contra las respuestas reales en las pruebas automáticas.

## 6 · Ejemplo de pipeline
Un pipeline completo (OpenTofu con aprobación manual y `confirmar-ipam` / `liberar-ipam`) está en [ops/gitlab](ops/gitlab/README.md). El contrato del YAML de entrada: [CONTRATO-YAML-REDES](CONTRATO-YAML-REDES.md).
