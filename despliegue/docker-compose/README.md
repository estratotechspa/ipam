# Docker Compose (local)

```bash
cd despliegue/docker-compose
cp .env.example .env                 # edita las claves de relleno
docker compose up --build -d         # API en http://localhost:8080 (esperando a que la migración termine)
docker compose --profile semilla run --rm semilla     # datos de ejemplo FICTICIOS (opcional)
curl -s localhost:8080/readyz        # {"ok":true,...}
docker compose down -v               # apaga y borra la base
```

Qué hace cada servicio: `db` (PostgreSQL 16), `migrar` (aplica el esquema y termina), `api` (el IPAM; arranca solo si `migrar` terminó bien).
La imagen corre sin shell, con sistema de archivos de solo lectura y sin capacidades Linux.

- **Secretos como archivos**: en vez de `DATABASE_URL`, monta un archivo y usa `DATABASE_URL_FILE` (Docker secrets): ver [`docs/CONFIGURACION.md`](../../docs/CONFIGURACION.md).
- **`ALLOW_ANONYMOUS=true`** (por defecto aquí) deja entrar a cualquiera como administrador: solo para tu máquina.
