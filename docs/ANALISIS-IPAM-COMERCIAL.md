# Análisis de un IPAM comercial: qué copiar y qué no

> Base del análisis: una captura de pantalla de un IPAM que **parece NetBox** (menús «Direcciones IP», «Prefijos», «VRFs», «ASN», «Agregados», «RIR», «VLAN», «Grupos FHRP»…; columnas «Estado», «Inquilino», «Asignado», «Nombre DNS»). **No se probó el producto**: la lista sale solo de lo visible en la captura y de lo que se sabe de ese tipo de herramientas. Si es otro producto, hay que revisar las filas dudosas.

## Lo que ese producto hace y el IPAM propio ya cubre
| Función | En el IPAM propio |
|---|---|
| Prefijos (bloques de red) con utilización | Pools con barra de uso y **disponibilidad por máscara** |
| Búsqueda rápida y filtros | Filtro por ambiente y proveedor; buscador por ID, segmento, proyecto o ticket |
| Exportar | Excel y respaldo JSON |
| Inquilino (a quién pertenece) | Proyecto / VPC y solicitante |
| Roles y permisos | `lector`, `agente`, `solicitante`, `admin`; tokens de API |
| Registro de cambios | Auditoría de solo inserción, con `request_id` |
| Webhooks / integraciones | Eventos, webhook firmado, Jira en dos sentidos |
| API y token | OpenAPI 3.1 y tokens de servicio |

## Lo que conviene copiar (en este orden)
| # | Función | Por qué sirve | Esfuerzo |
|---|---|---|---|
| 1 | **Importación masiva (CSV/Excel) con simulación** (*dry run*) y reporte de conflictos | Resuelve el problema de hoy: hay segmentos en uso (on-premise y GCP) que no están registrados. La simulación muestra qué se importaría y qué choca, antes de escribir nada | Medio |
| 2 | **Descubrimiento de GCP (solo lectura)**: leer las subredes existentes con el inventario de GCP e importarlas | Evita teclear lo que ya existe en la nube. Debe ir como adaptador opcional o script aparte, sin acoplar el núcleo a Google | Medio |
| 3 | **Descripción libre y etiquetas** por asignación | Permite anotar el dueño, el centro de costo o «temporal» sin cambiar el modelo | Bajo |
| 4 | **Estado** de cada rango (Activo, Reservado, Deprecado) | Hoy solo hay «reservada» y «asignada»; «deprecado» sirve para rangos que ya no se usan pero no se devuelven | Bajo |
| 5 | **Historial por asignación** (qué se hizo con cada ID) | La auditoría ya existe; falta verla filtrada por ID | Bajo |
| 6 | **Mapa visual del pool** (qué bloques están ocupados y cuáles libres) | Hace evidente la fragmentación; complementa la tabla de disponibilidad | Medio |
| 7 | **Campos personalizados** | Útil si distintos equipos necesitan guardar datos propios | Medio |
| 8 | **VRF / espacios de direcciones separados** | Si on-premise y las nubes reutilizan los mismos rangos `10.x`, un único espacio de direcciones los marcaría como solapados. Decisión de fondo, ver abajo | Alto |
| 9 | **Columnas configurables y filtros guardados** | Comodidad | Bajo |

## Lo que no conviene copiar (por ahora)
| Función | Motivo |
|---|---|
| **Direcciones IP individuales** (la pantalla de la captura) | El IPAM propio gestiona **bloques** (subredes), no hosts. Llevar cada IP, su DNS y su asignación a un equipo es otro producto |
| **ASN, rangos de ASN, RIR y agregados** | Es gestión de numeración pública y BGP; no aplica a asignar subredes internas |
| **VLAN, grupos y reglas de traducción de VLAN, FHRP** | Es documentación de redes de datacenter, fuera del alcance (también lo es Fortinet) |
| **Plantillas de servicio y servicios de aplicaciones** | Inventario de aplicaciones: otra herramienta |
| **Objetivos de ruta** | Solo útil con VRF y MPLS |

## Decisión de fondo: ¿un solo espacio de direcciones o varios?
Hoy el IPAM asume **un único espacio**: dentro de un pool, dos segmentos no pueden solaparse. Pero las empresas reales suelen tener **solapamientos entre on-premise y nubes** (la misma `10.x` usada en dos sitios que no se hablan). Al importar, esos choques aparecerán. Hay tres caminos:
1. **Rechazar y corregir** los solapamientos (lo más sano si las redes se van a conectar).
2. **Registrarlos en pools separados** (un pool por sitio), que el modelo actual ya permite si los pools no se solapan entre sí.
3. **Agregar VRF/espacios** (fila 8): el solapamiento se permite entre espacios distintos. Es el cambio más grande.
La recomendación es empezar por el 1 y el 2, y decidir el 3 cuando se vea cuántos solapamientos hay de verdad.

## Cómo se importarían los segmentos en uso (propuesta)
1. **Definir los pools** (los bloques del plan de direccionamiento), p. ej. un pool por proveedor, ambiente y tipo.
2. **Cargar un CSV** con columnas `cidr`, `proyecto` (o nombre), `proveedor`, `ambiente`, `tipo`, `descripcion`, `ticket`. Un export de NetBox sirve como base (columnas de prefijo, estado, inquilino y descripción).
3. **Simular:** para cada fila el IPAM busca el pool que la contiene, y lista las que (a) no caben en ningún pool, (b) se solapan con otra, (c) no están alineadas. No escribe nada.
4. **Aplicar** solo lo válido, todo o nada por lote, con origen `importado` y auditoría.
5. Desde ahí la pestaña Pools y la **disponibilidad por máscara** muestran qué queda libre.
Esta propuesta **no está implementada**: faltan decisiones (ver el informe de la sesión).
