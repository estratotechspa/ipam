# ADR 0003 · TTL de las reservas: 24 horas por defecto, 72 como máximo

- **Estado:** aceptada · **Fecha:** 2026-10-21

## Contexto
Una reserva tentativa aparta un rango mientras una persona revisa y aprueba el cambio. Si dura poco, el MR caduca antes de aprobarse; si dura mucho, rangos
que nadie va a usar quedan apartados.

## Decisión
- **Por defecto 24 horas** (`RESERVA_TTL_HORAS`): cubre un día hábil de revisión con holgura.
- **Máximo 72 horas** (`RESERVA_TTL_MAX_HORAS`): cubre un fin de semana largo sin permitir reservas «eternas». Pedir más es un error 400 (`ttl_excede_maximo`): **no se recorta en silencio**,
  para que el agente sepa que su reserva durará menos de lo que esperaba.
- Ambos valores se configuran por variable de entorno y por `values.yaml`.

## Cómo expira
- **Expiración perezosa (garantiza la corrección):** cada consulta, reserva o confirmación trata una reserva «reservada» cuyo plazo pasó como **expirada**, sin esperar a nadie.
  El reloj que decide es **el de la base de datos**, no el de cada réplica: así dos réplicas jamás discrepan.
- **Barredor (solo limpia):** cada 60 s marca como expiradas las vencidas y publica el evento `reserva_expirada`. Se coordina con un *advisory lock*: con varias réplicas solo una lo ejecuta.
  Si el servicio duerme (plan gratuito), nada queda mal: al despertar, la expiración perezosa ya aplica.

## Consecuencias
- (+) Cero reservas colgadas aunque el barredor no corra.
- (−) Si el MR tarda más que el TTL, hay que reservar de nuevo (el agente usa una clave de idempotencia nueva).
- Ajuste fino: ver [`BUENAS-PRACTICAS.md`](../BUENAS-PRACTICAS.md) para TTL recomendados por ambiente.
