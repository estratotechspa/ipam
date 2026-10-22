-- IPAM MVP · esquema (idempotente: se puede ejecutar en cada despliegue)
create extension if not exists btree_gist;

create table if not exists pools (
  id        text primary key,
  tipo      text not null,
  ambiente  text not null check (ambiente in ('dev','qa','pre','prod')),
  proveedor text not null,
  cidr      cidr not null
);

create sequence if not exists ticket_seq start 143;

create table if not exists asignaciones (
  id          bigserial primary key,
  pool_id     text not null references pools(id),
  cidr        cidr not null,
  vpc         text not null,
  solicitante text not null,
  ticket      text not null,
  origen      text not null default 'panel' check (origen in ('panel','jira','semilla')),
  creado_en   timestamptz not null default now(),
  -- Garantía en la base: dos segmentos del mismo pool nunca se solapan (también con concurrencia).
  constraint sin_solapamiento exclude using gist (pool_id with =, cidr inet_ops with &&)
);

-- El segmento debe caer dentro del CIDR base de su pool.
create or replace function asignacion_dentro_del_pool() returns trigger language plpgsql as $$
begin
  if not (new.cidr <<= (select cidr from pools where id = new.pool_id)) then
    raise exception 'El segmento % queda fuera del pool %', new.cidr, new.pool_id using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_dentro_del_pool on asignaciones;
create trigger trg_dentro_del_pool before insert or update on asignaciones
  for each row execute function asignacion_dentro_del_pool();

create table if not exists eventos (
  id      bigserial primary key,
  ts      timestamptz not null default now(),
  tipo    text not null,
  detalle jsonb not null default '{}'
);


-- Usuarios que han iniciado sesión (OIDC). «rol» nulo = se resuelve por grupos / configuración.
create table if not exists usuarios (
  email         text primary key,
  nombre        text not null default '',
  rol           text check (rol in ('lector','solicitante','admin')),
  ultimo_acceso timestamptz,
  creado_en     timestamptz not null default now()
);

-- Bitácora de auditoría: quién hizo qué y cuándo.
create table if not exists auditoria (
  id      bigserial primary key,
  ts      timestamptz not null default now(),
  usuario text not null,
  rol     text,
  accion  text not null,
  detalle jsonb not null default '{}',
  ip      text
);
create index if not exists auditoria_ts_idx on auditoria (ts desc);

-- ============================================================================
-- Fase 0 · versión del esquema, trazabilidad y auditoría de solo inserción
-- ============================================================================
-- Versión del esquema: la app la verifica en /readyz (no modifica el esquema al arrancar).
create table if not exists esquema_version (
  version     int primary key,
  descripcion text not null,
  aplicado_en timestamptz not null default now()
);

-- Correlación: cada fila de auditoría guarda el X-Request-Id de la petición que la originó.
alter table auditoria add column if not exists request_id text;

-- La auditoría es de solo inserción: ni siquiera el dueño de la tabla puede modificar ni borrar sus filas.
create or replace function auditoria_solo_insercion() returns trigger language plpgsql as $$
begin
  raise exception 'La tabla auditoria es de solo inserción' using errcode = '42501';
end $$;
drop trigger if exists trg_auditoria_solo_insercion on auditoria;
create trigger trg_auditoria_solo_insercion before update or delete on auditoria
  for each row execute function auditoria_solo_insercion();
drop trigger if exists trg_auditoria_sin_truncate on auditoria;
create trigger trg_auditoria_sin_truncate before truncate on auditoria
  for each statement execute function auditoria_solo_insercion();

-- Estado del barredor: lo comparten todas las réplicas (solo una lo ejecuta a la vez, con un advisory lock).
create table if not exists barredor_estado (
  id               int primary key default 1 check (id = 1),
  ultima_ejecucion timestamptz,
  duracion_ms      int,
  instancia        text
);
insert into barredor_estado (id) values (1) on conflict (id) do nothing;

insert into esquema_version (version, descripcion) values (2, 'fase 0: version del esquema, auditoria de solo insercion, estado del barredor')
  on conflict (version) do nothing;
