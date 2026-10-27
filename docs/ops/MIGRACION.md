# Migración: del POC al hosting definitivo, y entre infraestructuras

El IPAM está diseñado para **cambiar de hosting sin reescribir nada**: cambian la imagen publicada, `DATABASE_URL` y las variables.

## Del POC (Render + Supabase) al hosting definitivo
1. **Prepara el destino:** PostgreSQL 14–17, roles con `mvp/db/roles.sql`, contraseñas fijadas aparte.
2. **Respalda el POC:** el JSON lógico ([RESPALDO-Y-RECUPERACION](RESPALDO-Y-RECUPERACION.md)) y, si quieres todo, `pg_dump`.
3. **Migra el esquema** en el destino (`npm run migrar`).
4. **Despliega** la misma imagen con las variables nuevas ([DESPLIEGUE](DESPLIEGUE.md)): OIDC en vez de Basic, `PUBLIC_URL` real.
5. **Importa** el JSON (`POST /api/v1/importar`) o restaura el dump.
6. **Tokens:** crea los de los agentes en el destino y actualiza los secretos de los pipelines.
7. **Cambia el DNS** o la URL que usan los pipelines; verifica con `/readyz`.
8. **Apaga el POC** cuando todo funcione.

## Cargar pools nuevos o datos iniciales
Los **pools** se cargan con SQL (por ejemplo, adaptando `mvp/db/seed-poc.sql`, cuyos rangos son **ficticios**). Para rangos reales, usa los del plan de direccionamiento del cliente y revisa que no se solapen entre pools.

## Entre nubes
Mismo procedimiento: lo único específico de cada nube es dónde corre la imagen, qué base PostgreSQL usas y dónde viven los secretos. La guardia `make portabilidad` asegura que el código no dependa de ninguna ([PORTABILIDAD](../PORTABILIDAD.md)).

## Del repositorio de GitHub a GitLab
[MIGRAR-A-GITLAB](MIGRAR-A-GITLAB.md).
