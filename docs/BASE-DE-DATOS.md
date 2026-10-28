# Base de datos: índices y planes de ejecución

Revisión del rendimiento de PostgreSQL con **volumen sintético** y los planes reales (`EXPLAIN (ANALYZE, BUFFERS)`) de las consultas de la aplicación. Sirve para saber qué se midió, qué se cambió y qué se dejó a propósito.

## Cómo se midió
- PostgreSQL 16 en local, esquema de `mvp/db/schema.sql` y cargas generadas con `generate_series` (sin disparadores, solo para volumen):

| Tabla | Filas |
|---|---|
| `pools` | 60 |
| `asignaciones` | 99.960 |
| `direcciones_ip` | 99.960 |
| `reservas` | 30.000 (50 vigentes por pool) |
| `auditoria` | 1.000.000 |
| `eventos` | 500.000 |

  Es 20–100 veces lo que tendrá una instalación real en sus primeros años: el objetivo es ver **cómo escala**, no el tamaño de hoy.
- Se extrajo el SQL de `repositorio.js` y se midieron 18 consultas (solapamiento, búsqueda por IP, espacio libre, lista de asignaciones, IPs, historial, barredor, métricas…). Cada una se ejecutó dos veces y se tomó la segunda (caché caliente).

## Lo que ya estaba bien
La garantía central de no solapamiento (`EXCLUDE USING gist (pool_id WITH =, cidr inet_ops WITH &&)`) **también es el índice** que resuelve las consultas más frecuentes, sin índices extra:

| Consulta | Plan | Tiempo |
|---|---|---|
| ¿Choca este CIDR con algo del pool? (al asignar o reservar) | Index Scan `sin_solapamiento` | ≈ 1 ms |
| ¿Quién tiene esta IP? (`cidr >>= ip`, sin pool) | Index Scan `sin_solapamiento` | 0,3 ms |
| Segmentos de un pool para calcular lo libre | Index Only Scan | 1,6 ms |
| ¿Existe ese segmento? | Index Scan | 0,2 ms |
| Lista de asignaciones, página 1 (orden por fecha) | Index Scan Backward `asignaciones_pkey` | 0,06 ms |
| Reservas vigentes por solicitante, barredor | Bitmap sobre `reservas_estado_expira_idx` | < 0,5 ms |
| Últimos 200 de auditoría / 50 eventos / purga por fecha | pkey hacia atrás / `eventos_ts_idx` | < 0,2 ms |

No faltan claves foráneas sin índice (se verificó contra `pg_constraint`).

## Lo que se agregó (5 índices)
Todos con `create index if not exists`, **idempotentes y opcionales**: no cambian la versión del esquema ni el comportamiento, solo la velocidad. Se aplican con `npm run migrar`.

| Índice | Para qué consulta | Antes → después |
|---|---|---|
| `auditoria_pool_idx` `((coalesce(detalle->>'pool', detalle->>'pool_id')), id desc)` | Historial de la ficha de un pool | 82–328 ms → **0,07–0,5 ms** |
| `auditoria_cidr_idx` `((detalle->>'cidr'), id desc)` | Historial de la ficha de un segmento | 82 ms → **0,5 ms** |
| `reservas_asignacion_idx` (parcial, `asignacion_id` no nulo) | Clave foránea: al borrar una asignación se recorrían todas las reservas | 6,3 ms → **0,01 ms** |
| `asignaciones_pool_id_idx` `(pool_id, id desc)` | Lista de Asignaciones filtrada por pool | 12,8 ms → **0,16 ms** |
| `direcciones_ip_pool_ip` `(pool_id, ip)` | IPs de un pool; clave foránea `pool_id` | 13,8 ms → **1,2 ms** |

**Por qué importa la auditoría:** es de solo inserción (no se purga), así que crece sin tope, y sus filtros salen de un campo `jsonb`. Sin índice, el historial de un pool *sin movimientos* recorría el millón de filas hacia atrás (≈ 330–600 ms) y el tiempo crece lineal con los años de uso. Con el índice es constante.

**Costo:** a 1.000.000 de filas de auditoría los dos índices nuevos ocupan 30 MB y 39 MB (la tabla, 150 MB) y encarecen un poco cada inserción. A una carga realista (decenas de miles de filas al año) son unos pocos MB.

**Requisito para que sirvan:** las expresiones de los índices de auditoría deben ser **idénticas** a las de `listarAuditoria`. La prueba `src/indices.test.js` toma el SQL que ejecuta el repositorio y exige que su plan use cada índice (con los recorridos secuenciales desactivados): si alguien cambia la consulta y el índice deja de servirle, la prueba falla.

**Al aplicarlos en una base grande:** `CREATE INDEX` toma un bloqueo que impide *escribir* en esa tabla mientras se construye (segundos con 1.000.000 de filas; las lecturas no se bloquean). Hazlo en una ventana tranquila. No se usa `CONCURRENTLY` porque el esquema se aplica dentro de una transacción.

## Lo que se midió y se dejó a propósito

| Consulta | Tiempo con 100.000 filas | Por qué no se tocó |
|---|---|---|
| Búsqueda de texto en Asignaciones (`ilike` sobre 5 columnas) | ≈ 260 ms | Con los volúmenes reales (miles) son unos pocos ms. Un índice de trigramas necesita la extensión `pg_trgm` (otra dependencia de despliegue) y 5 índices grandes. Si una instalación llega a decenas de miles de segmentos, es el primer candidato. |
| Búsqueda de texto en Direcciones IP | ≈ 100 ms | Igual que la anterior. |
| Cálculo de uso por pool para `/metrics` | ≈ 65 ms por lectura | Suma el tamaño de todos los segmentos cada vez que Prometheus consulta (cada 15–60 s). Si molesta: columna de contadores por pool o intervalo mayor. |
| Último número de ticket al arrancar | ≈ 60 ms | Solo ocurre al iniciar el proceso. |
| `auditoria_ts_idx` (ya existente) | — | La aplicación no lo usa (ordena por `id`), pero sirve para investigar un incidente por fecha con SQL directo; cuesta 21 MB por millón de filas. Se conserva. |

## Cómo repetir la medición
1. Crea una base vacía, aplica `mvp/db/schema.sql` y carga volumen con `generate_series` (ver los números de arriba).
2. `vacuum analyze;`
3. Para cada consulta de `mvp/src/adaptadores/persistencia/postgres/repositorio.js`: `explain (analyze, buffers) <consulta>;` con valores reales.
4. Busca `Seq Scan` sobre tablas grandes y filas descartadas por filtro (`Rows Removed by Filter`): son las señales de un índice que falta.

En producción, `pg_stat_statements` (consultas más lentas) y `pg_stat_user_indexes` (índices que nunca se usan: `idx_scan = 0`) dicen qué revisar con datos reales.
