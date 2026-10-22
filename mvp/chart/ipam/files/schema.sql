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
  origen      text not null default 'panel' check (origen in ('panel','jira','semilla','agente')),
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

-- ============================================================================
-- Fase 1 · reservas tentativas (human-in-the-loop: sin confirmar, expiran solas)
-- ============================================================================
-- El origen «agente» debe ser válido también en bases ya existentes (idempotente: solo cambia la restricción si aún no lo incluye).
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'asignaciones'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''agente''%') then
    alter table asignaciones drop constraint if exists asignaciones_origen_check;
    alter table asignaciones add constraint asignaciones_origen_check check (origen in ('panel','jira','semilla','agente'));
  end if;
end $$;

create table if not exists reservas (
  id            uuid primary key default gen_random_uuid(),
  pool_id       text not null references pools(id),
  cidr          cidr not null,
  vpc           text not null,
  solicitante   text not null,
  ticket        text not null,
  estado        text not null default 'reservada' check (estado in ('reservada','confirmada','liberada','expirada')),
  clave_idem    text,                                  -- Idempotency-Key del agente (única por solicitante)
  creado_en     timestamptz not null default now(),
  expira_en     timestamptz not null,
  resuelto_en   timestamptz,
  asignacion_id bigint references asignaciones(id) on delete set null,
  -- Garantía en la base: dos reservas vigentes del mismo pool nunca se solapan (también con concurrencia).
  constraint reservas_sin_solapamiento exclude using gist (pool_id with =, cidr inet_ops with &&) where (estado = 'reservada')
);
create unique index if not exists reservas_solicitante_clave_idx on reservas (solicitante, clave_idem);
create index if not exists reservas_estado_expira_idx on reservas (estado, expira_en);
create index if not exists reservas_pool_idx on reservas (pool_id);
create index if not exists reservas_solicitante_idx on reservas (solicitante);

-- La reserva debe caer dentro del CIDR base de su pool y no pisar una asignación existente.
create or replace function reserva_valida() returns trigger language plpgsql as $$
begin
  if not (new.cidr <<= (select cidr from pools where id = new.pool_id)) then
    raise exception 'El segmento % queda fuera del pool %', new.cidr, new.pool_id using errcode = '23514';
  end if;
  if new.estado = 'reservada' and exists (select 1 from asignaciones a where a.pool_id = new.pool_id and a.cidr && new.cidr) then
    raise exception 'El segmento % se solapa con una asignación del pool %', new.cidr, new.pool_id using errcode = '23P01';
  end if;
  return new;
end $$;
drop trigger if exists trg_reserva_valida on reservas;
create trigger trg_reserva_valida before insert on reservas
  for each row execute function reserva_valida();

-- Una asignación (panel, Jira, importación…) no puede pisar una reserva VIGENTE de otra persona. Al confirmar, la propia reserva se
-- exceptúa con el ajuste local «ipam.reserva_confirmando» (lo fija la transacción de confirmación).
create or replace function asignacion_respeta_reservas() returns trigger language plpgsql as $$
begin
  if exists (select 1 from reservas r
              where r.pool_id = new.pool_id and r.estado = 'reservada' and r.expira_en > now() and r.cidr && new.cidr
                and r.id::text is distinct from nullif(current_setting('ipam.reserva_confirmando', true), '')) then
    raise exception 'El segmento % se solapa con una reserva vigente del pool %', new.cidr, new.pool_id using errcode = '23P01';
  end if;
  return new;
end $$;
drop trigger if exists trg_asignacion_respeta_reservas on asignaciones;
create trigger trg_asignacion_respeta_reservas before insert on asignaciones
  for each row execute function asignacion_respeta_reservas();

insert into esquema_version (version, descripcion) values (3, 'fase 1: reservas tentativas y origen agente')
  on conflict (version) do nothing;

-- ============================================================================
-- Fase 2 · tokens de servicio (credenciales para agentes; el token en claro NUNCA se guarda)
-- ============================================================================
create table if not exists tokens_servicio (
  id             uuid primary key default gen_random_uuid(),
  nombre         text not null unique check (nombre ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  prefijo        text not null,                       -- «ipam_» + 4 caracteres: reconoce el token en una lista sin revelarlo
  hash           text not null unique,                -- SHA-256 (hex) del token completo
  rol            text not null check (rol in ('lector','agente')),
  cuota_reservas int check (cuota_reservas is null or cuota_reservas > 0),   -- tope propio de reservas vigentes (nulo = el general)
  creado_por     text not null,
  creado_en      timestamptz not null default now(),
  expira_en      timestamptz not null,
  ultimo_uso     timestamptz,
  revocado_en    timestamptz
);
create index if not exists tokens_servicio_expira_idx on tokens_servicio (expira_en) where revocado_en is null;

insert into esquema_version (version, descripcion) values (4, 'fase 2: tokens de servicio con rol agente')
  on conflict (version) do nothing;
