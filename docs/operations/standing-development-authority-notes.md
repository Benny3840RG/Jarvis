# Implementation boundary

This control-plane change is intentionally implemented on a normal reviewed branch rather than by `jarvis-autobuild.yml`, because the autonomous worker must not be able to rewrite the workflow and guard code that define its own authority.

After this change lands, ordinary Development missions should remain inside the governed autonomous path and require owner input only at the real authority boundaries described in `standing-development-authority.md`.
