# ADR 0007 · POC en Render + Supabase, sin acoplar el producto

- **Estado:** aceptada · **Fecha:** 2026-10-22

## Contexto
Hace falta una demo barata y rápida; el hosting definitivo lo define Rodrigo (GKE, Cloud Run, AWS, Azure o servidor propio).

## Decisión
El POC corre en Render (servicio web desde el Dockerfile) y Supabase (PostgreSQL común), **tratados como proveedores intercambiables**: el código solo habla PostgreSQL por `DATABASE_URL` y se configura por variables. Lo específico de Supabase queda en `mvp/db/supabase/` (SQL estándar) y lo de Render en `despliegue/render/`. Conexión por pooler en modo sesión (5432), roles de mínimo privilegio y RLS como defensa en profundidad.

## Consecuencias
(+) Costo mínimo y salida simple: otra `DATABASE_URL` y otra plataforma de contenedores. (−) El plan gratuito duerme el servicio y limita recursos; auth Basic solo para POC. La guardia de portabilidad impide que `src/` mencione a ambos proveedores.
