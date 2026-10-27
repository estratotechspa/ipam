# EJEMPLO (no validado contra una cuenta real): redes críticas protegidas contra borrado accidental.
# `prevent_destroy = true` hace que `tofu apply` FALLE si el plan incluye destruir estos recursos; para borrarlos hay que quitar la línea a propósito (y que otra persona lo revise en el MR).
# Los rangos vienen del IPAM (variables que escribe el agente de redes en el MR); los de este archivo son FICTICIOS.
variable "proyecto" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "cidr_nodos_prod" {
  description = "Rango de nodos reservado en el IPAM (pool Nodos, ambiente prod)."
  type        = string
  default     = "10.240.0.0/24" # FICTICIO
}

variable "cidr_pods_prod" {
  type    = string
  default = "10.240.16.0/20" # FICTICIO
}

variable "cidr_servicios_prod" {
  type    = string
  default = "10.240.64.0/24" # FICTICIO
}

resource "google_compute_network" "vpc_prod" {
  name                    = "vpc-demo-prod"
  project                 = var.proyecto
  auto_create_subnetworks = false

  lifecycle {
    prevent_destroy = true # red crítica
  }
}

resource "google_compute_subnetwork" "sn_gke_prod" {
  name          = "sn-demo-prod-gke"
  project       = var.proyecto
  region        = var.region
  network       = google_compute_network.vpc_prod.id
  ip_cidr_range = var.cidr_nodos_prod

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.cidr_pods_prod
  }

  secondary_ip_range {
    range_name    = "servicios"
    ip_cidr_range = var.cidr_servicios_prod
  }

  lifecycle {
    prevent_destroy = true # subred de producción
  }
}
