resource "aws_db_instance" "this" {
  identifier          = "app-db"
  engine              = "mysql"
  engine_version      = "8.0"
  instance_class      = "db.t3.micro"
  allocated_storage   = 20
  username            = "admin"
  password            = "placeholder"
  skip_final_snapshot = true
  storage_encrypted   = var.encrypted
  tags = {
    Environment = var.environment
  }
}
