# Jarvis State Glossary

This glossary is normative. States are entity-specific and must not be transferred between unrelated entity classes.

| State | Applies to | Meaning | Valid predecessors | Valid successors | Terminal | Transition owner | Approval needed | Audit required |
|---|---|---|---|---|---|---|---|---|
| Pending | Execution, task, plan step | Accepted but not completed | Proposed, Approved | Active, Failed, Cancelled, Indeterminate | No | Owning workflow service | Depends on action | Yes |
| Partial | Execution, workflow | Some steps succeeded and others did not | Active, Executing | Reconciled, Compensated, Failed | No | Orchestrator | Possibly | Yes |
| Failed | Execution, transition attempt | Confirmed unsuccessful | Pending, Active, Executing | Retried, Compensated, Closed | Usually | Owning service | Retry may require approval | Yes |
| Indeterminate | External execution | Outcome cannot yet be proven | Executing | Reconciled | No | Reconciliation service | No automatic retry | Yes |
| Reconciled | External execution | Indeterminate result has been resolved | Indeterminate | Succeeded, Failed, Compensated | Usually | Reconciliation service | Depends on follow-up | Yes |
| Consumed | Approval | Authorised action used the approval | Approved | None | Yes | Approval service | No | Yes |
| Revoked | Approval, standing authorisation | Withdrawn before further use | Pending, Approved | None | Yes | User or policy service | User or policy action | Yes |
| Expired | Approval, session, credential reference | No longer valid due to time or condition | Pending, Approved, Active | None or Renewed | Usually | Lifecycle service | Renewal may require approval | Yes |
| Superseded | Plan, approval, policy | Replaced by a newer authoritative version | Draft, Pending, Approved, Active | None | Yes | Owning versioned service | Depends on replacement | Yes |
| Compensated | Execution | A corrective action addressed an earlier side effect | Partial, Failed, Reconciled | Closed | Usually | Orchestrator | Often | Yes |

## Rules

- Every entity state machine must define its own complete transition table.
- Invalid transitions must fail without changing authoritative state.
- Transition records must include actor, timestamp, prior state, new state, policy version, and correlation ID.
- Similar words do not imply interchangeable semantics across entity classes.
