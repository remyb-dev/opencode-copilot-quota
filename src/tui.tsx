import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, Show } from "solid-js"
import { readFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"

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
  /** Sidebar slot order, lower = higher in the sidebar (default: 50) */
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

function resolveOptions(raw: Record<string, unknown> | undefined): Options {
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
  constructor(public code: "noAuth" | "noQuota" | "http", message?: string) {
    super(message ?? code)
  }
}

function authPath() {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(data, "opencode", "auth.json")
}

async function readToken(): Promise<string | undefined> {
  const auth = JSON.parse(await readFile(authPath(), "utf8"))
  const entry = auth["github-copilot"] ?? auth["github-copilot-enterprise"]
  return entry?.refresh || entry?.access
}

async function fetchQuota(): Promise<Quota> {
  const token = await readToken().catch(() => undefined)
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
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

const tui: TuiPlugin = async (api, rawOptions) => {
  const opts = resolveOptions(rawOptions as Record<string, unknown> | undefined)
  const t = MESSAGES[opts.language]
  const fmt = (n: number) => Math.round(n).toLocaleString(t.locale).replace(/\u202f|\u00a0/g, " ")

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
      setQuota(await fetchQuota())
      setError(undefined)
    } catch (e: any) {
      setError(e instanceof QuotaError && e.code !== "http" ? t[e.code] : (e?.message ?? String(e)))
    } finally {
      inflight = false
    }
  }

  refresh(true)
  const timer = setInterval(() => refresh(true), opts.refreshMinutes * 60 * 1000)
  const off = api.event.on("session.idle", () => refresh())
  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    off()
  })

  const theme = () => api.theme.current

  const View = () => (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme().text}>
        <b>Copilot</b>
        <Show when={quota()?.plan}>
          <span style={{ fg: theme().textMuted }}> ({quota()!.plan})</span>
        </Show>
      </text>
      <Show
        when={quota()}
        fallback={<text fg={error() ? theme().error : theme().textMuted}>{error() ?? t.loading}</text>}
      >
        {(q) => {
          const s = () => stats(q())
          const ratio = () => (q().entitlement ? q().remaining / q().entitlement : 0)
          const color = () => {
            const r = ratio()
            const expected = s().daysLeft / s().periodDays
            if (r < 0.1) return theme().error
            if (r < expected * 0.8) return theme().warning
            return theme().success
          }
          return (
            <Show when={!q().unlimited} fallback={<text fg={theme().success}>{t.unlimited}</text>}>
              <text>
                <span style={{ fg: color() }}>{bar(ratio()).full}</span>
                <span style={{ fg: theme().textMuted }}>{bar(ratio()).empty}</span>
              </text>
              <text fg={theme().text}>
                {fmt(q().remaining)}{" "}
                <span style={{ fg: theme().textMuted }}>
                  / {fmt(q().entitlement)} {t.remaining(Math.round(q().percentRemaining))}
                </span>
              </text>
              <text fg={theme().textMuted}>
                {t.reset} {q().resetAt.toLocaleDateString(t.locale, { day: "numeric", month: "short" })} ·{" "}
                {Math.ceil(s().daysLeft)} {t.days}
              </text>
              <text fg={theme().textMuted}>
                {t.budget} <span style={{ fg: theme().text }}>{fmt(s().perDayBudget)}</span> · {t.usage}{" "}
                <span style={{ fg: theme().text }}>{fmt(s().perDayUsed)}</span>
              </text>
              <text fg={s().projected > q().entitlement ? theme().warning : theme().textMuted}>
                {s().projected > q().entitlement
                  ? t.runout(Math.floor(s().runoutDays))
                  : `${t.projection} ${fmt(s().projected)}`}
              </text>
              <Show when={q().overageCount > 0}>
                <text fg={theme().warning}>
                  {t.overage}: {fmt(q().overageCount)}
                </text>
              </Show>
            </Show>
          )
        }}
      </Show>
    </box>
  )

  api.slots.register({
    order: opts.order,
    slots: {
      sidebar_content() {
        return <View />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "copilot-quota",
  tui,
}

export default plugin
