# POC en Render + Supabase

El hosting definitivo lo define Rodrigo. Este POC solo demuestra el IPAM con costo mínimo: **un servicio web en Render** (imagen Docker) y **una base PostgreSQL en Supabase**. Nada del código depende de ellos (ver [PORTABILIDAD](../PORTABILIDAD.md) y [ADR 0007](../adr/0007-poc-render-supabase.md)).
> Los límites y condiciones de los planes gratuitos **no están aquí a propósito**: cambian. Verifícalos en las páginas oficiales de precios de Render y de Supabase antes de depender de ellos.

## Estado de lo creado
Ver el informe final. Este documento describe cómo hacerlo; los comandos los ejecuta una persona.

## 1 · Base de datos (Supabase)
1. Crea un proyecto (nombre `ipam-poc`) en plan gratuito. Guarda la contraseña del administrador en un gestor de secretos (nunca en el repo ni en un chat).
2. Como administrador, en el editor SQL: `mvp/db/supabase/00-preparar.sql` (crea esquema `ipam`, roles `ipam_migrador` e `ipam_app` **sin contraseña**, `btree_gist` y revoca a `anon`/`authenticated`/`service_role`).
3. Fija las contraseñas de los roles con un comando que lleva marcadores de posición (reemplázalos tú; no los pegues en ningún chat ni commit):
   ```sql
   alter role ipam_migrador password '<CLAVE_MIGRADOR>';
   alter role ipam_app      password '<CLAVE_APP>';
   ```
4. Migra con el rol migrador: `DATABASE_URL_MIGRACION='postgres://ipam_migrador.<ref>:…@<pooler>:5432/postgres?sslmode=require' DATABASE_SCHEMA=ipam npm run migrar` (o el workflow manual «Migrar POC» / el trabajo `poc:migrar`).
5. Como administrador: `mvp/db/supabase/01-rls.sql` (RLS) y, si quieres datos de ejemplo, `mvp/db/seed-poc.sql` (**rangos ficticios**).

## 2 · Cadena de conexión
Usa el **pooler en modo sesión, puerto 5432**, con `sslmode=require`; usuario `ipam_app.<ref-del-proyecto>`. **No uses el puerto 6543** (modo transacción): el IPAM usa advisory locks y `set_config` de sesión, que no sobreviven entre transacciones. Es una limitación conocida de `sslmode=require` en libpq: cifra pero no verifica el certificado; para verificarlo, descarga la CA del proyecto y úsala en `DATABASE_SSL_CA`.

## 3 · Servicio (Render)
`despliegue/render/render.yaml` (plan `free`, región Oregon, `healthCheckPath: /healthz`, `autoDeploy: false`). Los secretos (`DATABASE_URL`, `APP_PASS`, `PUBLIC_URL`, `METRICS_TOKEN`) se escriben en el panel de Render, **nunca** en el archivo. `APP_PASS` es un hash: `node mvp/scripts/hash-password.js '<clave>'`.
Acceso: Basic (solo POC; el servicio avisa en el log) más **tokens de servicio** para agentes. Para uso real, configura OIDC.

## 4 · Sueño del plan gratuito
El servicio se duerme sin tráfico; **la primera petición puede tardar más de un minuto** (planifica ≥ 90 s). Los pipelines llaman a `/healthz` con reintentos (`scripts/ci/keepalive.sh`). El keepalive opcional (`.github/workflows/keepalive.yml`, o una programación de GitLab con `IPAM_TAREA=keepalive`) lo mantiene despierto, pero no es un monitor ni garantiza disponibilidad.

## 5 · Costos
| Pieza | Plan del POC | Qué verificar |
|---|---|---|
| Render (servicio web) | `free` | página oficial de precios: horas, sueño, ancho de banda |
| Supabase (base) | gratuito | página oficial: tamaño, pausa por inactividad, proyectos por organización |
| GitHub/GitLab CI | el de tu cuenta | minutos incluidos |
Pasar a pago: cambia `plan` en `render.yaml` y sube el plan de Supabase; no hay cambios de código.

## 6 · Salir del POC
Cambiar `DATABASE_URL` a otra PostgreSQL y desplegar la imagen en otro lugar (ver [DESPLIEGUE](DESPLIEGUE.md)). Restaura con `pg_dump`/`pg_restore` (ver [RESPALDO-Y-RECUPERACION](RESPALDO-Y-RECUPERACION.md)).
