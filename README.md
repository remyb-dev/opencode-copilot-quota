# opencode-copilot-quota

An [opencode](https://opencode.ai) TUI plugin that shows your **GitHub Copilot premium quota** in the session sidebar, so you know whether you will make it to the end of the month.

Works with **opencode 1.x** and **opencode 2.x**.

```
Copilot (business)
██████████████████░░░░░░
22 679 / 30 000 remaining (76%)
Reset Nov 1 · 19 d
Budget/day 1 237 · usage/day 578
End-of-month projection 17 917
```

- **Progress bar**: green when on track, yellow when you consume faster than the calendar, red below 10%
- **Remaining / total credits** and percentage
- **Reset date** and days left in the billing period
- **Daily budget** (what you can spend per day until the reset) vs. your **actual daily usage**
- **Projection** at the end of the period, or a warning `Runs out in ~N d at current pace`
- Overage count when relevant
- English and French UI

> Copilot does not expose a raw token balance. Plans with token-based billing are measured in **premium credits** (computed from tokens consumed and model multipliers), which is what this plugin displays.

## Requirements

- opencode **≥ 1.17** (1.x TUI plugins) or **2.x**
- The `github-copilot` provider connected in opencode (`/connect` → GitHub Copilot)
- `git`

## Installation

The plugin is not published on npm. Clone the repository anywhere, for example:

```sh
git clone https://github.com/remyb-dev/opencode-copilot-quota.git ~/.local/share/opencode-copilot-quota
```

No `npm install` or build step is needed: opencode compiles the TypeScript/JSX source itself. Then reference the clone in the opencode config of your version, using an **absolute path** (`~` is not expanded).

### opencode 2.x

In `~/.config/opencode/cli.json`, reference the **directory**:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/Users/me/.local/share/opencode-copilot-quota",
      "options": { "language": "fr" }
    }
  ]
}
```

Valid edits of `cli.json` are reloaded while the TUI is running.

### opencode 1.x

In `~/.config/opencode/tui.json` (global) or `.opencode/tui.json` (project), reference the **`src/tui.tsx` file**. This is a separate file from `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["/Users/me/.local/share/opencode-copilot-quota/src/tui.tsx", { "language": "fr" }]]
}
```

Without options: `"plugin": ["/Users/me/.local/share/opencode-copilot-quota/src/tui.tsx"]`. Restart opencode afterwards.

The block appears in the right sidebar of any session (it is shown when the terminal is wide enough; on 1.x it can be toggled with the `session.sidebar.toggle` keybind).

### Update

```sh
git -C ~/.local/share/opencode-copilot-quota pull
```

Then restart opencode (1.x), or wait for the automatic reload (2.x).

## Options

| Option           | Default     | Description                                                                      |
| ---------------- | ----------- | -------------------------------------------------------------------------------- |
| `language`       | auto (`en`) | `"en"` or `"fr"`. Auto-detected from `LC_ALL` / `LC_MESSAGES` / `LANG` / `Intl`. |
| `refreshMinutes` | `5`         | Periodic refresh interval.                                                       |
| `minGapSeconds`  | `30`        | Minimum delay between two refreshes triggered by session activity.               |
| `order`          | `50`        | Position in the sidebar, lower = higher (opencode 1.x only).                     |

## When is the data refreshed?

1. When opencode starts
2. Every `refreshMinutes`
3. After each assistant response (`session.idle` on 1.x, `session.execution.succeeded` / `failed` on 2.x), at most once every `minGapSeconds`

GitHub itself may take a little while to account for the latest requests, so the figure can lag by one or two responses. On network errors the last known value is kept.

## How it works

The plugin reuses the Copilot OAuth token that opencode already stores locally:

| opencode | Location                                                                       |
| -------- | ------------------------------------------------------------------------------ |
| 1.x      | `~/.local/share/opencode/auth.json`                                            |
| 2.x      | `credential` table of `~/.local/share/opencode/opencode.db` (opened read-only) |

`$XDG_DATA_HOME` and `$OPENCODE_DB` are honored. Both locations are tried, and the `COPILOT_QUOTA_TOKEN` environment variable overrides them. With opencode 2.x connected to a **remote** server, the credentials are not on your machine: set `COPILOT_QUOTA_TOKEN`.

It then calls:

```
GET https://api.github.com/copilot_internal/user
```

and uses `quota_snapshots.premium_interactions` (`entitlement`, `remaining`, `credits_used`, `percent_remaining`, `overage_count`) and `quota_reset_date_utc`. The token is never sent anywhere else.

The daily usage is `credits used / days elapsed since the period start`, and the projection extrapolates that rate to the reset date.

> ⚠️ `copilot_internal/user` is an **undocumented** GitHub endpoint (the one used by the official editor extensions). It may change without notice.

## Development

```sh
npm install
npm run typecheck
npm run build      # optional: compiles src/tui.tsx -> dist/tui.js
```

A single module serves both plugin APIs. Its default export is `{ id, tui, setup }`:

- opencode 1.x calls `tui(api, options)` (`@opencode-ai/plugin/tui`)
- opencode 2.x calls `setup(context)` (`@opencode/plugin/tui`)

Each loader ignores the other key. Both adapters feed the same host-independent core (`start()` in [`src/tui.tsx`](src/tui.tsx)).

Entry points:

| File           | Used by                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------- |
| `src/tui.tsx`  | opencode 1.x when referenced as a file                                                        |
| `tui.ts`       | opencode 2.x when the directory is referenced (re-exports `src/tui.tsx`)                       |
| `dist/tui.js`  | `./tui` export in `package.json`, used if the directory is installed as a package (needs `npm run build`) |

`npm run build` precompiles the JSX with Babel + `babel-preset-solid` (`universal` mode, targeting `@opentui/solid`), because opencode 1.x does not transform JSX inside `node_modules`. At runtime, opencode resolves `@opentui/solid` and `solid-js` to its own copies, so the plugin has no runtime dependencies.

## License

MIT
