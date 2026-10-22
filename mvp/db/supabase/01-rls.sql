-- Se ejecuta DESPUÉS de db/schema.sql (como administrador). Idempotente.
-- Activa RLS (seguridad por filas) en todas las tablas del esquema «ipam». Sin políticas para anon/authenticated, esos roles
-- de la API de Supabase no ven nada. El dueño de las tablas (ipam_migrador) no está sujeto a RLS; ipam_app sí, por lo que
-- se le da una política explícita y total (la app ya está limitada por los permisos de tabla de schema.sql).
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'ipam' loop
    execute format('alter table ipam.%I enable row level security', t.tablename);
    if not exists (select 1 from pg_policies where schemaname = 'ipam' and tablename = t.tablename and policyname = 'ipam_app_total') then
      execute format('create policy ipam_app_total on ipam.%I for all to ipam_app using (true) with check (true)', t.tablename);
    end if;
  end loop;
end $$;
