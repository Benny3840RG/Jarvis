# Branch protection for `main`

Branch protection on `main` cannot be configured from a pull request or workflow file. It must be applied by the repository owner through GitHub's repository settings.

## Required settings

Navigate to **Settings → Branches → Branch protection rules → Add rule** for `main` and enable:

| Setting | Value | Reason |
| --- | --- | --- |
| Require a pull request before merging | Enabled | Prevents direct pushes to main |
| Require status checks to pass before merging | Enabled | Enforces CI gate |
| Require branches to be up to date before merging | Enabled | Prevents stale-branch merges |
| Do not allow bypassing the above settings | Enabled | Prevents override by administrators |
| Allow force pushes | Disabled | Protects commit history |
| Allow deletions | Disabled | Protects the branch |

## Required status checks

Once the TypeScript checks workflow is consistently green, add the following check as required:

| Check name | Workflow |
| --- | --- |
| `typecheck-lint-format-test` | `.github/workflows/typescript.yml` |

The Python checks workflow (`python-tests`) should also be added if Python changes are expected to continue.

## Rationale

The audit identified that `main` has no branch protection rules. Without them:

- code that fails the TypeScript check can land directly on `main`,
- force-pushes can silently overwrite commit history,
- and there is no merge gate to enforce the commissioning workflow.

Enabling protection ensures that only code that passes the full verification gate (`npm run check`) can reach `main`, and that the commissioning workflow remains the correct path for deploying to the development stack.

## What this PR cannot do

GitHub branch protection rules are not stored in repository files. They are a GitHub-level repository setting. This document serves as the authoritative record of the intended protection configuration until the repository owner applies it through the GitHub UI.

See also: [GitHub documentation on branch protection rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule).
