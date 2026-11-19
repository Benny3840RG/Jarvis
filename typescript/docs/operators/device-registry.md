# NOLAN device registry (#836)

`src/devices/deviceRegistry.ts` is the deny-by-default contract between NOLAN
and physical devices. This first slice is a library only. Nothing in
production loads bindings or registers device tools yet, and the existing
Google Cast announcement tool (`home.announce`) is unchanged.

## Identity

Each device has a stable NOLAN ID of the form `nolan:device:<name>` (lowercase
letters, digits and single hyphens), for example `nolan:device:kitchen-display`.
The ID never changes when the device is re-addressed or re-paired. Those
changes go into the binding instead.

## Enrolment (bindings)

A binding is a strict, declarative record. Unknown fields are rejected.

| Field            | Meaning                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `deviceId`       | The stable NOLAN ID.                                                   |
| `bindingVersion` | Positive integer. Bump it on **every** change to the binding.          |
| `displayName`    | Human name.                                                            |
| `adapter`        | Closed set: `google_cast_local` only.                                  |
| `transportRef`   | Adapter-specific target (for Cast, the allowlisted target name).       |
| `enabled`        | `false` refuses every request without removing the device.             |
| `capabilities`   | Closed set, no repeats: `read_state` (read-only), `announce` (effect). |
| `risk`           | `low`, `medium` or `high`. Sets the minimum approval tier for effects. |
| `enrolment`      | `enrolledBy: "owner"`, `enrolledAt`, and an `evidenceRef`.             |

`evidenceRef` points at the commissioning or owner-decision record that
justified the enrolment. A registry with any invalid binding, or two bindings
for the same ID, is rejected as a whole.

Home Assistant, Grid Connect and Nest are **not** adapters. Grid Connect models
and local API support are unverified, and Home Assistant is not commissioned.
Each needs its own reviewed adapter before it can be enrolled. Do not re-pair or
actuate those devices as part of enrolment.

## What is refused, and where

Every request is checked in this order before any transport call:

1. request shape (`invalid_request`)
2. device enrolled (`unknown_device`)
3. binding enabled (`binding_disabled`)
4. requested `bindingVersion` equals the enrolled one (`binding_version_mismatch`)
5. capability is in the closed set **and** declared by the binding
   (`unsupported_capability`)
6. parameters match that capability's strict schema (`invalid_parameters`)
7. exactly one adapter is registered for the binding's adapter kind
   (`adapter_unavailable`; an ambiguous adapter set is an error)

`readDevice` serves read-only capabilities only. Asking it for an effect
returns `approval_required`. Tests assert zero transport calls for every
refusal.

## Effects and approval

Effects are reachable only through `createDeviceEffectToolDefinition`, which
returns a `ToolExecutionDefinition` (`tool: "device"`, `operation: <capability>`)
for the existing `ToolExecutionService`. Approval, the single-use claim, the
receipt and reconciliation stay with that service. The registry adds no second
approval store or ledger.

The definition **verifies** the approval and never grants it:

- `preflight` re-runs the checks above before the claim, so a refusal spends
  no single-use approval.
- `execute` requires all of the following before the adapter is called:
  - the ToolAction is `approved` by the user and has not expired (checked by
    `approvalExpiresAt` as well as `isApprovalExpired`);
  - it is for `device`/`<capability>`;
  - its arguments are canonically identical to `{ deviceId, bindingVersion,
params }`.
- `execute` then re-checks the binding, because it may have changed or been
  disabled since approval. It also enforces the risk floor: `low` needs T1,
  `medium` needs T2 and `high` needs T3.
- The adapter prepares the exact target and an attempt identity, and the
  attempt is registered with the execution layer **before** the effect.

Because the approval binds the binding version, bumping the version
invalidates every outstanding approval for that device.

## Audit and verification responsibilities

- **Owner:** enrolment, the evidence reference, the risk level, and bumping
  `bindingVersion` on any change.
- **Execution layer:** receipts, the provider attempt, and reconciliation of
  indeterminate outcomes, all existing.
- **Adapter:** must act only on the binding's `transportRef` and the parsed
  parameters. It must not widen the target or accept free-form commands.
- Not covered yet: persisting bindings, production wiring, an HTTP/HUD
  surface, and adapters beyond local Cast. Each is a separate owner-scoped
  follow-up.
