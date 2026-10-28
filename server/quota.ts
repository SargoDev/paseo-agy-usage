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
const BUCKETS = [
  { id: "gemini-5h", label: "Gemini · 5h", shortLabel: "Gemini 5h" },
  { id: "gemini-weekly", label: "Gemini · Weekly", shortLabel: "Gemini wk" },
  { id: "gemini-argon-wtu-weekly", label: "Argon · Weekly", shortLabel: "Argon wk" },
  { id: "3p-5h", label: "Claude & GPT · 5h", shortLabel: "3P 5h" },
  { id: "3p-weekly", label: "Claude & GPT · Weekly", shortLabel: "3P wk" },
] as const;

const summarySchema = z.object({ groups: z.array(z.unknown()) });
const groupSchema = z.object({ buckets: z.array(z.unknown()) });
const bucketSchema = z.object({
  bucketId: z.string(),
  remainingFraction: z.unknown().optional(),
  resetTime: z.unknown().optional(),
});
type Bucket = z.infer<typeof bucketSchema>;

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

  const windows = BUCKETS.map(({ id, label, shortLabel }) => {
    const bucket = byId.get(id);
    const remaining = bucket?.remainingFraction;
    const usedPct = typeof remaining === "number" && Number.isFinite(remaining)
      ? Math.max(0, Math.min(100, (1 - remaining) * 100)) : null;
    const resetsAtMs = timestampMs(bucket?.resetTime);
    return windowFromUsedPct({
      id,
      label,
      shortLabel,
      summary: true,
      utilizationPct: usedPct,
      resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
      tone: toneFromUsedPct(usedPct),
    });
  });
  if (windows.every((window) => window.usedPct === null)) {
    throw new UsageError("Antigravity quota buckets contain no valid remainingFraction readings.");
  }
  const details: UsageDetail[] = [];
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
  for (const { id, label } of BUCKETS) {
    const bucket = byId.get(id);
    const resetsAtMs = timestampMs(bucket?.resetTime);
    if (resetsAtMs !== null) {
      details.push({
        id: `${id}-reset`,
        label: `${label} reset`,
        value: formatRemainingReset(resetsAtMs, nowMs),
      });
    }
  }
  return {
    status: "available",
    ...(planLabel ? { planLabel } : {}),
    windows,
    details,
  };
}
