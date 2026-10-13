# opencode-copilot-quota

An [opencode](https://opencode.ai) TUI plugin that shows your **GitHub Copilot premium quota** in the session sidebar, so you know whether you will make it to the end of the month.

Works with **opencode 1.x** and **opencode 2.x** (same package).

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

## Installation

### opencode 2.x

Add the plugin to the CLI settings, `~/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-copilot-quota"]
}
```

With options:

```json
{
  "plugins": [{ "package": "opencode-copilot-quota", "options": { "language": "fr" } }]
}
```

Valid edits of `cli.json` are reloaded while the TUI is running.

### opencode 1.x

Add the plugin to the TUI config, `~/.config/opencode/tui.json` (global) or `.opencode/tui.json` (project). This is a separate file from `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-copilot-quota"]
}
```

With options (tuple form):

```json
{
  "plugin": [["opencode-copilot-quota", { "language": "fr" }]]
}
```

Restart opencode.

The block appears in the right sidebar of any session (it is shown when the terminal is wide enough; on 1.x it can be toggled with the `session.sidebar.toggle` keybind).

### Without npm

Clone the repository, then reference the directory:

- **opencode 2.x**: `"plugins": ["/path/to/opencode-copilot-quota"]` in `cli.json`, or put the clone in `~/.config/opencode/plugins/`. No build needed (the root `tui.ts` is loaded).
- **opencode 1.x**: run `npm install && npm run build`, then `"plugin": ["/path/to/opencode-copilot-quota"]` in `tui.json`. Alternatively, reference the source file directly: `"plugin": ["/path/to/opencode-copilot-quota/src/tui.tsx"]`.

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

| opencode | Location                                                                          |
| -------- | --------------------------------------------------------------------------------- |
| 1.x      | `~/.local/share/opencode/auth.json`                                               |
| 2.x      | `credential` table of `~/.local/share/opencode/opencode.db` (opened read-only)    |

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
npm run build      # compiles src/tui.tsx -> dist/tui.js
```

A single module serves both plugin APIs. Its default export is `{ id, tui, setup }`:

- opencode 1.x calls `tui(api, options)` ([`@opencode-ai/plugin/tui`](https://www.npmjs.com/package/@opencode-ai/plugin))
- opencode 2.x calls `setup(context)` ([`@opencode/plugin/tui`](https://www.npmjs.com/package/@opencode/plugin))

Each loader ignores the other key. Both adapters feed the same host-independent core (`start()` in [`src/tui.tsx`](src/tui.tsx)).

opencode 1.x only applies its Solid JSX transform to local files, not to packages in `node_modules`, so the published package ships a precompiled `dist/tui.js` (Babel + `babel-preset-solid` in `universal` mode targeting `@opentui/solid`). At runtime, opencode resolves `@opentui/solid` and `solid-js` to its own copies, so the plugin has no runtime dependencies.

## License

MIT
