# HUD source

The HUD is one self-contained page (MCP `ui://jarvis/dashboard-v1.html` and
HTTP `GET /hud`). Its source lives here in small files so that people and the
automated reviewer can read a change without loading a 530 KB file.

| File                                            | Contents                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `dashboard-v1.template.html`                    | Head and markup. `<!--hud:include …-->` marks where a piece goes.                |
| `styles/NN-name.css`                            | One file per `<style>` block, in page order; `NN-name` follows the block's `id`. |
| `script.js`                                     | The page's single inline script.                                                 |
| `../assets/*.woff2`, `../assets/coast-dusk.jpg` | Fonts and backdrop, inlined as `data:` URLs via `{{hud-asset:…}}`.               |
| `bundle.mjs`                                    | Joins the pieces byte for byte; fails closed on an unknown or unresolved marker. |

Edit the piece you need; nothing is generated, so there is no build step.
`tests/hudBundle.test.ts` checks the assembled page and that no piece passes
160 KB.

`scripts/split-hud.mjs` produced these pieces from the old single file. It is
kept to bring in branches that still edit `src/mcp/dashboard-v1.html`: run it
on that branch's version of the file, and it writes only if the result
re-assembles to exactly that input.
