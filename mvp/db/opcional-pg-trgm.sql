-- Script opcional para acelerar búsquedas de texto con trigramas (pg_trgm)
-- Útil si una instalación maneja más de 50.000 segmentos y la búsqueda por texto se vuelve lenta.
-- Requiere permisos de superusuario o de creación de extensiones en PostgreSQL.

create extension if not exists pg_trgm;

-- Índice GIN de trigramas para búsqueda en asignaciones
create index if not exists asignaciones_busqueda_trgm_idx on asignaciones using gin (
  (
    coalesce(cidr::text, '') || ' ' ||
    coalesce(codigo, '') || ' ' ||
    coalesce(vpc, '') || ' ' ||
    coalesce(solicitante, '') || ' ' ||
    coalesce(ticket, '') || ' ' ||
    coalesce(proyecto, '') || ' ' ||
    coalesce(subred, '') || ' ' ||
    coalesce(descripcion, '')
  ) gin_trgm_ops
);

-- Índice GIN de trigramas para búsqueda en direcciones IP
create index if not exists direcciones_ip_busqueda_trgm_idx on direcciones_ip using gin (
  (
    coalesce(host(ip), '') || ' ' ||
    coalesce(dispositivo, '') || ' ' ||
    coalesce(interfaz, '') || ' ' ||
    coalesce(dns, '') || ' ' ||
    coalesce(descripcion, '')
  ) gin_trgm_ops
);
