# ADR 0005 · Límite de peticiones y cuota por token

- **Estado:** aceptada · **Fecha:** 2026-10-21

## Contexto
Un token filtrado, un agente con un bucle roto o un intento de fuerza bruta pueden saturar el IPAM o llenarlo de reservas. Además el servicio corre con **varias réplicas**:
un contador en la memoria de cada proceso daría límites distintos según la réplica a la que caiga cada petición.

## Decisión
**1. Límites por actor y por IP, con ventana deslizante** (configurables por variable y por Helm):

| Qué | Variable | Por defecto |
|---|---|---|
| Lecturas por minuto y actor (token o usuario) | `RATE_LIMIT_POR_MINUTO` | 120 |
| Escrituras por minuto y actor | `RATE_LIMIT_ESCRITURA_POR_MINUTO` | 30 |
| Peticiones por minuto y dirección IP | `RATE_LIMIT_IP_POR_MINUTO` | 600 |
| Intentos de autenticación fallidos por minuto y IP (fuerza bruta) | `RATE_LIMIT_AUTH_FALLOS_POR_MINUTO` | 10 |
| Reservas vigentes simultáneas por token | `CUOTA_RESERVAS_POR_TOKEN` (o `cuota_reservas` al crear el token) | 20 |

Al exceder: **429** con `Retry-After` y un mensaje en español; se informan `RateLimit-Limit/Remaining/Reset`. Los excesos repetidos (5 en un minuto) se **auditan** una vez por minuto y actor.
Los intentos fallidos de autenticación bloquean a la **IP** (incluso con un token bueno) durante un rato. Las sondas (`/healthz`, `/readyz`, `/metrics`) no cuentan.

**2. Puerto `AlmacenLimite`** (`incrementar`, `consultar`, `devolver`) con dos adaptadores:
- **PostgreSQL (por defecto):** tabla `limite_contador` (UNLOGGED: no escribe en el registro de transacciones; si la base se reinicia se pierden contadores de un minuto, sin daño). Usa el reloj de la base y una sola
  sentencia atómica, así que dos réplicas suman en el mismo contador y **no hay carreras** (probado: 100 incrementos simultáneos desde dos réplicas suman exactamente 100).
- **Memoria:** solo para pruebas.

**3. Ventana deslizante «por contador»:** se cuentan las peticiones del minuto actual y del anterior; el anterior pesa según lo que falta del minuto. Aproxima una ventana móvil sin guardar cada petición.
Una petición rechazada **no consume cupo** (se devuelve), para que quien respeta `Retry-After` no quede castigado por haber insistido.

**4. Si el almacén falla, la petición pasa** (con un aviso en el log): el límite es una protección, no un requisito de corrección; si la base está caída, todo lo demás falla igual.

**5. Cuota por token:** se cuenta con las reservas `reservada` vigentes del solicitante, dentro de la misma transacción que crea la reserva y bajo el mismo bloqueo del solicitante (no se puede esquivar con peticiones simultáneas).
Una repetición idempotente no gasta cuota. Al excederla: 429 `cuota_excedida` con cuántas tiene vigentes.

## Alternativas
- **Redis (opción futura, no implementada):** más rápido que PostgreSQL para tráfico alto. Bastaría un tercer adaptador del puerto `AlmacenLimite` (`INCR` + `EXPIRE` por clave y minuto, y `DECR` para devolver). Hoy agregaría una pieza más que operar sin necesidad: la carga esperada del IPAM es baja.
- **Límite en el balanceador/API gateway:** complementa, pero no conoce al actor (token) ni la cuota de reservas, y cambia con cada nube.
- **Contador en memoria:** inconsistente con varias réplicas. Descartado salvo en pruebas.

## Consecuencias
- (+) Mismo comportamiento con 1 o N réplicas; sin dependencias nuevas.
- (−) Cada petición de la API hace una escritura pequeña en PostgreSQL. Aceptable a esta escala; si crece, pasar a Redis (ver arriba).
- (−) Usuarios detrás de un mismo NAT comparten el límite por IP: subir `RATE_LIMIT_IP_POR_MINUTO` si hace falta. El modo abierto (`anonimo`) comparte un único cupo de actor.
