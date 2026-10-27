# Respaldo y recuperación

Hay tres capas; usa al menos la primera.

## 1 · Respaldos de la base (los del proveedor)
Cloud SQL, RDS y Azure Database traen respaldos automáticos y recuperación a un instante. **Actívalos y prueba restaurar** (un respaldo que nunca se restauró no es un respaldo). En el POC de Supabase, los respaldos dependen del plan: verifica en la página oficial qué incluye el tuyo.
Con el PostgreSQL incluido en el chart: respaldos incrementales con pgBackRest ([OPERACION](../OPERACION.md)).

## 2 · Respaldo lógico (portable entre infraestructuras)
Pools, asignaciones y roles asignados, en un JSON:
```bash
curl -s -u admin:"$CLAVE" "$IPAM_URL/api/v1/exportar.json" -o ipam-respaldo.json     # también: botón «Respaldo JSON»
```
Restaurar en otra instancia (todo o nada: si algún segmento se solapa, se rechaza completo; repetible sin duplicar):
```bash
curl -s -u admin:"$CLAVE" -H 'X-Requested-With: ipam' -H 'Content-Type: application/json' \
  --data @ipam-respaldo.json "$IPAM_URL/api/v1/importar"
```
No incluye tokens (se recrean), auditoría ni secretos. Trata el archivo como sensible.

## 3 · Dump nativo de PostgreSQL
```bash
pg_dump --format=custom --schema=ipam "$DATABASE_URL_MIGRACION" > ipam.dump
pg_restore --clean --if-exists --no-owner -d "<otra base>" ipam.dump
```
Después ejecuta `roles.sql` (o el de Supabase) y `npm run migrar` para reponer permisos.

## Qué recuperar primero
1. Base de datos (capa 1 o 3). 2. Migración (repone permisos). 3. Despliegue del servicio. 4. Tokens: los de los agentes se recrean si no se restauraron. 5. Reservas vigentes: expiran solas; revisa las que quedaron pendientes.

## Prueba de restauración (cada trimestre)
Restaura en una base vacía, arranca un IPAM de prueba apuntando a ella, comprueba `/readyz` y compara el número de asignaciones con el original.
