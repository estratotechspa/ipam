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
-- La purga por retención (RETENCION_DIAS) filtra por fecha.
create index if not exists eventos_ts_idx on eventos (ts);

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
