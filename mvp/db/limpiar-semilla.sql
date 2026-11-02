-- Quita los datos de ejemplo (db/seed.sql y db/seed-poc.sql) de una base ya cargada. Una sola vez; idempotente. -- BORRA DATOS
-- Solo toca: asignaciones con origen 'semilla' dentro de los pools de ejemplo, y esos pools si quedan vacíos.
-- Un pool de ejemplo en el que ya haya trabajo real (asignaciones de otro origen, reservas vigentes o IPs sueltas) NO se borra.
-- La auditoría (solo inserción) no se toca: queda constancia de lo creado y de esta limpieza.
-- Revisa el resultado con el SELECT final y confirma con COMMIT; si algo no cuadra, ROLLBACK.
begin;

create temp table pools_semilla (id text primary key) on commit drop;
insert into pools_semilla values
 ('gke-nodos-prod'),('gke-pods-prod'),('gke-svc-prod'),('gke-cp-prod'),('gke-nodos-qa'),('onprem-lan-dev'),
 ('dev-nodos'),('dev-pods'),('dev-servicios'),('qa-nodos'),('qa-pods'),('qa-servicios'),
 ('pre-nodos'),('pre-pods'),('pre-servicios'),('prod-nodos'),('prod-pods'),('prod-servicios');

create temp table asig_semilla on commit drop as
  select a.id from asignaciones a join pools_semilla s on s.id = a.pool_id where a.origen = 'semilla';

delete from direcciones_ip where asignacion_id in (select id from asig_semilla);
delete from reservas where asignacion_id in (select id from asig_semilla);
delete from asignaciones where id in (select id from asig_semilla);

-- Pools de ejemplo que quedaron vacíos (misma regla que el botón Eliminar: sin asignaciones, reservas vigentes ni IPs).
create temp table pools_vacios on commit drop as
  select p.id from pools p join pools_semilla s on s.id = p.id
  where not exists (select 1 from asignaciones where pool_id = p.id)
    and not exists (select 1 from reservas where pool_id = p.id and estado = 'reservada' and expira_en > now())
    and not exists (select 1 from direcciones_ip where pool_id = p.id);
delete from reservas where pool_id in (select id from pools_vacios); -- solo historial ya resuelto
delete from pools where id in (select id from pools_vacios);

-- Qué quedó: pools de ejemplo que NO se pudieron borrar (con su motivo) y el total de pools restantes.
select p.id as pool_de_ejemplo_que_sigue,
       (select count(*) from asignaciones where pool_id = p.id) as asignaciones,
       (select count(*) from reservas where pool_id = p.id and estado = 'reservada' and expira_en > now()) as reservas_vigentes,
       (select count(*) from direcciones_ip where pool_id = p.id) as ips
from pools p join pools_semilla s on s.id = p.id;
select count(*) as pools_restantes from pools;

-- commit;  -- <- quita el comentario para confirmar. Así como está, al terminar la sesión se deshace todo.
rollback;
