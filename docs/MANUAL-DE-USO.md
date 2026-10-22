# Manual de uso del IPAM

Para quien usa el IPAM día a día. Si buscas cómo instalarlo, ve a [DESPLIEGUE](ops/DESPLIEGUE.md); si eres un agente o un pipeline, ve a [API-Y-AGENTES](API-Y-AGENTES.md). Los términos técnicos están en el [GLOSARIO](GLOSARIO.md).
> Los rangos de los ejemplos son **ficticios** (`10.210/220/230/240.0.0/16`).

## 1 · Para qué sirve (en 30 segundos)
Un **IPAM** (*IP Address Management*, gestión de direcciones IP) es el libro oficial de quién usa qué rango de IP. Su trabajo principal es **impedir que dos redes reciban rangos que se pisan**; si eso ocurre, las redes no se pueden conectar entre sí más adelante y arreglarlo es caro.
En este IPAM:
- Hay **pools**: rangos grandes ya definidos por ambiente (`dev`, `qa`, `pre`, `prod`) y tipo (**Nodos**, **Pods**, **Servicios**).
- Cada proyecto recibe **asignaciones**: pedazos de un pool (por ejemplo un `/22`) que nadie más puede tomar.
- Los agentes automáticos (pipelines) no asignan directo: **reservan** un rango por un tiempo limitado y **una persona aprueba** antes de que se vuelva definitivo (*human-in-the-loop*, «humano en el circuito»).

### Pool, asignación y reserva (la diferencia)
| | Pool | Asignación | Reserva |
|---|---|---|---|
| Qué es | El **bloque grande** de un ambiente y tipo (p. ej. `dev-nodos` = `10.210.0.0/20`) | Un **pedazo** del pool entregado de forma definitiva a un proyecto (p. ej. `10.210.1.0/24`) | Un pedazo **apartado por un tiempo**, pendiente de aprobación |
| Analogía | El terreno ya loteado | El lote entregado | El lote con una nota de «apartado» |
Los tres se escriben como CIDR, por eso se parecen. «Pool» es el término habitual en IPAM: una reserva común de la que se van sacando rangos.

## 2 · Entrar
Abre la URL del IPAM. Según cómo esté configurado verás:
- **Usuario y contraseña** (modo POC): el navegador pide credenciales.
- **Inicio de sesión corporativo** (OIDC/SSO): te lleva a tu proveedor de identidad y vuelves con tu rol.

Tu **rol** decide qué pestañas ves:

| Rol | Qué puede hacer |
|---|---|
| `lector` | Ver pools, asignaciones y reservas. Exportar a Excel. |
| `solicitante` | Lo anterior, más **crear reservas** (un admin las aprueba). |
| `admin` | Todo: **aprobar reservas**, asignar directo, liberar asignaciones, administrar tokens, usuarios, auditoría y respaldos. |

Los **agentes** (tokens de servicio) tienen rol `lector` o `agente` y no usan la interfaz: ver [API-Y-AGENTES](API-Y-AGENTES.md).

## 3 · Las pestañas, una por una

### Pools — «¿cómo está todo?»
Es la pantalla de inicio. Arriba hay cuatro números:
- **Pools:** cuántos rangos grandes existen.
- **Asignaciones activas:** cuántos segmentos están entregados.
- **Uso promedio:** qué parte de los pools está ocupada, en promedio.
- **Solapamientos:** siempre debe ser **0**; la base de datos los impide, así que el número está para tu tranquilidad.

Debajo, una fila por pool: su **tipo** (Nodos, Pods, Servicios), **ambiente**, **proveedor** (p. ej. GCP), **CIDR base** (el rango grande), cuántas asignaciones tiene y una **barra de uso**. Úsala para detectar pools que se llenan; con alertas configuradas ([OBSERVABILIDAD](ops/OBSERVABILIDAD.md)) avisan al pasar de 80 % y 90 %.
**Exportar a Excel** baja una planilla con todo.

**Filtro por ambiente y proveedor:** arriba de la tabla hay dos listas, **Ambiente** (`dev`, `qa`, `pre`, `prod`) y **Proveedor** (p. ej. GCP). Al elegir una, los números y la tabla muestran solo esos pools. El filtro **se conserva** al pasar a Asignaciones y Reservas, que también quedan acotadas; **Limpiar filtro** lo quita.

### Asignaciones — «lo ya entregado»
La lista oficial de segmentos definitivos: **ID** (`ASG-000123`, único por asignación: el mismo rango, si se libera y se vuelve a asignar, tendrá otro ID), **segmento**, **pool**, **proyecto/VPC**, cuántas **direcciones** son, quién lo **solicitó**, el **origen** (`panel`, `jira`, `agente`, `semilla`), el **ticket** y la **fecha**.
- **Buscar** por ID, segmento, proyecto, ticket o quién lo pidió (cuadro «Buscar», junto al filtro).
- **Exportar a Excel** para auditorías o reportes (incluye el ID).
- **Respaldo JSON** (solo admin): copia lógica completa para llevar el IPAM a otra infraestructura ([MIGRACION](ops/MIGRACION.md)).
- **Liberar** (solo admin): devuelve el segmento al pool. Pide el **motivo**, que queda en la auditoría junto con quién lo hizo. Hazlo solo cuando la red realmente se eliminó.

### Asignar directo — «entrégalo ya, definitivo» (solo admin)
Formulario para entregar un segmento **de inmediato y de forma definitiva**, **sin reserva y sin aprobación de otra persona**. Queda en la auditoría a nombre del admin que lo hizo.
1. Elige el **pool** (el bloque base del ambiente y tipo correctos).
2. Escribe el **proyecto / VPC** (obligatorio).
3. Deja **CIDR manual** vacío para que el IPAM entregue el primer segmento libre del tamaño que elijas en **Máscara**, de `/8` a `/32` (`/22` = 1.024 direcciones, `/24` = 256, `/26` = 64, `/28` = 16…). Si necesitas un rango específico, escríbelo; debe caer dentro del pool.
4. Pulsa **Asignar**.

Si el rango choca con otro, el IPAM **no asigna nada**: te muestra con quién choca y ofrece **segmentos libres** con un botón «Usar».
Para el flujo normal (pedir, aprobar, asignar) usa **Reservas → Nueva reserva**.

### Reservas — «apartado, esperando aprobación»
Aquí viven las reservas tentativas que crean los agentes, Jira y las personas. Una reserva **aparta** un rango sin entregarlo todavía:
- **Nueva reserva** (botón arriba, para solicitante y admin): eliges bloque base, proyecto/VPC, máscara o CIDR, ticket opcional y vigencia (hasta 72 h). **Un admin debe aprobarla** (Confirmar) para que sea asignación.
- **Estados:** `reservada` (vigente, con **cuenta regresiva**), `confirmada` (ya es asignación), `liberada` (se devolvió) y `expirada` (nadie la aprobó a tiempo).
- Por defecto expira a las **24 horas** (máximo 72); si nadie hace nada, el rango vuelve solo al pool.
- Puedes **confirmar** o **liberar** las tuyas (el admin, las de todos). Las reservas que llegan desde **Jira** (solicitante `jira-webhook`) solo las puede aprobar un **admin**: confirmar equivale a dar la **aprobación manual** para asignar el CIDR. Un agente debe indicar **quién aprobó** y **dónde consta** (un MR, un ticket): así queda registro de la aprobación humana.
- Los filtros muestran por estado, pool o solicitante.

### Jira — «integración con tickets»
Explica y permite probar la conexión con Jira en los dos sentidos: el IPAM puede **crear un ticket** cuando asigna, y un ticket de Jira puede **pedir un segmento** por webhook. **Un ticket nunca asigna directo:** el IPAM crea una **reserva** (24 h) y un **admin debe aprobarla** en la pestaña Reservas (botón Confirmar); recién ahí nace la asignación y se actualiza el ticket. Si nadie aprueba, la reserva expira sola y el rango vuelve al pool. Con la integración desactivada (lo normal en el POC) el número de ticket lo genera el IPAM (`NET-xxx`). **Simular ticket entrante** sirve para demostrar el flujo sin Jira real. El **registro de eventos** muestra lo que pasó.

### Tokens — «credenciales para agentes» (solo admin)
Aquí se crean las llaves que usan los pipelines y agentes:
1. **Crear token:** nombre (minúsculas, números y guiones), rol (`agente` o `lector`), vencimiento en días y, opcional, un tope de reservas vigentes.
2. El token **se muestra una sola vez**. Cópialo y guárdalo en el gestor de secretos del pipeline. El IPAM solo guarda su huella (hash): si lo pierdes, **crea otro y revoca el anterior**.
3. **Revocar** deja el token inservible al instante.
Buenas prácticas: un token por agente, con vencimiento corto y la cuota más baja que sirva.

### Usuarios — «quién entra y con qué rol» (solo admin, con SSO)
Lista a quienes ya iniciaron sesión. Puedes fijar su rol (`lector`, `solicitante`, `admin`) o dejarlo en **Heredar** (lo decide el grupo del proveedor de identidad). El cambio rige desde su próximo inicio de sesión. No aparece en modo usuario y contraseña.

### Auditoría — «quién hizo qué» (solo admin)
Bitácora de **solo lectura**: fecha, usuario, rol, acción y detalle de cada cambio (asignar, liberar, confirmar, crear o revocar tokens…). Nadie puede modificarla ni borrarla, ni siquiera la aplicación. Para investigar un incidente, busca por fecha y usuario; el identificador de petición (`request_id`) enlaza con los logs.

## 4 · Tareas comunes
**Dar un rango a un proyecto nuevo (flujo automático, el recomendado)**
1. El agente reserva los rangos desde el pipeline.
2. Una persona revisa el plan del pipeline y lo aprueba.
3. El pipeline aplica los cambios y **confirma** la reserva: ahora es una asignación.
4. Si algo falla o se rechaza, el pipeline **libera**; si nadie hace nada, **expira sola**.
Detalle técnico en [API-Y-AGENTES](API-Y-AGENTES.md) y [ARQUITECTURA](ARQUITECTURA.md).

- **Pedir un rango:** Reservas → Nueva reserva; un admin la aprueba.
- **Entregar un rango ya (admin):** pestaña Asignar directo.
- **Saber cuánto queda en un pool:** pestaña Pools, barra de uso.
- **Devolver un rango:** Asignaciones → Liberar (admin).
- **Entregar un informe:** Exportar a Excel.
- **Crear una llave para un pipeline:** pestaña Tokens.

## 5 · Qué hacer cuando algo no funciona

| Veo… | Significa | Qué hacer |
|---|---|---|
| «Solapamiento detectado» | El rango pedido choca con otro | Usa uno de los sugeridos |
| «fuera del pool» | El CIDR no cae dentro del pool elegido | Revisa pool y rango, o deja el CIDR vacío |
| 401 / pide credenciales | Sin sesión, o token inválido o vencido | Entra de nuevo; si es un agente, crea otro token |
| 403 | Tu rol no alcanza | Pide el rol al admin |
| 409 en una reserva | Ya fue liberada o expiró | Crea una reserva nueva |
| 429 | Demasiadas peticiones o cuota de reservas | Espera un minuto o libera reservas que no uses |
| La primera carga tarda más de un minuto | El POC gratuito estaba dormido | Espera y recarga ([POC-RENDER-SUPABASE](ops/POC-RENDER-SUPABASE.md)) |

Más en el [RUNBOOK](ops/RUNBOOK.md).

## 6 · Lo que el IPAM no hace
No crea las redes en la nube, no conoce el on-premise ni Fortinet, y no verifica por sí mismo quién aprobó (la garantía es el ambiente protegido del pipeline). Ver [LIMITACIONES](LIMITACIONES.md).
