# IPAM en Google Cloud: Cloud Run + Cloud SQL (PostgreSQL) + Secret Manager + cuentas de servicio de permisos mínimos.
# EJEMPLO NO VALIDADO CONTRA UNA CUENTA REAL: se comprobó la sintaxis (`tofu validate`), no el resultado de aplicarlo.
# Todos los nombres y rangos son de relleno.

locals {
  sufijo = "ipam-${var.ambiente}"
  # Se decide por el usuario (no sensible): un valor sensible no puede gobernar count ni for_each.
  con_basic = var.usuario_basic != ""
}

resource "google_project_service" "apis" {
  for_each           = toset(["run.googleapis.com", "sqladmin.googleapis.com", "secretmanager.googleapis.com", "artifactregistry.googleapis.com", "servicenetworking.googleapis.com", "compute.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}

# ---------- Cuentas de servicio (permisos mínimos) ----------
resource "google_service_account" "runtime" {
  account_id   = "${local.sufijo}-run"
  display_name = "IPAM (${var.ambiente}) en ejecución: solo datos"
}

resource "google_service_account" "migrador" {
  account_id   = "${local.sufijo}-migrar"
  display_name = "IPAM (${var.ambiente}) migraciones: DDL"
}

# Ambas necesitan conectarse a Cloud SQL (a nivel de proyecto no hay un rol más acotado para el socket).
resource "google_project_iam_member" "sql_cliente" {
  for_each = { runtime = google_service_account.runtime.email, migrador = google_service_account.migrador.email }
  project  = var.proyecto
  role     = "roles/cloudsql.client"
  member   = "serviceAccount:${each.value}"
}

# ---------- Red privada para la base (Cloud SQL sin IP pública) ----------
resource "google_compute_global_address" "servicios_privados" {
  name          = "${local.sufijo}-servicios-privados"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = var.red
}

resource "google_service_networking_connection" "servicios_privados" {
  network                 = var.red
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.servicios_privados.name]
  depends_on              = [google_project_service.apis]
}

# ---------- Cloud SQL ----------
resource "random_password" "ipam_app" {
  length  = 32
  special = false
}

resource "random_password" "ipam_migrador" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "ipam" {
  # checkov:skip=CKV_GCP_6:El TLS obligatorio se fuerza con ssl_mode = ENCRYPTED_ONLY (atributo vigente; require_ssl está obsoleto).
  # checkov:skip=CKV_GCP_110:pgAudit es opcional y agrega carga; actívalo (cloudsql.enable_pgaudit) si tu política de auditoría lo exige.
  # checkov:skip=CKV2_GCP_13:log_duration registra la duración de CADA sentencia (muy ruidoso); se registran DDL, conexiones, bloqueos y puntos de control.
  name                = local.sufijo
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.proteger_borrado

  settings {
    tier              = "db-custom-1-3840"
    availability_type = var.ambiente == "prod" ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    ip_configuration {
      ipv4_enabled    = false # sin IP pública
      private_network = var.red
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    database_flags {
      name  = "log_connections"
      value = "on"
    }
    database_flags {
      name  = "log_disconnections"
      value = "on"
    }
    database_flags {
      name  = "log_checkpoints"
      value = "on"
    }
    database_flags {
      name  = "log_lock_waits"
      value = "on"
    }
    database_flags {
      name  = "log_hostname"
      value = "on"
    }
    database_flags {
      name  = "log_min_messages"
      value = "error"
    }
    database_flags {
      name  = "log_min_error_statement"
      value = "error"
    }
    database_flags {
      name  = "log_statement"
      value = "ddl"
    }
  }

  lifecycle {
    prevent_destroy = true # igual que las redes críticas: no se borra por accidente
  }

  depends_on = [google_project_service.apis, google_service_networking_connection.servicios_privados]
}

resource "google_sql_database" "ipam" {
  name     = "ipam"
  instance = google_sql_database_instance.ipam.name
}

# Dos usuarios: el de la app solo recibirá permisos de datos (ver db/supabase/00-preparar.sql y docs/ACCESO-Y-SEGURIDAD.md para los GRANT).
resource "google_sql_user" "ipam_app" {
  name     = "ipam_app"
  instance = google_sql_database_instance.ipam.name
  password = random_password.ipam_app.result
}

resource "google_sql_user" "ipam_migrador" {
  name     = "ipam_migrador"
  instance = google_sql_database_instance.ipam.name
  password = random_password.ipam_migrador.result
}

# ---------- Secret Manager ----------
locals {
  # Conexión por socket de Cloud SQL: no necesita TLS adicional ni abrir la base a Internet.
  socket = "/cloudsql/${google_sql_database_instance.ipam.connection_name}"
  secretos = {
    "database-url"           = "postgres://ipam_app:${random_password.ipam_app.result}@/ipam?host=${local.socket}"
    "database-url-migracion" = "postgres://ipam_migrador:${random_password.ipam_migrador.result}@/ipam?host=${local.socket}"
  }
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.secretos
  secret_id = "${local.sufijo}-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "s" {
  for_each    = local.secretos
  secret      = google_secret_manager_secret.s[each.key].id
  secret_data = each.value
}

# Token de lectura de /metrics: se genera aquí y se entrega al recolector por otro canal.
resource "random_password" "metrics" {
  length  = 40
  special = false
}

resource "google_secret_manager_secret" "metrics" {
  secret_id = "${local.sufijo}-metrics-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "metrics" {
  secret      = google_secret_manager_secret.metrics.id
  secret_data = random_password.metrics.result
}

resource "google_secret_manager_secret" "clave_basic" {
  count     = local.con_basic ? 1 : 0
  secret_id = "${local.sufijo}-app-pass"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "clave_basic" {
  count       = local.con_basic ? 1 : 0
  secret      = google_secret_manager_secret.clave_basic[0].id
  secret_data = var.clave_basic_hash
}

# Acceso a SECRETOS CONCRETOS (no a todos los del proyecto).
resource "google_secret_manager_secret_iam_member" "runtime_url" {
  secret_id = google_secret_manager_secret.s["database-url"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_metrics" {
  secret_id = google_secret_manager_secret.metrics.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_basic" {
  count     = local.con_basic ? 1 : 0
  secret_id = google_secret_manager_secret.clave_basic[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "migrador_url" {
  secret_id = google_secret_manager_secret.s["database-url-migracion"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.migrador.email}"
}

# ---------- Cloud Run: servicio y job de migración ----------
resource "google_cloud_run_v2_service" "ipam" {
  name                = local.sufijo
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" # sin acceso directo desde Internet
  deletion_protection = var.proteger_borrado

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 1 # el barredor solo corre con una instancia viva; con 0 la expiración sigue siendo correcta (perezosa)
      max_instance_count = 3
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY" # solo el tráfico hacia redes privadas (la base) sale por la VPC
      network_interfaces {
        network    = var.red
        subnetwork = var.subred
      }
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.ipam.connection_name]
      }
    }
    containers {
      image = var.imagen
      ports {
        container_port = 8080
      }
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = false # CPU siempre asignada
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PUBLIC_URL"
        value = var.url_publica
      }
      env {
        name  = "TRUST_PROXY"
        value = "2" # verificar los saltos reales en tu entorno
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.s["database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "METRICS_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.metrics.secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = local.con_basic ? toset(["basic"]) : toset([])
        content {
          name  = "APP_USER"
          value = var.usuario_basic
        }
      }
      dynamic "env" {
        for_each = local.con_basic ? toset(["basic"]) : toset([])
        content {
          name = "APP_PASS"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.clave_basic[0].secret_id
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 2
        failure_threshold = 30
      }
      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds = 20
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.s,
    google_secret_manager_secret_iam_member.runtime_url,
  ]
}

resource "google_cloud_run_v2_job" "migrar" {
  name                = "${local.sufijo}-migrar"
  location            = var.region
  deletion_protection = var.proteger_borrado

  template {
    template {
      service_account = google_service_account.migrador.email
      max_retries     = 1
      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = var.red
          subnetwork = var.subred
        }
      }
      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.ipam.connection_name]
        }
      }
      containers {
        image   = var.imagen
        command = ["node", "src/cli/migrar.js"]
        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
        env {
          name = "DATABASE_URL_MIGRACION"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s["database-url-migracion"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
}
