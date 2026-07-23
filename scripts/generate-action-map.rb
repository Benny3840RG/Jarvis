#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"
require "set"

REGISTRY = "docs/traceability/action-family-registry.yaml"
OUTPUT = "docs/traceability/action-map.generated.md"
CHECK_ONLY = ARGV.include?("--check")

abort "Missing #{REGISTRY}" unless File.file?(REGISTRY)

data = YAML.safe_load(File.read(REGISTRY), permitted_classes: [], aliases: false)
errors = []

patterns = data.fetch("identity_rules")
overlays = data.fetch("policy_overlays")
families = data.fetch("action_families")
workflows = data.fetch("workflows", [])

family_id_re = Regexp.new(patterns.fetch("action_family_id_pattern"))
workflow_id_re = Regexp.new(patterns.fetch("workflow_id_pattern"))
test_id_re = Regexp.new(patterns.fetch("test_id_pattern"))
evidence_id_re = Regexp.new(patterns.fetch("evidence_id_pattern"))
tool_id_re = Regexp.new(patterns.fetch("tool_id_pattern"))
store_id_re = Regexp.new(patterns.fetch("state_target_id_pattern"))

family_ids = Set.new
families.each do |family|
  id = family["id"].to_s
  errors << "invalid action-family ID: #{id}" unless family_id_re.match?(id)
  errors << "duplicate action-family ID: #{id}" unless family_ids.add?(id)

  overlay_name = family["policy_overlay"].to_s
  errors << "#{id}: missing policy overlay" if overlay_name.empty?
  errors << "#{id}: unknown policy overlay #{overlay_name}" unless overlays.key?(overlay_name)

  errors << "#{id}: missing traceability" unless family["traceability"].is_a?(Hash)
  trace = family.fetch("traceability", {})
  requirements = trace.fetch("requirements", {})
  primary = requirements.fetch("primary", [])
  supporting = requirements.fetch("supporting", [])
  errors << "#{id}: primary requirements required" if primary.empty?
  errors << "#{id}: more than five primary requirements" if primary.length > 5
  (primary + supporting).each do |requirement_id|
    errors << "#{id}: invalid requirement ID #{requirement_id}" unless /\AR-[0-9]{3}[A-Z]?\z/.match?(requirement_id.to_s)
  end
  trace.fetch("test_ids", []).each do |test_id|
    errors << "#{id}: invalid test ID #{test_id}" unless test_id_re.match?(test_id.to_s)
  end
  trace.fetch("evidence_ids", []).each do |evidence_id|
    errors << "#{id}: invalid evidence ID #{evidence_id}" unless evidence_id_re.match?(evidence_id.to_s)
  end

  bindings = family.fetch("bindings", {})
  errors << "#{id}: invalid executor ID" unless tool_id_re.match?(bindings.fetch("executor_id", ""))
  errors << "#{id}: invalid state target ID" unless store_id_re.match?(bindings.fetch("state_target_id", ""))
  errors << "#{id}: missing tool contract version" if bindings.fetch("tool_contract_version", "").to_s.empty?

  overlay = overlays.fetch(overlay_name, {})
  side_effect_mode = family.dig("execution", "external_side_effects", "mode") || overlay.dig("external_side_effects", "mode")
  approval_mode = family.dig("approval", "mode") || overlay.dig("approval", "mode")
  approval_binding = family.dig("approval", "binding") || overlay.dig("approval", "binding")
  reconciliation_required = family.dig("reconciliation", "required")
  reconciliation_required = overlay.dig("reconciliation", "required") if reconciliation_required.nil?

  if approval_mode == "always" && approval_binding != "exact_action_fingerprint"
    errors << "#{id}: approval requires exact action fingerprint binding"
  end
  if side_effect_mode == true
    errors << "#{id}: external side effect requires exact fingerprint approval" unless approval_binding == "exact_action_fingerprint"
    errors << "#{id}: external side effect requires reconciliation" unless reconciliation_required == true
    retry_policy = family.dig("reconciliation", "retry_policy") || overlay.dig("reconciliation", "retry_policy")
    errors << "#{id}: external side effect requires no_blind_retry" unless retry_policy == "no_blind_retry"
  end
end

workflow_ids = Set.new
workflows.each do |workflow|
  id = workflow["id"].to_s
  errors << "invalid workflow ID: #{id}" unless workflow_id_re.match?(id)
  errors << "duplicate workflow ID: #{id}" unless workflow_ids.add?(id)
  workflow.fetch("steps", []).each do |step|
    ref = step["action_family"].to_s
    errors << "#{id}: unknown action family #{ref}" unless family_ids.include?(ref)
  end
end

finalize = families.find { |item| item["id"] == "AM-012" }
send_quote = families.find { |item| item["id"] == "AM-013" }
errors << "AM-012 must not have external side effects" unless finalize&.dig("execution", "external_side_effects", "mode") == false
errors << "AM-013 must be an external side effect" unless send_quote&.dig("execution", "external_side_effects", "mode") == true

abort errors.join("\n") unless errors.empty?

rows = families.sort_by do |family|
  classification = family.fetch("classification")
  [classification.fetch("domains").join(","), classification.fetch("capability"), family.fetch("id")]
end

lines = []
lines << "<!-- GENERATED FILE: do not edit manually. -->"
lines << "# Jarvis Action Map"
lines << ""
lines << "Generated from `#{REGISTRY}`. This view is non-authoritative."
lines << ""
lines << "| ID | Action | Domain | Capability | Overlay | Effect | Approval | External side effect | Reconciliation |"
lines << "|---|---|---|---|---|---|---|---|---|"
rows.each do |family|
  overlay = overlays.fetch(family.fetch("policy_overlay"))
  effect = family.dig("policy_overrides", "effect_class") || overlay.fetch("effect_class")
  approval = family.dig("approval", "mode") || overlay.dig("approval", "mode")
  side_effect = family.dig("execution", "external_side_effects", "mode")
  reconciliation = family.dig("reconciliation", "required")
  reconciliation = overlay.dig("reconciliation", "required") if reconciliation.nil?
  classification = family.fetch("classification")
  lines << "| #{family.fetch("id")} | #{family.fetch("name")} | #{classification.fetch("domains").join(", ")} | #{classification.fetch("capability")} | #{family.fetch("policy_overlay")} | #{effect} | #{approval} | #{side_effect} | #{reconciliation} |"
end

unless workflows.empty?
  lines << ""
  lines << "## Workflows"
  lines << ""
  workflows.each do |workflow|
    steps = workflow.fetch("steps").map { |step| step.fetch("action_family") }.join(" → ")
    lines << "- **#{workflow.fetch("id")} — #{workflow.fetch("name")}:** #{steps}"
  end
end

rendered = lines.join("\n") + "\n"
if CHECK_ONLY
  abort "#{OUTPUT} is missing; run ruby scripts/generate-action-map.rb" unless File.file?(OUTPUT)
  abort "#{OUTPUT} is stale; regenerate it" unless File.read(OUTPUT) == rendered
  puts "Action-family registry and generated action map validated."
else
  File.write(OUTPUT, rendered)
  puts "Generated #{OUTPUT}."
end
