from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OPENAPI = ROOT / "typescript/openapi/jarvis.openapi.json"
HTTP_TEST = ROOT / "typescript/tests/http.test.ts"


def mcp(*, read_only: bool, destructive: bool, idempotent: bool) -> dict:
    return {
        "exposed": False,
        "annotations": {
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "openWorldHint": False,
            "idempotentHint": idempotent,
        },
    }


def path_parameter(name: str) -> dict:
    return {
        "name": name,
        "in": "path",
        "required": True,
        "schema": {"type": "string", "minLength": 1, "maxLength": 128},
    }


def response(description: str, schema: str, status: str = "200") -> dict:
    return {
        status: {
            "description": description,
            "headers": {"X-Request-Id": {"$ref": "#/components/headers/RequestId"}},
            "content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{schema}"}}},
        },
        "401": {"$ref": "#/components/responses/Unauthorized"},
        "404": {"$ref": "#/components/responses/NotFound"},
        "409": {"$ref": "#/components/responses/Conflict"},
        "422": {"$ref": "#/components/responses/UnprocessableEntity"},
        "503": {"$ref": "#/components/responses/ServiceUnavailable"},
        "500": {"$ref": "#/components/responses/InternalServerError"},
    }


def request_body(schema: str) -> dict:
    return {
        "required": True,
        "content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{schema}"}}},
    }


with OPENAPI.open(encoding="utf-8") as source:
    contract = json.load(source)

contract["info"]["version"] = "0.4.0"
contract["info"]["description"] = (
    "Jarvis accepts structured operator requests, routes work through its runtime and safety "
    "envelope, persists tasks and reminders through the configured JSON or Convex provider, can "
    "run proposal-only Totality reasoning, and now stages revision-checked project-memory change "
    "sets for explicit approval and transactional Convex apply. This contract is intentionally "
    "single-user and private. The future ChatGPT App MCP server must keep Jarvis and OpenAI service "
    "credentials server-side and expose only operations marked with x-mcp-tool.exposed=true."
)
if not any(tag.get("name") == "Memory" for tag in contract["tags"]):
    contract["tags"].append(
        {
            "name": "Memory",
            "description": "Staged, revision-checked project-memory approval and apply operations.",
        }
    )

rest_only = contract["x-chatgpt-app"]["restOnlyOperationIds"]
for operation_id in [
    "stageMemoryChangeSet",
    "listMemoryChangeSets",
    "getMemoryChangeSet",
    "approveMemoryChangeSet",
    "rejectMemoryChangeSet",
    "applyMemoryChangeSet",
]:
    if operation_id not in rest_only:
        rest_only.append(operation_id)

schemas = contract["components"]["schemas"]
string_id = {"type": "string", "minLength": 1, "maxLength": 128}
canonical_time = {"type": "string", "format": "date-time"}

schemas.update(
    {
        "MemoryFact": {
            "type": "object",
            "additionalProperties": False,
            "required": ["kind", "recordId", "statement", "source", "confidence", "recordedAt"],
            "properties": {
                "kind": {"const": "fact"},
                "recordId": string_id,
                "statement": {"type": "string", "minLength": 1},
                "source": {"type": "string", "enum": ["user", "file", "tool", "measurement", "inference"]},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "recordedAt": canonical_time,
            },
        },
        "MemoryAssumption": {
            "type": "object",
            "additionalProperties": False,
            "required": ["kind", "recordId", "statement", "status", "impact"],
            "properties": {
                "kind": {"const": "assumption"},
                "recordId": string_id,
                "statement": {"type": "string", "minLength": 1},
                "status": {"type": "string", "enum": ["unverified", "verified", "rejected"]},
                "impact": {"type": "string", "enum": ["low", "medium", "high"]},
            },
        },
        "MemoryMeasurement": {
            "type": "object",
            "additionalProperties": False,
            "required": ["kind", "recordId", "name", "value", "unit", "source"],
            "properties": {
                "kind": {"const": "measurement"},
                "recordId": string_id,
                "name": {"type": "string", "minLength": 1},
                "value": {"type": "number"},
                "unit": {"type": "string", "minLength": 1},
                "tolerance": {"type": "string", "minLength": 1},
                "source": {"type": "string", "minLength": 1},
            },
        },
        "MemoryDecision": {
            "type": "object",
            "additionalProperties": False,
            "required": ["kind", "recordId", "decision", "rationale", "alternativesRejected", "timestamp"],
            "properties": {
                "kind": {"const": "decision"},
                "recordId": string_id,
                "decision": {"type": "string", "minLength": 1},
                "rationale": {"type": "string", "minLength": 1},
                "alternativesRejected": {"type": "array", "items": {"type": "string"}, "maxItems": 50},
                "timestamp": canonical_time,
            },
        },
        "MemoryRecord": {
            "oneOf": [
                {"$ref": "#/components/schemas/MemoryFact"},
                {"$ref": "#/components/schemas/MemoryAssumption"},
                {"$ref": "#/components/schemas/MemoryMeasurement"},
                {"$ref": "#/components/schemas/MemoryDecision"},
            ]
        },
        "MemoryChangeSet": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "changeSetId", "requestId", "projectId", "baseRevision", "state", "records",
                "rationale", "proposedBy", "createdAt", "updatedAt"
            ],
            "properties": {
                "changeSetId": string_id,
                "requestId": string_id,
                "projectId": string_id,
                "baseRevision": {"type": "integer", "minimum": 1},
                "state": {"type": "string", "enum": ["proposed", "approved", "rejected", "applied"]},
                "records": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"$ref": "#/components/schemas/MemoryRecord"}},
                "rationale": {"type": "string", "minLength": 1},
                "proposedBy": {"type": "string", "enum": ["user", "agent", "tool"]},
                "approvedBy": {"const": "user"},
                "rejectedBy": {"const": "user"},
                "rejectedReason": {"type": "string", "minLength": 1},
                "createdAt": canonical_time,
                "updatedAt": canonical_time,
                "approvedAt": canonical_time,
                "rejectedAt": canonical_time,
                "appliedAt": canonical_time,
                "appliedRevision": {"type": "integer", "minimum": 2},
            },
        },
        "StageMemoryChangeSetRequest": {
            "type": "object",
            "additionalProperties": False,
            "required": ["changeSetId", "expectedRevision", "records", "rationale", "proposedBy"],
            "properties": {
                "changeSetId": string_id,
                "expectedRevision": {"type": "integer", "minimum": 1},
                "records": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"$ref": "#/components/schemas/MemoryRecord"}},
                "rationale": {"type": "string", "minLength": 1},
                "proposedBy": {"type": "string", "enum": ["user", "agent", "tool"]},
            },
        },
        "ExpectedRevisionRequest": {
            "type": "object",
            "additionalProperties": False,
            "required": ["expectedRevision"],
            "properties": {"expectedRevision": {"type": "integer", "minimum": 1}},
        },
        "RejectMemoryChangeSetRequest": {
            "type": "object",
            "additionalProperties": False,
            "required": ["reason"],
            "properties": {"reason": {"type": "string", "minLength": 1}},
        },
        "MemoryChangeSetList": {
            "type": "array",
            "items": {"$ref": "#/components/schemas/MemoryChangeSet"},
        },
        "AppliedMemoryRecord": {
            "type": "object",
            "additionalProperties": False,
            "required": ["recordId", "projectId", "kind", "record", "updatedAt"],
            "properties": {
                "recordId": string_id,
                "projectId": string_id,
                "kind": {"type": "string", "enum": ["fact", "assumption", "measurement", "decision"]},
                "record": {"$ref": "#/components/schemas/MemoryRecord"},
                "updatedAt": canonical_time,
            },
        },
        "ApplyMemoryChangeSetResult": {
            "type": "object",
            "additionalProperties": False,
            "required": ["changeSet", "projectRevision", "records", "idempotent"],
            "properties": {
                "changeSet": {"$ref": "#/components/schemas/MemoryChangeSet"},
                "projectRevision": {"type": "integer", "minimum": 1},
                "records": {"type": "array", "items": {"$ref": "#/components/schemas/AppliedMemoryRecord"}},
                "idempotent": {"type": "boolean"},
            },
        },
    }
)

project_param = path_parameter("projectId")
change_param = path_parameter("changeSetId")
paths = contract["paths"]
base_path = "/api/v1/projects/{projectId}/memory-change-sets"
item_path = f"{base_path}/{{changeSetId}}"

paths[base_path] = {
    "get": {
        "operationId": "listMemoryChangeSets",
        "summary": "List staged project-memory change sets",
        "description": "Lists bounded, owner-scoped memory change sets, optionally filtered by state.",
        "tags": ["Memory"],
        "parameters": [
            project_param,
            {"name": "state", "in": "query", "schema": {"type": "string", "enum": ["proposed", "approved", "rejected", "applied"]}},
            {"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 25}},
        ],
        "x-mcp-tool": mcp(read_only=True, destructive=False, idempotent=True),
        "responses": response("Current project-memory change sets.", "MemoryChangeSetList"),
    },
    "post": {
        "operationId": "stageMemoryChangeSet",
        "summary": "Stage typed project-memory changes for explicit approval",
        "description": "Stages one idempotent change set against the current project revision without writing canonical memory.",
        "tags": ["Memory"],
        "parameters": [project_param],
        "x-mcp-tool": mcp(read_only=False, destructive=False, idempotent=True),
        "requestBody": request_body("StageMemoryChangeSetRequest"),
        "responses": response("Memory change set staged.", "MemoryChangeSet", "201"),
    },
}

paths[item_path] = {
    "get": {
        "operationId": "getMemoryChangeSet",
        "summary": "Inspect one project-memory change set",
        "description": "Returns one staged memory change set without modifying its state.",
        "tags": ["Memory"],
        "parameters": [project_param, change_param],
        "x-mcp-tool": mcp(read_only=True, destructive=False, idempotent=True),
        "responses": response("Memory change set.", "MemoryChangeSet"),
    }
}

for suffix, operation_id, summary, body_schema, result_schema, destructive in [
    ("approve", "approveMemoryChangeSet", "Approve a revision-matched project-memory change set", "ExpectedRevisionRequest", "MemoryChangeSet", False),
    ("reject", "rejectMemoryChangeSet", "Reject a staged project-memory change set", "RejectMemoryChangeSetRequest", "MemoryChangeSet", False),
    ("apply", "applyMemoryChangeSet", "Transactionally apply an approved project-memory change set", "ExpectedRevisionRequest", "ApplyMemoryChangeSetResult", True),
]:
    paths[f"{item_path}/{suffix}"] = {
        "post": {
            "operationId": operation_id,
            "summary": summary,
            "description": (
                "Applies all approved records, increments the project revision, and appends audit evidence in one Convex transaction."
                if suffix == "apply"
                else f"Transitions the memory change set to {suffix}d without writing canonical memory."
            ),
            "tags": ["Memory"],
            "parameters": [project_param, change_param],
            "x-mcp-tool": mcp(read_only=False, destructive=destructive, idempotent=True),
            "requestBody": request_body(body_schema),
            "responses": response(f"Memory change set {suffix} result.", result_schema),
        }
    }

with OPENAPI.open("w", encoding="utf-8") as target:
    json.dump(contract, target, indent=2)
    target.write("\n")

text = HTTP_TEST.read_text(encoding="utf-8")
capability_marker = '''        {
          operationId: "reasonWithTotality",
          summary: "Run proposal-only Totality reasoning with validation and audit journalling",
          mutating: true,
          destructive: false,
          mcpExposed: false,
        },
'''
capability_addition = capability_marker + '''        {
          operationId: "stageMemoryChangeSet",
          summary: "Stage typed project-memory changes for explicit approval",
          mutating: true,
          destructive: false,
          mcpExposed: false,
        },
        {
          operationId: "listMemoryChangeSets",
          summary: "List staged project-memory change sets",
          mutating: false,
          destructive: false,
          mcpExposed: false,
        },
        {
          operationId: "getMemoryChangeSet",
          summary: "Inspect one project-memory change set",
          mutating: false,
          destructive: false,
          mcpExposed: false,
        },
        {
          operationId: "approveMemoryChangeSet",
          summary: "Approve a revision-matched project-memory change set",
          mutating: true,
          destructive: false,
          mcpExposed: false,
        },
        {
          operationId: "rejectMemoryChangeSet",
          summary: "Reject a staged project-memory change set",
          mutating: true,
          destructive: false,
          mcpExposed: false,
        },
        {
          operationId: "applyMemoryChangeSet",
          summary: "Transactionally apply an approved project-memory change set",
          mutating: true,
          destructive: true,
          mcpExposed: false,
        },
'''
if 'operationId: "stageMemoryChangeSet"' not in text:
    text = text.replace(capability_marker, capability_addition)

routes_marker = '''      ["/api/v1/status", "get"],
      ["/api/v1/totality/reason", "post"],
'''
routes_addition = routes_marker + '''      ["/api/v1/projects/{projectId}/memory-change-sets", "post"],
      ["/api/v1/projects/{projectId}/memory-change-sets", "get"],
      ["/api/v1/projects/{projectId}/memory-change-sets/{changeSetId}", "get"],
      ["/api/v1/projects/{projectId}/memory-change-sets/{changeSetId}/approve", "post"],
      ["/api/v1/projects/{projectId}/memory-change-sets/{changeSetId}/reject", "post"],
      ["/api/v1/projects/{projectId}/memory-change-sets/{changeSetId}/apply", "post"],
'''
if 'memory-change-sets/{changeSetId}/apply' not in text:
    text = text.replace(routes_marker, routes_addition)
HTTP_TEST.write_text(text, encoding="utf-8")
