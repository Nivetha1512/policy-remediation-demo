package terraform

import rego.v1

deny contains msg if {
	some rc in input.resource_changes
	rc.type == "aws_db_instance"
	rc.change.actions != ["delete"]

	after := object.get(rc.change, "after", {})
	is_object(after)

	tags := object.get(after, "tags", {})
	is_object(tags)
	object.get(tags, "Environment", "") == "prod"

	object.get(after, "storage_encrypted", false) != true

	msg := sprintf("Production database %s must have storage encryption enabled", [rc.address])
}
