/**
 * opencode-copilot-quota
 *
 * Shows the GitHub Copilot premium quota in the opencode session sidebar.
 *
 * One module, two hosts:
 * - opencode 1.x loads `default.tui(api, options)`   (TUI plugin API v1)
 * - opencode 2.x loads `default.setup(context)`      (CLI plugin API v2)
 * Each loader ignores the other's key, so the same file works on both.
 */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { createSignal, Show, type Accessor } from "solid-js"
import { existsSync } from "fs"
import { readFile } from "fs/promises"
import { homedir } from "os"
import { isAbsolute, join } from "path"

const PLUGIN_ID = "copilot-quota"

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

type Language = "en" | "fr"

type Options = {
  /** Periodic refresh interval, in minutes (default: 5) */
  refreshMinutes: number
  /** Minimum delay between two fetches triggered by session activity, in seconds (default: 30) */
  minGapSeconds: number
  /** UI language (default: auto-detected from LANG / Intl, fallback "en") */
  language: Language
  /** Sidebar slot order on opencode 1.x, lower = higher in the sidebar (default: 50) */
  order: number
}

function detectLanguage(): Language {
  const candidates = [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ]
  for (const c of candidates) {
    if (!c || c.startsWith("C") || c === "POSIX") continue
    return c.toLowerCase().startsWith("fr") ? "fr" : "en"
  }
  return "en"
}

function resolveOptions(raw: Readonly<Record<string, unknown>> | undefined): Options {
  const num = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : def)
  const lang = raw?.language === "fr" || raw?.language === "en" ? (raw.language as Language) : detectLanguage()
  return {
    refreshMinutes: num(raw?.refreshMinutes, 5),
    minGapSeconds: num(raw?.minGapSeconds, 30),
    language: lang,
    order: num(raw?.order, 50),
  }
}

/* -------------------------------------------------------------------------- */
/* i18n                                                                       */
/* -------------------------------------------------------------------------- */

const MESSAGES = {
  en: {
    locale: "en-US",
    loading: "Loading…",
    noAuth: "Not connected to github-copilot (run /connect)",
    noQuota: "Premium quota not found",
    unlimited: "Unlimited",
    remaining: (pct: number) => `remaining (${pct}%)`,
    reset: "Reset",
    days: "d",
    budget: "Budget/day",
    usage: "usage/day",
    runout: (d: number) => `Runs out in ~${d} d at current pace`,
    projection: "End-of-month projection",
    overage: "Overage",
  },
  fr: {
    locale: "fr-FR",
    loading: "Chargement…",
    noAuth: "Pas de connexion github-copilot (/connect)",
    noQuota: "Quota premium introuvable",
    unlimited: "Illimité",
    remaining: (pct: number) => `restants (${pct}%)`,
    reset: "Reset",
    days: "j",
    budget: "Budget/jour",
    usage: "conso/jour",
    runout: (d: number) => `Épuisé dans ~${d} j au rythme actuel`,
    projection: "Projection fin de mois",
    overage: "Dépassement",
  },
} as const

type Messages = (typeof MESSAGES)[Language]

/* -------------------------------------------------------------------------- */
/* Copilot token                                                              */
/* -------------------------------------------------------------------------- */

const COPILOT_IDS = ["github-copilot", "github-copilot-enterprise"]

function dataDir() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode")
}

/** opencode 1.x: credentials live in `<data>/auth.json`. */
async function tokenFromAuthFile(): Promise<string | undefined> {
  try {
    const auth = JSON.parse(await readFile(join(dataDir(), "auth.json"), "utf8"))
    for (const id of COPILOT_IDS) {
      const entry = auth?.[id]
      const token = entry?.refresh || entry?.access || entry?.key
      if (token) return token
    }
  } catch {}
  return undefined
}

/** opencode 2.x: credentials live in the `credential` table of `<data>/opencode.db`. */
async function tokenFromDatabase(): Promise<string | undefined> {
  const configured = process.env.OPENCODE_DB
  const file = configured ? (isAbsolute(configured) ? configured : join(dataDir(), configured)) : join(dataDir(), "opencode.db")
  if (!existsSync(file)) return undefined
  let sqlite: any
  try {
    // @ts-ignore -- Bun-only module (opencode runs on Bun); no types needed
    sqlite = await import("bun:sqlite")
  } catch {
    return undefined
  }
  let db: any
  try {
    db = new sqlite.Database(file, { readonly: true })
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'").get()
    if (!table) return undefined
    const placeholders = COPILOT_IDS.map(() => "?").join(", ")
    const rows: Array<{ value: string }> = db
      .query(
        `SELECT value FROM credential WHERE integration_id IN (${placeholders}) ORDER BY active DESC, time_updated DESC`,
      )
      .all(...COPILOT_IDS)
    for (const row of rows) {
      const value = typeof row.value === "string" ? JSON.parse(row.value) : row.value
      const token = value?.type === "oauth" ? value.refresh || value.access : value?.key
      if (token) return token
    }
  } catch {
  } finally {
    try {
      db?.close()
    } catch {}
  }
  return undefined
}

async function readToken(preferDatabase: boolean): Promise<string | undefined> {
  const env = process.env.COPILOT_QUOTA_TOKEN
  if (env) return env
  const sources = preferDatabase ? [tokenFromDatabase, tokenFromAuthFile] : [tokenFromAuthFile, tokenFromDatabase]
  for (const source of sources) {
    const token = await source()
    if (token) return token
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/* Copilot API                                                                */
/* -------------------------------------------------------------------------- */

type Quota = {
  entitlement: number
  remaining: number
  used: number
  percentRemaining: number
  unlimited: boolean
  overageCount: number
  resetAt: Date
  plan?: string
}

class QuotaError extends Error {
  constructor(
    public code: "noAuth" | "noQuota" | "http",
    message?: string,
  ) {
    super(message ?? code)
  }
}

async function fetchQuota(preferDatabase: boolean): Promise<Quota> {
  const token = await readToken(preferDatabase)
  if (!token) throw new QuotaError("noAuth")
  const res = await fetch("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "Editor-Version": "vscode/1.99.0",
      "X-Github-Api-Version": "2025-04-01",
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new QuotaError("http", `HTTP ${res.status}`)
  const body: any = await res.json()
  const q = body?.quota_snapshots?.premium_interactions
  if (!q) throw new QuotaError("noQuota")
  const entitlement = Number(q.entitlement ?? 0)
  const remaining = Number(q.remaining ?? q.quota_remaining ?? 0)
  return {
    entitlement,
    remaining,
    used: Number(q.credits_used ?? entitlement - remaining),
    percentRemaining: Number(q.percent_remaining ?? (entitlement ? (remaining / entitlement) * 100 : 0)),
    unlimited: Boolean(q.unlimited),
    overageCount: Number(q.overage_count ?? 0),
    resetAt: new Date(body.quota_reset_date_utc ?? body.quota_reset_date),
    plan: body.copilot_plan,
  }
}

/* -------------------------------------------------------------------------- */
/* Computations                                                               */
/* -------------------------------------------------------------------------- */

const BAR_WIDTH = 24
const DAY = 86_400_000

function bar(ratio: number) {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(ratio * BAR_WIDTH)))
  return { full: "█".repeat(filled), empty: "░".repeat(BAR_WIDTH - filled) }
}

function stats(q: Quota) {
  const now = Date.now()
  const daysLeft = Math.max(0, (q.resetAt.getTime() - now) / DAY)
  // billing period start = reset date - 1 month
  const start = new Date(q.resetAt)
  start.setUTCMonth(start.getUTCMonth() - 1)
  const periodDays = (q.resetAt.getTime() - start.getTime()) / DAY
  const elapsedDays = Math.max(0.5, (now - start.getTime()) / DAY)
  const perDayUsed = q.used / elapsedDays
  const perDayBudget = daysLeft > 0 ? q.remaining / daysLeft : q.remaining
  const projected = q.used + perDayUsed * daysLeft
  const runoutDays = perDayUsed > 0 ? q.remaining / perDayUsed : Infinity
  return { daysLeft, periodDays, perDayUsed, perDayBudget, projected, runoutDays }
}

/* -------------------------------------------------------------------------- */
/* Host-independent core                                                      */
/* -------------------------------------------------------------------------- */

type Colors = {
  text: RGBA
  muted: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
}

/** What the core needs from opencode, implemented once per plugin API version. */
type Host = {
  options: Readonly<Record<string, unknown>> | undefined
  /** Where to look for the Copilot token first. */
  preferDatabase: boolean
  colors: () => Colors
  /** Subscribes to "an assistant turn just finished"; returns an unsubscribe function. */
  onTurnEnd: (handler: () => void) => () => void
  /** Mounts the view in the session sidebar; returns an unmount function when the API provides one. */
  mount: (render: () => JSX.Element, order: number) => (() => void) | void
}

function start(host: Host): () => void {
  const opts = resolveOptions(host.options)
  const t = MESSAGES[opts.language]

  const [quota, setQuota] = createSignal<Quota>()
  const [error, setError] = createSignal<string>()
  let last = 0
  let inflight = false

  const refresh = async (force = false) => {
    if (inflight) return
    if (!force && Date.now() - last < opts.minGapSeconds * 1000) return
    inflight = true
    last = Date.now()
    try {
      setQuota(await fetchQuota(host.preferDatabase))
      setError(undefined)
    } catch (e: any) {
      setError(e instanceof QuotaError && e.code !== "http" ? t[e.code] : (e?.message ?? String(e)))
    } finally {
      inflight = false
    }
  }

  refresh(true)
  const timer = setInterval(() => refresh(true), opts.refreshMinutes * 60 * 1000)
  const unsubscribe = host.onTurnEnd(() => refresh())
  const unmount = host.mount(() => <QuotaView colors={host.colors} quota={quota} error={error} t={t} />, opts.order)

  return () => {
    clearInterval(timer)
    unsubscribe()
    unmount?.()
  }
}

function QuotaView(props: {
  colors: () => Colors
  quota: Accessor<Quota | undefined>
  error: Accessor<string | undefined>
  t: Messages
}) {
  const t = props.t
  const c = () => props.colors()
  const fmt = (n: number) => Math.round(n).toLocaleString(t.locale).replace(/\u202f|\u00a0/g, " ")

  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={c().text}>
        <b>Copilot</b>
        <Show when={props.quota()?.plan}>
          <span style={{ fg: c().muted }}> ({props.quota()!.plan})</span>
        </Show>
      </text>
      <Show
        when={props.quota()}
        fallback={<text fg={props.error() ? c().error : c().muted}>{props.error() ?? t.loading}</text>}
      >
        {(q) => {
          const s = () => stats(q())
          const ratio = () => (q().entitlement ? q().remaining / q().entitlement : 0)
          const color = () => {
            const r = ratio()
            const expected = s().daysLeft / s().periodDays
            if (r < 0.1) return c().error
            if (r < expected * 0.8) return c().warning
            return c().success
          }
          return (
            <Show when={!q().unlimited} fallback={<text fg={c().success}>{t.unlimited}</text>}>
              <text>
                <span style={{ fg: color() }}>{bar(ratio()).full}</span>
                <span style={{ fg: c().muted }}>{bar(ratio()).empty}</span>
              </text>
              <text fg={c().text}>
                {fmt(q().remaining)}{" "}
                <span style={{ fg: c().muted }}>
                  / {fmt(q().entitlement)} {t.remaining(Math.round(q().percentRemaining))}
                </span>
              </text>
              <text fg={c().muted}>
                {t.reset} {q().resetAt.toLocaleDateString(t.locale, { day: "numeric", month: "short" })} ·{" "}
                {Math.ceil(s().daysLeft)} {t.days}
              </text>
              <text fg={c().muted}>
                {t.budget} <span style={{ fg: c().text }}>{fmt(s().perDayBudget)}</span> · {t.usage}{" "}
                <span style={{ fg: c().text }}>{fmt(s().perDayUsed)}</span>
              </text>
              <text fg={s().projected > q().entitlement ? c().warning : c().muted}>
                {s().projected > q().entitlement
                  ? t.runout(Math.floor(s().runoutDays))
                  : `${t.projection} ${fmt(s().projected)}`}
              </text>
              <Show when={q().overageCount > 0}>
                <text fg={c().warning}>
                  {t.overage}: {fmt(q().overageCount)}
                </text>
              </Show>
            </Show>
          )
        }}
      </Show>
    </box>
  )
}

/* -------------------------------------------------------------------------- */
/* opencode 1.x adapter (@opencode-ai/plugin/tui)                             */
/* -------------------------------------------------------------------------- */

const tui: TuiPlugin = async (api, options) => {
  const stop = start({
    options: options as Record<string, unknown> | undefined,
    preferDatabase: false,
    colors: () => {
      const theme = api.theme.current
      return {
        text: theme.text,
        muted: theme.textMuted,
        error: theme.error,
        warning: theme.warning,
        success: theme.success,
      }
    },
    onTurnEnd: (handler) => api.event.on("session.idle", handler),
    mount: (render, order) => {
      api.slots.register({ order, slots: { sidebar_content: () => render() } })
    },
  })
  api.lifecycle.onDispose(stop)
}

/* -------------------------------------------------------------------------- */
/* opencode 2.x adapter (@opencode/plugin/tui)                                */
/* -------------------------------------------------------------------------- */

/**
 * Minimal structural view of the v2 `Plugin.Context` actually used here, so the
 * package does not depend on `@opencode/plugin`.
 */
type V2Feedback = { readonly base: RGBA }
type V2Context = {
  readonly options: Readonly<Record<string, unknown>>
  readonly theme: {
    readonly text: {
      readonly base: RGBA
      readonly muted: RGBA
      readonly feedback: {
        readonly error: V2Feedback
        readonly warning: V2Feedback
        readonly success: V2Feedback
      }
    }
  }
  readonly data: {
    readonly on: (type: string, handler: (event: unknown) => void) => () => void
  }
  readonly ui: {
    readonly slot: (claim: { readonly append: "sidebar.content"; readonly render: (input: unknown) => JSX.Element }) => () => void
  }
}

function setup(context: V2Context) {
  return start({
    options: context.options,
    preferDatabase: true,
    colors: () => {
      const theme = context.theme
      return {
        text: theme.text.base,
        muted: theme.text.muted,
        error: theme.text.feedback.error.base,
        warning: theme.text.feedback.warning.base,
        success: theme.text.feedback.success.base,
      }
    },
    onTurnEnd: (handler) => {
      const stops = ["session.execution.succeeded", "session.execution.failed"].map((type) =>
        context.data.on(type, handler),
      )
      return () => stops.forEach((stop) => stop())
    },
    mount: (render) => context.ui.slot({ append: "sidebar.content", render: () => render() }),
  })
}

/* -------------------------------------------------------------------------- */
/* Module                                                                     */
/* -------------------------------------------------------------------------- */

const plugin: TuiPluginModule & { id: string; setup: typeof setup } = {
  id: PLUGIN_ID,
  tui,
  setup,
}

export default plugin
