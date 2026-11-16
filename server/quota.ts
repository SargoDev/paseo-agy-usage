import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageDetail,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { timestampMs } from "./probe.js";
import { UsageError } from "./errors.js";

// These period names are justified by the API's bucketId, not response order or
// time until reset. durationMs is not part of Paseo 0.11's UsageWindow contract.
const BUCKETS: readonly { id: string; label: string; shortLabel: string; optional?: true }[] = [
  // Gemini pool includes Gemini 4 Hydrogen and Gemini 3.8 Flash
  { id: "gemini-5h", label: "Gemini · 5h", shortLabel: "Gemini 5h" },
  { id: "gemini-weekly", label: "Gemini · Weekly", shortLabel: "Gemini wk" },
  // 3P pool includes Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B
  { id: "3p-5h", label: "Claude & GPT · 5h", shortLabel: "3P 5h" },
  { id: "3p-weekly", label: "Claude & GPT · Weekly", shortLabel: "3P wk" },
  // Paid plans meter Gemini 4 Argon & Orchestrator in a pool of their own. Other logins do not report it.
  { id: "gemini-argon-wtu-weekly", label: "Gemini 4 Argon · Weekly", shortLabel: "Argon wk", optional: true },
  { id: "gemini-argon-5h", label: "Gemini 4 Argon · 5h", shortLabel: "Argon 5h", optional: true },
  { id: "gemini-argon-weekly", label: "Gemini 4 Argon · Weekly", shortLabel: "Argon wk", optional: true },
  // Gemini 4 Carbon (frontier reasoning models)
  { id: "gemini-carbon-wtu-weekly", label: "Gemini 4 Carbon · Weekly", shortLabel: "Carbon wk", optional: true },
  { id: "gemini-carbon-weekly", label: "Gemini 4 Carbon · Weekly", shortLabel: "Carbon wk", optional: true },
  { id: "gemini-carbon-5h", label: "Gemini 4 Carbon · 5h", shortLabel: "Carbon 5h", optional: true },
  { id: "gemini-carbon-wtu-5h", label: "Gemini 4 Carbon · 5h", shortLabel: "Carbon 5h", optional: true },
  // Orchestrator dedicated pools if reported separately
  { id: "gemini-orchestrator-wtu-weekly", label: "Gemini Orchestrator · Weekly", shortLabel: "Orchestrator wk", optional: true },
  { id: "gemini-orchestrator-5h", label: "Gemini Orchestrator · 5h", shortLabel: "Orchestrator 5h", optional: true },
];

const summarySchema = z.object({ groups: z.array(z.unknown()) });
const groupSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  buckets: z.array(z.unknown()),
});
const bucketSchema = z.object({
  bucketId: z.string(),
  displayName: z.string().optional(),
  window: z.string().optional(),
  description: z.string().optional(),
  remainingFraction: z.unknown().optional(),
  resetTime: z.unknown().optional(),
});
type Bucket = z.infer<typeof bucketSchema>;

export function formatDynamicBucketLabel(
  bucketId: string,
  displayName?: string,
): { label: string; shortLabel: string } {
  if (displayName) {
    const cleanDisplay = displayName.replace(/\s+(limit|remaining)/gi, "").trim();
    return { label: cleanDisplay, shortLabel: cleanDisplay };
  }
  const parts = bucketId.split("-").filter((p) => p !== "wtu");
  const period = parts.find((p) => p === "5h" || p === "weekly" || p === "daily");
  const nameParts = parts.filter((p) => p !== "5h" && p !== "weekly" && p !== "daily");
  const modelName = nameParts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  const periodLabel = period === "5h" ? "5h" : period === "weekly" ? "Weekly" : period === "daily" ? "Daily" : "";
  const label = periodLabel ? `${modelName} · ${periodLabel}` : modelName;
  const shortLabel = periodLabel ? `${modelName} ${periodLabel === "Weekly" ? "wk" : periodLabel}` : modelName;
  return { label, shortLabel };
}

export function formatCompactGroupModels(
  displayName?: string,
  description?: string,
): { label: string; value: string } | null {
  if (!displayName || !description) return null;
  const name = displayName.toLowerCase();

  if (name.includes("gemini models") || name === "gemini") {
    return { label: "Gemini pool", value: "Hydrogen · Flash 3.8" };
  }
  if (name.includes("argon")) {
    return { label: "Argon pool", value: "Argon 4 · Orchestrator" };
  }
  if (name.includes("claude") || name.includes("gpt") || name.includes("3p")) {
    return { label: "Claude & GPT", value: "Opus 5.5 · Sonnet · GPT" };
  }
  if (name.includes("carbon")) {
    return { label: "Carbon pool", value: "Gemini 4 Carbon" };
  }

  // Fallback for custom or future pools
  let cleanValue = description;
  const prefixMatch = description.match(/models within this group:\s*(.*)/i);
  if (prefixMatch && prefixMatch[1]) {
    cleanValue = prefixMatch[1].replace(/Gemini\s+/gi, "").replace(/Claude\s+/gi, "").trim();
  } else if (cleanValue.length > 25) {
    cleanValue = cleanValue.slice(0, 22) + "...";
  }
  const cleanLabel = displayName.replace(/\s+models$/i, "").trim();
  return { label: cleanLabel, value: cleanValue };
}

export function formatRemainingReset(
  resetTimeMs: number,
  nowMs: number,
): string {
  const diffMs = resetTimeMs - nowMs;
  if (diffMs <= 0) return "Ready to reset";
  const totalMins = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMins / (24 * 60));
  const hours = Math.floor((totalMins % (24 * 60)) / 60);
  const mins = totalMins % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  if (mins > 0) {
    return `${mins}m`;
  }
  return "< 1m";
}

export function formatResetDate(
  dateOrMs: number | Date,
  timeZone: string = process.env.TZ || "Europe/Warsaw",
): string {
  const d = typeof dateOrMs === "number" ? new Date(dateOrMs) : dateOrMs;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const findPart = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = findPart("day");
  const month = findPart("month");
  const year = findPart("year");
  const hour = findPart("hour");
  const minute = findPart("minute");
  return `${day}.${month}.${year} ${hour}:${minute}`;
}

export function readTierLabel(document: unknown): string | null {
  const tier = z.object({ id: z.string().min(1) });
  const parsed = z.object({
    g1Tier: z.unknown().optional(),
    paidTier: z.unknown().optional(),
    currentTier: z.unknown().optional(),
  }).safeParse(document);
  if (!parsed.success) return null;
  const root = parsed.data;
  // currentTier alone is Code Assist's plan, often free even for a paid
  // Antigravity user. Prefer the consumer Google One fields when present.
  const id = typeof root.g1Tier === "string" && root.g1Tier !== "" ? root.g1Tier
    : tier.safeParse(root.paidTier).data?.id ?? tier.safeParse(root.currentTier).data?.id;
  if (!id) return null;
  const names: Record<string, string> = {
    "free-tier": "Free tier",
    "standard-tier": "Standard tier",
    "g1-pro-tier": "Google AI Pro",
    "g1-ultra-tier": "Google AI Ultra",
  };
  return Object.hasOwn(names, id) ? names[id] ?? id : id;
}

export function mapQuotaSummary(
  document: unknown,
  planLabel: string | null = null,
  nowMs: number = Date.now(),
  _timeZone: string = process.env.TZ || "Europe/Warsaw",
): UsageReport {
  const parsed = summarySchema.safeParse(document);
  if (!parsed.success) throw new UsageError("Antigravity returned an invalid quota summary (expected groups).");
  const byId = new Map<string, Bucket>();
  for (const rawGroup of parsed.data.groups) {
    const group = groupSchema.safeParse(rawGroup);
    if (!group.success) throw new UsageError("Antigravity returned an invalid quota group (expected buckets).");
    for (const rawBucket of group.data.buckets) {
      const bucket = bucketSchema.safeParse(rawBucket);
      if (bucket.success && !byId.has(bucket.data.bucketId)) byId.set(bucket.data.bucketId, bucket.data);
    }
  }
  if (!BUCKETS.some(({ id }) => byId.has(id))) {
    return unavailable({ kind: "no_quota", detail: "Antigravity did not report the Gemini or Claude & GPT quota pools for this login." });
  }

  const recognizedBucketIds = new Set(BUCKETS.map(({ id }) => id));
  const definedWindows = BUCKETS.filter(({ id, optional }) => !optional || byId.has(id)).map(({ id, label, shortLabel }) => {
    const bucket = byId.get(id);
    const remaining = bucket?.remainingFraction;
    const hasReading = typeof remaining === "number" && Number.isFinite(remaining);
    const resetsAtMs = timestampMs(bucket?.resetTime);
    const isResetActive = resetsAtMs !== null && resetsAtMs > nowMs;
    const isStarted = hasReading && (remaining < 1 || isResetActive);
    const statusDot = hasReading ? (isStarted ? "🟢" : "🔴") : "";
    const windowLabel = statusDot ? `${statusDot} ${label}` : label;
    const windowShortLabel = statusDot ? `${statusDot} ${shortLabel}` : shortLabel;
    const usedPct = hasReading
      ? Math.max(0, Math.min(100, (1 - remaining) * 100)) : null;
    return windowFromUsedPct({
      id,
      label: windowLabel,
      shortLabel: windowShortLabel,
      summary: true,
      utilizationPct: usedPct,
      resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
      tone: toneFromUsedPct(usedPct),
    });
  });

  const dynamicWindows: ReturnType<typeof windowFromUsedPct>[] = [];
  for (const [bucketId, bucket] of byId.entries()) {
    if (recognizedBucketIds.has(bucketId)) continue;
    const remaining = bucket?.remainingFraction;
    const hasReading = typeof remaining === "number" && Number.isFinite(remaining);
    const resetsAtMs = timestampMs(bucket?.resetTime);
    const isResetActive = resetsAtMs !== null && resetsAtMs > nowMs;
    const isStarted = hasReading && (remaining < 1 || isResetActive);
    const statusDot = hasReading ? (isStarted ? "🟢" : "🔴") : "";
    const dynamicMeta = formatDynamicBucketLabel(bucketId, bucket.displayName);
    const windowLabel = statusDot ? `${statusDot} ${dynamicMeta.label}` : dynamicMeta.label;
    const windowShortLabel = statusDot ? `${statusDot} ${dynamicMeta.shortLabel}` : dynamicMeta.shortLabel;
    const usedPct = hasReading
      ? Math.max(0, Math.min(100, (1 - remaining) * 100)) : null;
    dynamicWindows.push(windowFromUsedPct({
      id: bucketId,
      label: windowLabel,
      shortLabel: windowShortLabel,
      summary: true,
      utilizationPct: usedPct,
      resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
      tone: toneFromUsedPct(usedPct),
    }));
  }

  const windows = [...definedWindows, ...dynamicWindows];
  if (windows.every((window) => window.usedPct === null)) {
    throw new UsageError("Antigravity quota buckets contain no valid remainingFraction readings.");
  }
  const details: UsageDetail[] = [];
  for (const rawGroup of parsed.data.groups) {
    const group = groupSchema.safeParse(rawGroup);
    if (group.success && group.data.displayName && group.data.description) {
      const compact = formatCompactGroupModels(group.data.displayName, group.data.description);
      if (compact) {
        details.push({
          id: `models-${group.data.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          label: compact.label,
          value: compact.value,
        });
      }
    }
  }
  if (planLabel === "Free tier") {
    details.push({
      id: "free-tier-note",
      label: "Free tier",
      value: "On free plans the 5h buckets may stay at full remaining quota; use the weekly buckets to track consumption.",
    });
  }
  if (windows.some((window) => window.usedPct === null)) {
    details.push({ id: "missing-buckets", label: "Quota data", value: "Some quota buckets were omitted or had no valid reading; their usage is unknown, not zero." });
  }
  return {
    status: "available",
    ...(planLabel ? { planLabel } : {}),
    windows,
    details,
  };
}
