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

	approved_key_arns := object.get(input, "approved_kms_key_arns", [])
	kms_key_id := object.get(after, "kms_key_id", "")
	not kms_key_id in approved_key_arns

	msg := sprintf("Production database %s must use an approved KMS key", [rc.address])
}
