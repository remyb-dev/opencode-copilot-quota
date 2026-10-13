# opencode-copilot-quota

An [opencode](https://opencode.ai) TUI plugin that shows your **GitHub Copilot premium quota** in the session sidebar, so you know whether you will make it to the end of the month.

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

- opencode **≥ 1.17** (TUI plugin support)
- The `github-copilot` provider connected in opencode (`/connect` → GitHub Copilot)

## Installation

Add the plugin to your **TUI** config, `~/.config/opencode/tui.json` (global) or `.opencode/tui.json` (project). This is a separate file from `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-copilot-quota"]
}
```

Restart opencode. The block appears in the right sidebar of any session (toggle the sidebar with the `session.sidebar.toggle` keybind).

### As a local file (without npm)

Copy [`src/tui.tsx`](src/tui.tsx) anywhere (for example `~/.config/opencode/tui-plugins/copilot-quota.tsx`) and reference it by path. opencode compiles local `.tsx` files itself:

```json
{
  "plugin": ["./tui-plugins/copilot-quota.tsx"]
}
```

## Options

Use the tuple form to pass options:

```json
{
  "plugin": [["opencode-copilot-quota", { "language": "fr", "refreshMinutes": 10 }]]
}
```

| Option           | Default       | Description                                                                       |
| ---------------- | ------------- | --------------------------------------------------------------------------------- |
| `language`       | auto (`en`)   | `"en"` or `"fr"`. Auto-detected from `LC_ALL` / `LC_MESSAGES` / `LANG` / `Intl`.  |
| `refreshMinutes` | `5`           | Periodic refresh interval.                                                        |
| `minGapSeconds`  | `30`          | Minimum delay between two refreshes triggered by session activity.                |
| `order`          | `50`          | Position in the sidebar (lower = higher).                                         |

## When is the data refreshed?

1. When opencode starts
2. Every `refreshMinutes`
3. After each assistant response (`session.idle` event), at most once every `minGapSeconds`

GitHub itself may take a little while to account for the latest requests, so the figure can lag by one or two responses. On network errors the last known value is kept.

## How it works

The plugin reads the Copilot OAuth token that opencode already stores in `~/.local/share/opencode/auth.json` (or `$XDG_DATA_HOME/opencode/auth.json`) and calls:

```
GET https://api.github.com/copilot_internal/user
```

It uses `quota_snapshots.premium_interactions` (`entitlement`, `remaining`, `credits_used`, `percent_remaining`, `overage_count`) and `quota_reset_date_utc`. The token is never sent anywhere else.

The daily usage is `credits used / days elapsed since the period start`, and the projection extrapolates that rate to the reset date.

> ⚠️ `copilot_internal/user` is an **undocumented** GitHub endpoint (the one used by the official editor extensions). It may change without notice.

## Development

```sh
npm install
npm run typecheck
npm run build      # compiles src/tui.tsx -> dist/tui.js
```

opencode only applies its Solid JSX transform to local files, not to packages in `node_modules`, so the published package ships a precompiled `dist/tui.js` (Babel + `babel-preset-solid` in `universal` mode targeting `@opentui/solid`). At runtime, opencode resolves `@opentui/solid` and `solid-js` to its own copies, so the plugin has no runtime dependencies.

To try local changes, point your `tui.json` at the source file:

```json
{
  "plugin": [["/absolute/path/to/opencode-copilot-quota/src/tui.tsx", { "language": "fr" }]]
}
```

## License

MIT
