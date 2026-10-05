module "database" {
  source      = "./modules/database"
  environment = "prod"
  encrypted   = true
}