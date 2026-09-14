# Test matrix

| Behaviour | Required proof |
|---|---|
| standing 0.05 budget | workflow contract test |
| optional overrides | workflow contract test |
| ordinary app paths allowed | diff-policy unit test |
| control-plane paths denied | diff-policy unit test |
| authority content denied | patch-policy unit test |
| bounded retry | finalizer unit test |
| hard guard block | finalizer unit test |
| no auto merge/deploy | workflow/diff inspection + CI |
