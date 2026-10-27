# ADR 0004 · Seguro por defecto

- **Estado:** aceptada · **Fecha:** 2026-10-21

## Contexto
La demo original arrancaba abierta (sin autenticación) si nadie configuraba nada. Para una demo local es cómodo; en producción es un riesgo: un olvido de configuración
dejaría el IPAM abierto a cualquiera, como administrador.

## Decisión
1. **Con `NODE_ENV=production`, sin OIDC ni Basic, el IPAM se niega a arrancar** (mensaje claro, código de salida 1), salvo `ALLOW_ANONYMOUS=true`, pensado solo para demos.
   El modo abierto además deja una advertencia en el log. El modo Basic también avisa (es para POC y demos; la clave puede ir como hash scrypt).
2. **Helm:** `auth.allowAnonymous: false` por defecto y la plantilla **falla** si no hay `auth.oidc.issuer`, `secrets.appUser`, `secrets.existingSecret` ni `auth.allowAnonymous`.
3. **docker-compose** local: `ALLOW_ANONYMOUS: ${ALLOW_ANONYMOUS:-true}` (solo desarrollo; la imagen corre con `NODE_ENV=production`).
4. **Cabeceras** (helmet): CSP estricta sin scripts en línea, `nosniff`, `frame-ancestors 'none'`, sin `X-Powered-By`; HSTS solo si se activa; la API responde `Cache-Control: no-store`.
5. **Cookies** de sesión `HttpOnly`, `SameSite=Lax` y `Secure` (con `PUBLIC_URL` https o cuando la petición llegó por HTTPS detrás de un proxy de confianza).
6. **Sin secretos por defecto en producción:** el webhook de Jira sin `JIRA_WEBHOOK_SECRET` queda deshabilitado (en desarrollo usa un valor de juguete).
7. Errores sin detalles internos (solo `request_id`) y logs con credenciales redactadas.

## Consecuencias
- (+) Un despliegue mal configurado falla ruidosamente al arrancar en vez de quedar abierto.
- (−) Quien despliega una demo en producción debe decir explícitamente que quiere el modo abierto.
