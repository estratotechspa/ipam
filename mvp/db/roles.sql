-- Roles de base de datos del IPAM (PostgreSQL estándar 14 a 17; sin nada propio de un proveedor). Ejecutar con un usuario administrador
-- de la base. Es idempotente. Las CONTRASEÑAS no van en este archivo: se fijan aparte (ver docs/ACCESO-Y-SEGURIDAD.md), por ejemplo
--     psql -v ON_ERROR_STOP=1 -f db/roles.sql
--     psql -c "alter role ipam_migrador password 'CLAVE_MIGRADOR'" -c "alter role ipam_app password 'CLAVE_APP'"
--
-- Dos roles, con permisos mínimos:
--   ipam_migrador  dueño del esquema y de las tablas: aplica el DDL (`npm run migrar`). Solo se usa para migrar.
--   ipam_app       lo que usa el servicio en ejecución: solo DML (select/insert/update/delete) sobre las tablas del IPAM.
--                  No es superusuario, no crea ni borra tablas, y NO puede actualizar ni borrar la auditoría.
-- El esquema se llama «ipam» (DATABASE_SCHEMA=ipam). Para usar otro nombre, reemplázalo en este archivo.
-- Los permisos sobre las tablas los otorga db/schema.sql al aplicarse con el rol migrador (se repiten en cada migración).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ipam_migrador') then
    create role ipam_migrador login nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ipam_app') then
    create role ipam_app login nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end $$;

-- Conectarse a esta base. El migrador además necesita CREATE para instalar la extensión contrib btree_gist (es «de confianza» desde PostgreSQL 13).
do $$
begin
  execute format('grant connect on database %I to ipam_app, ipam_migrador', current_database());
  execute format('grant create on database %I to ipam_migrador', current_database());
end $$;

-- Esquema propio: el migrador es el dueño; la app solo puede usarlo.
create schema if not exists ipam authorization ipam_migrador;
revoke all on schema ipam from public;
grant usage on schema ipam to ipam_app;
alter role ipam_migrador set search_path = ipam;
alter role ipam_app set search_path = ipam;
-- Nota PostgreSQL 14: el esquema public permite CREATE a todos los roles. Si es seguro en tu base: revoke create on schema public from public;
-- (desde PostgreSQL 15 ya viene revocado.)
