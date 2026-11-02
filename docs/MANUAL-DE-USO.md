# Manual de uso del IPAM

Referencia de cada pantalla. Si prefieres una guía paso a paso con imágenes, lee el [Manual de usuario](MANUAL-DE-USUARIO.md).

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
Es la pantalla de inicio. Arriba hay cinco números:
- **Pools:** cuántos rangos grandes existen.
- **Asignaciones activas:** cuántos segmentos están entregados.
- **Uso total:** direcciones **ocupadas** (asignadas + reservadas) de todos los pools ÷ direcciones totales. Está **ponderado por tamaño**: un `/12` pesa más que un `/28`. Con el filtro activo, es solo de los pools mostrados.
- **Pools sobre 80 %:** cuántos pools están casi llenos (se pinta en rojo si hay alguno).
- **Espacio libre (direcciones):** cuántas direcciones quedan en total. Debajo, una nota recuerda que los solapamientos no son un indicador: la base de datos los impide con una restricción de exclusión.

Debajo, una fila por pool: su **tipo** (Nodos, Pods, Servicios), **ambiente**, **proveedor** (p. ej. GCP), **CIDR base** (el rango grande), cuántas **asignaciones** y **reservas vigentes** tiene, y la **barra de uso**, que suma **asignado** (definitivo) y **reservado** (apartado, esperando aprobación). Es **verde** por debajo de 70 %, **ámbar** entre 70 % y 90 % y **roja** por encima de 90 % (con un ícono de alerta); el número es la suma. Es la misma cuenta que se ve en la ficha y al elegir un pool en un formulario. Con alertas configuradas ([OBSERVABILIDAD](ops/OBSERVABILIDAD.md)) avisan al pasar de 80 % y 90 %.

**Cómo se calcula el uso de un pool:** se suman las direcciones de cada segmento asignado o reservado (un `/24` son 256, incluidas la de red y la de difusión) y se dividen por las direcciones del pool. Ejemplo: un `/20` (4.096) con un `/24` asignado y un `/25` reservado → 256 + 128 = 384 → **9,4 %** (6,3 % asignado + 3,1 % reservado).

- **＋ Nuevo pool (bloque base)** (solo admin): nombre (minúsculas, números y guiones), tipo, ambiente, proveedor y CIDR (alineado, de `/8` a `/30`). No puede solaparse con otro pool del **mismo proveedor y ambiente**; en otro ambiente o proveedor el mismo rango sí se permite (p. ej. el mismo `10.40.0.0/16` en dev on-prem y en qa on-prem). Para **editar** el tipo o el proveedor, o **eliminar** un pool vacío (sin segmentos, reservas vigentes ni IPs), abre su ficha → «Editar o eliminar este pool». El CIDR y el ambiente no se editan: dejarían segmentos fuera de su pool.
- **Haz clic en el nombre de un pool** para abrir su **ficha** (ver más abajo).
- **Importar segmentos** (solo admin) abre la importación masiva (ver más abajo); **← Volver a Pools** regresa.
- **Exportar a Excel** baja una planilla con todo.

**Filtro por ambiente y proveedor:** arriba de la tabla hay dos listas, **Ambiente** (`dev`, `qa`, `pre`, `prod`) y **Proveedor** (p. ej. GCP). Al elegir una, los números y la tabla muestran solo esos pools. El filtro **se conserva** al pasar a Segmentos, que también queda acotada; **Limpiar filtro** lo quita.

### Ficha de detalle — «todo sobre un pool o un segmento»
Al hacer clic en un **pool** (pestaña Pools) o en el **ID** de una asignación (`ASG-000123`, pestaña Segmentos) se abre un panel a la derecha, como en NetBox. Se cierra con **Cerrar** o la tecla Esc.
- **Ficha de un pool:** *Detalle* (CIDR, primera y última dirección, direcciones y utilizables, libres, **bloque libre más grande**, uso asignado y reservado; el admin puede editarlo o eliminarlo), *Segmentos* (todo lo asignado y reservado dentro del pool, ordenado; un clic en un segmento abre su ficha), *Direcciones IP* (todas las IPs fijas del pool, incluidas las excepciones) e *Historial*.
- **Ficha de un segmento:** ID, CIDR, primera y última dirección, máscara, direcciones y utilizables, pool (con enlace a su ficha), ambiente, proveedor, proyecto/VPC, **VLAN**, ticket, origen, quién lo pidió y cuándo; *Direcciones IP* (las IPs fijas del segmento, cuántas de las utilizables están registradas y el formulario para agregar otra); *Historial*; y **Liberar segmento** (solo admin; no se puede si tiene IPs registradas).
- **Historial** (solo admin): quién asignó, reservó, aprobó o liberó ese pool o segmento, cuándo y con qué motivo. Sale de la bitácora de auditoría, que se sigue registrando aunque ya no tenga pestaña propia. Los segmentos importados o de la semilla muestran su origen y fecha en *Detalle*.

### Direcciones IP — «qué IP tiene cada interfaz»
IPs fijas de **interfaces de routers, switches y firewalls**, gateways, VIP/HSRP, gestión, loopbacks o servidores. Cada una lleva: **IP**, **dispositivo** (texto libre, p. ej. `rtr-core-01`), **interfaz** (`Gi0/1`, `xe-0/0/1.100`, `ethernet1/1`…), **rol**, **DNS** y **descripción**.
- **Registrar IP fija** (solicitante y admin; también los agentes por API): escribe la IP y el IPAM la **ubica sola en su segmento asignado**. Avisa si es la dirección de red o de difusión del segmento.
- **Excepciones:** si la IP está **fuera de todo segmento** (dentro de un pool o fuera de todo pool, como la IP pública de un firewall), hay que escribir el **motivo de la excepción**; se ve marcada como «Excepción» en las tablas.
- Si el mismo rango privado existe en varios pools (p. ej. dev y qa), elige el **pool** en el formulario.
- **Buscar** por IP, equipo, interfaz, DNS o descripción: escribe `rtr-core-01` y ves todas sus interfaces con su IP.
- **Editar** cambia los datos (no la IP: para eso se elimina y se registra otra). **Eliminar** es solo de admin.
- Una IP no se repite dentro de un pool. Un segmento con IPs registradas no se puede liberar, ni un pool con IPs eliminar.
- También están en la ficha de cada segmento y pool, en la hoja «Direcciones IP» del Excel y en el respaldo JSON. Por ahora el dispositivo es texto libre; más adelante puede haber un catálogo de equipos.

### Segmentos — «lo entregado y lo apartado, en una lista»
Una sola pestaña reúne las **asignaciones** (definitivas) y las **reservas** (apartadas, pendientes de aprobación). Cada fila dice su **estado con texto y color**: **Asignado** (azul), **Reservado** (ámbar, con cuenta regresiva y un código `RES-…`), y en *Historial*, **Liberada** y **Expirada**. Las reservas pendientes salen primero. Una reserva *confirmada* no se repite: ya es la asignación.
- **Botones por estado:** `Todos · Asignados · Reservados · Historial`. El número de *Reservados* es lo pendiente de aprobar.
- **Acciones por fila:** un *Reservado* muestra **Confirmar** (pasa a Asignado, con su ID `ASG-…`) y **Liberar**; un *Asignado* muestra **Liberar** (solo admin, con doble confirmación). El historial no se opera.
- **Formulario plegado arriba:** **Nuevo segmento**. Con **Es una reserva** marcada (por defecto) pide aprobación; solo un admin puede desmarcarla para **asignar de inmediato**. Se describe abajo.
- Ordenar por columna, buscar y filtrar por ambiente y proveedor funcionan sobre toda la lista; se pagina de 25 en 25.

**Lo asignado:** La lista oficial de segmentos definitivos: **ID** (`ASG-000123`, único por asignación: el mismo rango, si se libera y se vuelve a asignar, tendrá otro ID), **segmento**, **pool**, **proyecto/VPC**, **VLAN** (número y nombre, si se indicó), cuántas **direcciones** son, quién lo **solicitó**, el **origen** (`panel`, `jira`, `agente`, `semilla`, `importado`), el **ticket** y la **fecha**.
- **Asignar ahora** (solo admin, «Nuevo segmento» con la casilla desmarcada): ver abajo.
- **Buscar** por ID, segmento, proyecto, VLAN, ticket o quién lo pidió (cuadro «Buscar», junto al filtro).
- Un clic en el **ID** abre la **ficha** del segmento.
- **Exportar a Excel** para auditorías o reportes (incluye el ID y la VLAN).
- **Respaldo JSON** (solo admin): copia lógica completa para llevar el IPAM a otra infraestructura ([MIGRACION](ops/MIGRACION.md)).
- **Liberar** (solo admin): devuelve el segmento al pool. Pide el **motivo**, que queda en el historial junto con quién lo hizo, y luego una **segunda confirmación** en la que hay que escribir el CIDR exacto del segmento. Hazlo solo cuando la red realmente se eliminó. Es solo una protección de la interfaz: la API (agentes y pipelines) no la pide.

**Asignar ahora — «entrégalo ya, definitivo» (solo admin; «Nuevo segmento» con «Es una reserva» desmarcada).** El botón pasa a «Asignar ahora», la vigencia se oculta y se pide una segunda confirmación. Entrega un segmento **de inmediato y de forma definitiva**, **sin reserva y sin aprobación de otra persona**; queda en el historial a nombre del admin que lo hizo.
1. Elige el **pool**. **Ningún pool viene elegido** de antemano, y la **máscara** se habilita recién al elegirlo.
2. Escribe el **proyecto / VPC** (obligatorio).
3. Elige la **máscara**: la lista ofrece **solo los tamaños que caben en ese pool** (desde la máscara del pool hasta `/32`) y dice cuántos bloques libres quedan de cada uno («/24 · 15 libres»); los agotados aparecen como «sin espacio» y no se pueden elegir. O escribe un **CIDR manual** si necesitas un rango específico (debe caer dentro del pool).
4. Opcional: **VLAN** (número de 1 a 4094) y **nombre de la VLAN o subred**.
5. Pulsa **Asignar**.

Al elegir el pool aparece la **disponibilidad por máscara**: direcciones por bloque (totales y utilizables), **bloques libres** y direcciones libres; un clic en una fila elige esa máscara. En IPv4 un bloque `/30` o mayor pierde dos direcciones (red y difusión). Si el rango choca con otro, el IPAM **no asigna nada**: te muestra con quién choca y ofrece **segmentos libres** con un botón «Usar».

### Importar — «cargar los segmentos que ya existen» (solo admin, desde Pools)
Se abre con **Importar segmentos** en la pestaña Pools. Para partir con el inventario real (una planilla Excel o un CSV) en vez de escribir segmento por segmento. **Primero se simula y nada se escribe hasta que confirmas.**
1. Prepara el archivo (`.xlsx` o `.csv`, separado por coma, punto y coma o tabulador). Basta una columna **cidr**; las demás son opcionales: **proyecto/VPC**, **proveedor**, **ambiente**, **tipo**, **ticket**, **vlan**, **nombre vlan**, **descripción**. Se aceptan encabezados equivalentes (`prefijo`, `subred`, `red`, `project`, `nube`, `entorno`, `vlan id`…) y las columnas desconocidas se ignoran. Hay una plantilla en la misma vista (`plantilla-importacion.csv`). Máximo 5.000 filas por archivo.
2. Si el archivo no trae proveedor o ambiente, elígelos como **valor por defecto** (se aplican a las filas que no lo traen).
3. Pulsa **Simular importación**. Cada fila queda en uno de estos estados:
   - **Listo para importar**: entra en el pool más pequeño del mismo proveedor y ambiente que lo contiene; si no hay ninguno, el IPAM propone **crear un pool** automático (`imp-<proveedor>-<ambiente>-10`, `-172` o `-192` según la red privada).
   - **Ya registrado**: ese mismo segmento ya está en el mismo pool; se omite (importar dos veces el mismo archivo no duplica).
   - **Solapa con otro pool**: choca con un segmento de **otro** pool. No se importa salvo que marques **Aprobar** en esa fila.
   - **Choca dentro del mismo pool** e **Inválida** (CIDR mal escrito o desalineado, ambiente o VLAN inválidos…): no se pueden importar. Si el CIDR está desalineado, el detalle sugiere la red correcta.
4. Pulsa **Importar N segmentos**. Es **todo o nada**: si la base rechaza algo, no se importa ninguno. Los segmentos quedan con origen `importado` y la importación queda registrada.

**Reservar un segmento — «apartado, esperando aprobación».** Aquí entran las reservas tentativas que crean los agentes, Jira y las personas. Una reserva **aparta** un rango sin entregarlo todavía:
- **Nuevo segmento con «Es una reserva» marcada** (formulario plegado arriba, para solicitante y admin; el solicitante no ve la casilla): eliges pool (ninguno viene elegido), proyecto/VPC, máscara (solo las que caben) o CIDR, VLAN opcional, ticket opcional y vigencia (hasta 72 h). Al confirmarla, la VLAN pasa a la asignación. **Un admin debe aprobarla** (Confirmar) para que sea asignación.
- **Estados:** *Reservado* (vigente, con **cuenta regresiva**), *Asignado* (confirmada: ya es asignación), *Liberada* (se devolvió) y *Expirada* (nadie la aprobó a tiempo; las dos últimas están en *Historial*).
- Por defecto expira a las **24 horas** (máximo 72); si nadie hace nada, el rango vuelve solo al pool.
- Puedes **confirmar** o **liberar** las tuyas (el admin, las de todos). Las reservas que llegan desde **Jira** (solicitante `jira-webhook`) solo las puede aprobar un **admin**: confirmar equivale a dar la **aprobación manual** para asignar el CIDR. Un agente debe indicar **quién aprobó** y **dónde consta** (un MR, un ticket): así queda registro de la aprobación humana.
- Para ver solo lo pendiente, usa el botón **Reservados**; para encontrar las de un agente, escribe su nombre en **Buscar** (por ejemplo `svc:agente-redes`).

### Jira — «integración con tickets»
Explica y permite probar la conexión con Jira en los dos sentidos: el IPAM puede **crear un ticket** cuando asigna, y un ticket de Jira puede **pedir un segmento** por webhook. **Un ticket nunca asigna directo:** el IPAM crea una **reserva** (24 h) y un **admin debe aprobarla** en la pestaña Segmentos (botón Confirmar); recién ahí nace la asignación y se actualiza el ticket. Si nadie aprueba, la reserva expira sola y el rango vuelve al pool. Con la integración desactivada (lo normal en el POC) el número de ticket lo genera el IPAM (`NET-xxx`). **Simular ticket entrante** sirve para demostrar el flujo sin Jira real. El **registro de eventos** muestra lo que pasó.

### Tokens — «credenciales para agentes» (solo admin)
Aquí se crean las llaves que usan los pipelines y agentes:
1. **Crear token:** nombre (minúsculas, números y guiones), rol (`agente` o `lector`), vencimiento en días y, opcional, un tope de reservas vigentes.
2. El token **se muestra una sola vez**. Cópialo y guárdalo en el gestor de secretos del pipeline. El IPAM solo guarda su huella (hash): si lo pierdes, **crea otro y revoca el anterior**.
3. **Revocar** deja el token inservible al instante.
Buenas prácticas: un token por agente, con vencimiento corto y la cuota más baja que sirva.

### Usuarios — «quién entra y con qué rol» (solo admin)
Hay dos formas de manejar cuentas; el IPAM usa la que corresponda a cómo está configurado el acceso:
- **Con SSO (camino A, uso real):** las personas entran con tu proveedor de identidad y las cuentas viven allá. Aquí el admin puede:
  - **Pre-registrar** a alguien por correo con su rol, antes de que entre.
  - Cambiar su **rol** (o dejarlo en «Heredar», que usa los grupos del proveedor).
  - **Desactivar** (da de baja: no puede iniciar sesión, pero se conserva su historial), **Activar** de nuevo o **Eliminar**.
- **Con cuentas locales (camino B, pruebas y POC; requiere `AUTH_LOCAL=true` en modo usuario y contraseña):** el IPAM guarda la contraseña (solo su huella).
  1. **Nueva cuenta local:** usuario, nombre y rol. El IPAM muestra una **clave temporal una sola vez**: cópiala y entrégala por un canal seguro.
  2. La persona entra con esa clave; el sistema **le exige cambiarla** (mínimo 12 caracteres) antes de dejarla hacer otra cosa. Después, en «Mi contraseña» puede cambiarla cuando quiera.
  3. El admin puede **Restablecer clave** (genera otra temporal), **Desactivar** (rige al instante) o **Eliminar**.
  4. El **administrador de emergencia** (las variables `APP_USER` y `APP_PASS`) siempre puede entrar, así nadie queda fuera.

Nadie puede desactivarse ni eliminarse a sí mismo. Todo queda registrado en la bitácora de auditoría (nunca las claves).

**¿Y la pestaña Auditoría?** Se quitó de la barra: el historial de cada pool y segmento se ve en su **ficha**. La bitácora completa se sigue registrando (es de solo inserción) y un admin la puede consultar por la API (`GET /api/v1/auditoria`, con filtros `pool` y `cidr`) para investigar un incidente; el `request_id` enlaza con los logs.

> **Novedades de la interfaz:** las confirmaciones ahora son un cuadro propio (Esc cancela, Enter acepta) y los avisos aparecen arriba a la derecha; en «Asignar ahora» el segmento se valida mientras escribes; en la ficha de un pool, la pestaña Detalle muestra el mapa de bloques (asignado / reservado / libre); y las barras de uso pasan a ámbar desde 70 % y a rojo por encima de 90 %.

## 4 · Tareas comunes
**Dar un rango a un proyecto nuevo (flujo automático, el recomendado)**
1. El agente reserva los rangos desde el pipeline.
2. Una persona revisa el plan del pipeline y lo aprueba.
3. El pipeline aplica los cambios y **confirma** la reserva: ahora es una asignación.
4. Si algo falla o se rechaza, el pipeline **libera**; si nadie hace nada, **expira sola**.
Detalle técnico en [API-Y-AGENTES](API-Y-AGENTES.md) y [ARQUITECTURA](ARQUITECTURA.md).

- **Pedir un rango:** Segmentos → Nuevo segmento (reserva); un admin la aprueba.
- **Entregar un rango ya (admin):** Segmentos → Nuevo segmento, desmarca «Es una reserva».
- **Saber cuánto queda en un pool:** pestaña Pools, barra de uso; o clic en el pool → ficha (bloque libre más grande).
- **Ver quién tocó un segmento (admin):** clic en su ID → ficha → Historial.
- **Cargar el inventario existente (admin):** Pools → Importar segmentos.
- **Crear un bloque base nuevo (admin):** Pools → Nuevo pool.
- **Registrar la IP de una interfaz:** ficha del segmento → Direcciones IP, o la pestaña Direcciones IP.
- **Probar la API:** enlace «API» arriba a la derecha (`/api.html`).
- **Devolver un rango:** Segmentos → Liberar (admin).
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
