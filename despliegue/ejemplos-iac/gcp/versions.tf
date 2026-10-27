# EJEMPLO sin validar contra una cuenta real. Funciona con OpenTofu (`tofu`) y es compatible con Terraform (`terraform`).
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # El estado contiene valores sensibles (claves generadas). Usa un backend remoto CIFRADO y con acceso restringido, por ejemplo:
  # backend "gcs" { bucket = "mi-bucket-de-estado" prefix = "ipam" }
}

provider "google" {
  project = var.proyecto
  region  = var.region
}
