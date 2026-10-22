-- Preparación de una base SUPABASE para el IPAM (POC). Se ejecuta UNA vez como administrador (rol «postgres»); es idempotente.
-- Es PostgreSQL estándar: solo existe para que Supabase quede equivalente a una base común. Las CONTRASEÑAS no van aquí
-- (ver docs/ops/POC-RENDER-SUPABASE.md): se fijan aparte con un comando que lleva un marcador de posición.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ipam_migrador') then
    create role ipam_migrador login nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ipam_app') then
    create role ipam_app login nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end $$;

-- Supabase deja a «postgres» fuera del grupo de los roles nuevos: se le permite administrarlos.
grant ipam_migrador, ipam_app to postgres;

do $$
begin
  execute format('grant connect on database %I to ipam_app, ipam_migrador', current_database());
  execute format('grant create on database %I to ipam_migrador', current_database());
end $$;

create schema if not exists ipam authorization ipam_migrador;
revoke all on schema ipam from public;
grant usage on schema ipam to ipam_app;
-- btree_gist vive en «extensions»: el migrador y la app deben poder usar sus clases de operadores.
grant usage on schema extensions to ipam_migrador, ipam_app;
alter role ipam_migrador set search_path = ipam, extensions;
alter role ipam_app set search_path = ipam, extensions;

-- Los roles de la API automática de Supabase (PostgREST) NO deben ver nada del IPAM: la app se conecta directo a PostgreSQL.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema ipam from %I', r);
      execute format('revoke all on all tables in schema ipam from %I', r);
      execute format('alter default privileges for role ipam_migrador in schema ipam revoke all on tables from %I', r);
    end if;
  end loop;
end $$;

-- Defensa en profundidad: aunque alguien activara la API de Supabase, las tablas del IPAM tendrían RLS sin políticas
-- (se activa en 01-rls.sql, que se ejecuta DESPUÉS del esquema porque las tablas aún no existen aquí).
