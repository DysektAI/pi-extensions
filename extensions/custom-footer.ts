import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

// Separator semantics. Major boundaries use a spaced bar; details within a
// section use a spaced dot. The compact variants drop the surrounding spaces
// for very narrow terminals only (see pickLayout).
const SEP_MAJOR = " │ ";
const SEP_DETAIL = " · ";
const SEP_MAJOR_TIGHT = "│";
const SEP_DETAIL_TIGHT = "·";

// Auto-compaction reserves this many tokens (pi default), so it triggers once
// context usage crosses contextWindow - COMPACT_RESERVE. The context row shows
// usage against this effective threshold rather than the raw model window.
const COMPACT_RESERVE = 16384;

// Cache freshness is INFERRED, not reported. Providers expose cacheRead/
// cacheWrite but never an expiry timestamp, so we assume the common Anthropic-
// style short retention window and refresh it on each cache-active turn. Tune
// this if your provider uses a different retention tier. 0 disables the
// warm/cold indicator entirely.
const ESTIMATED_CACHE_TTL_MS = 5 * 60 * 1000;

// While a cache countdown is visible nothing else changes between turns, so we
// re-render on this interval to keep the "hot:Nm" value honest. Mirrors the
// setInterval + dispose pattern used by status-tracker.ts.
const CACHE_TICK_MS = 15 * 1000;

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

// Title-case a hyphen/underscore/space separated slug for display, preserving
// version-like tokens (e.g. "4.8", "1m") rather than lower-casing them.
function titleizeSlug(slug: string): string {
	return slug
		.replace(/[_-]+/g, " ")
		.split(" ")
		.filter(Boolean)
		.map((word) => {
			if (/^v?\d/.test(word)) return word; // version-ish: leave as-is
			return word.charAt(0).toUpperCase() + word.slice(1);
		})
		.join(" ");
}

// Friendly provider label from a raw id prefix. Keeps known multi-part vendor
// prefixes readable (e.g. "google-aistudio" -> "Google-Aistudio").
function friendlyProvider(rawProvider: string): string {
	if (!rawProvider) return "";
	return rawProvider
		.split("-")
		.map((part) => {
			const lower = part.toLowerCase();
			if (lower === "ai") return "AI";
			if (lower === "openai") return "OpenAI";
			if (lower === "openrouter") return "OpenRouter";
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join("-");
}

// Friendly model label. Prefers the provider-supplied name when present (the
// generated model data already carries "Claude Opus 4.5" style names),
// otherwise derives a readable label from the id slug.
function friendlyModel(model: any, fallbackSlug: string): string {
	const name = typeof model?.name === "string" ? model.name.trim() : "";
	if (name) return name;
	// Strip a leading "claude-"/"gpt-" style vendor token only if it duplicates
	// the provider; otherwise titleize the whole slug.
	return titleizeSlug(fallbackSlug);
}

function getSessionUsage(ctx: any): UsageSummary {
	const s: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
	try {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message?.role === "assistant") {
				const u = entry.message.usage;
				if (!u) continue;
				s.input += u.input || 0;
				s.output += u.output || 0;
				s.cacheRead += u.cacheRead || 0;
				s.cacheWrite += u.cacheWrite || 0;
				s.total += u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
				s.cost += u.cost?.total || 0;
			}
		}
	} catch {
		// ignore
	}
	return s;
}

// Timestamp (ms) of the most recent assistant turn that read from or wrote to
// the prompt cache, or null if the session has no cache activity. Each such
// turn refreshes the assumed TTL window, so this is the anchor for warmth.
function getLastCacheActivityAt(ctx: any): number | null {
	let last: number | null = null;
	try {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message?.role === "assistant") {
				const u = entry.message.usage;
				if (!u) continue;
				if ((u.cacheRead || 0) > 0 || (u.cacheWrite || 0) > 0) {
					const ts = typeof entry.message.timestamp === "number" ? entry.message.timestamp : null;
					if (ts != null) last = ts;
				}
			}
		}
	} catch {
		// ignore
	}
	return last;
}

/**
 * Normalize an extension status for the footer.
 *
 * Idle "extension is loaded" badges (e.g. "Context7", "Brave Search API",
 * "…keys") carry no live signal, so they are hidden to keep the footer clean.
 * Active states (resolving, searching, fetching, key rotation, rate-limit /
 * errors) are surfaced in plain, emoji-free words.
 */
function activeStatus(key: string, raw: string): string | null {
	const text = raw
		.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return null;

	switch (key) {
		case "context7":
			return /^context7$/i.test(text) ? null : `Context7 ${text.replace(/^context7\s*/i, "")}`.trim();
		case "web-search":
			return /\bapi$/i.test(text) && !/searching|fetching|results|error/i.test(text)
				? null
				: `web ${text}`.replace(/\s+/g, " ").trim();
		case "credential-pool":
			return /keys/i.test(text) && !/rotat|rate-limited|error|fail/i.test(text) ? null : text;
		default:
			return text;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			// Re-render on a slow tick so the inferred cache countdown stays
			// current. Only matters while a countdown is on screen; the cost is a
			// single timer that just requests a render.
			let tick: ReturnType<typeof setInterval> | null = null;
			if (ESTIMATED_CACHE_TTL_MS > 0) {
				tick = setInterval(() => tui.requestRender(), CACHE_TICK_MS);
				// Don't keep the process alive solely for the footer tick.
				(tick as any)?.unref?.();
			}

			const dimSep = (compact: boolean) => theme.fg("dim", compact ? SEP_DETAIL_TIGHT : SEP_DETAIL);
			const majSep = (compact: boolean) => theme.fg("dim", compact ? SEP_MAJOR_TIGHT : SEP_MAJOR);

			return {
				dispose() {
					unsub();
					if (tick) clearInterval(tick);
				},
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model;
					const rawId = model?.id || "no-model";
					const rawProvider = model?.provider || (rawId.includes("/") ? rawId.split("/")[0] : "");
					const modelSlug = rawId.includes("/") ? rawId.split("/").pop()! : rawId;

					const providerLabel = friendlyProvider(rawProvider);
					const modelLabel = friendlyModel(model, modelSlug);

					// ── Identity: provider │ model · Nctx │ level │ branch ───────────
					const modelWindow = model?.contextWindow ?? 0;
					const ctxBadge = modelWindow > 0 ? `${formatTokens(modelWindow)} ctx` : "";

					// Reasoning level — bare level, colored by level. Always shown so it
					// is never a question; non-reasoning models say so explicitly.
					let level: string;
					if (model?.reasoning && typeof pi.getThinkingLevel === "function") {
						const lvl = pi.getThinkingLevel() || "off";
						level = theme.getThinkingBorderColor(lvl)(lvl);
					} else {
						level = theme.fg("dim", "no reasoning");
					}

					const branch = footerData.getGitBranch();

					// ── Context row pieces ───────────────────────────────────────────
					const ctxUsage = ctx.getContextUsage();
					const ctxTokens = ctxUsage?.tokens ?? null;
					// getContextUsage().contextWindow is the MODEL window; the effective
					// pre-compact threshold is that minus the reserve.
					const usageWindow = ctxUsage?.contextWindow ?? modelWindow ?? 0;
					const compactThreshold = usageWindow > COMPACT_RESERVE ? usageWindow - COMPACT_RESERVE : usageWindow;
					// Percentage is against the compact threshold so it agrees with the
					// "/984k" shown, not the raw model window.
					const pct =
						ctxTokens != null && compactThreshold > 0
							? Math.round((ctxTokens / compactThreshold) * 100)
							: ctxUsage?.percent != null
								? Math.round(ctxUsage.percent)
								: null;
					const ctxColor = pct == null ? "muted" : pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";
					let ctxStr: string;
					if (ctxTokens != null && compactThreshold > 0) {
						ctxStr = `ctx:${formatTokens(ctxTokens)}/${formatTokens(compactThreshold)}`;
						if (pct != null) ctxStr += ` (${pct}%)`;
					} else if (pct != null) {
						ctxStr = `ctx:${pct}%`;
					} else {
						ctxStr = "ctx:?";
					}
					const ctxColored = theme.fg(ctxColor, ctxStr);

					// ── Session usage pieces ─────────────────────────────────────────
					const usage = getSessionUsage(ctx);
					// Whether caching is even a thing for this model: it must have cache
					// pricing AND the session must have reported cache activity. Avoids a
					// misleading cache segment on providers (e.g. some gateways) that
					// fold cache reads into input or don't cache at all.
					const modelCaches = (model?.cost?.cacheRead || 0) > 0 || (model?.cost?.cacheWrite || 0) > 0;
					const hasCacheActivity = usage.cacheRead > 0 || usage.cacheWrite > 0;
					const cacheDenom = usage.input + usage.cacheRead + usage.cacheWrite;
					const cacheHitPct =
						modelCaches && hasCacheActivity && cacheDenom > 0
							? Math.round((usage.cacheRead / cacheDenom) * 100)
							: null;

					const buildSession = (compact: boolean): string | null => {
						if (usage.total <= 0) return null;
						const parts: string[] = [theme.fg("muted", `${compact ? "Σ" : "session"}:${formatTokens(usage.total)}`)];
						if (usage.input) parts.push(theme.fg("dim", `in:${formatTokens(usage.input)}`));
						if (usage.output) parts.push(theme.fg("dim", `out:${formatTokens(usage.output)}`));
						if (cacheHitPct != null) {
							const hitColor = cacheHitPct >= 50 ? "success" : cacheHitPct >= 20 ? "warning" : "dim";
							parts.push(theme.fg(hitColor, `cache:${cacheHitPct}%`));
						}
						return parts.join(compact ? SEP_DETAIL_TIGHT : SEP_DETAIL);
					};

					// ── Cache freshness (inferred countdown) ─────────────────────────
					// Tracks the last cache-active turn and counts down against the
					// assumed TTL. Estimate only; never shown without real activity.
					const buildCacheFreshness = (): string | null => {
						if (ESTIMATED_CACHE_TTL_MS <= 0) return null;
						if (!modelCaches || !hasCacheActivity) return null;
						const lastCacheActivityAt = getLastCacheActivityAt(ctx);
						if (lastCacheActivityAt == null) return null;
						const estimatedCacheExpiresAt = lastCacheActivityAt + ESTIMATED_CACHE_TTL_MS;
						const remainingMs = estimatedCacheExpiresAt - Date.now();
						const isCacheLikelyWarm = remainingMs > 0;
						if (isCacheLikelyWarm) {
							const mins = Math.max(1, Math.ceil(remainingMs / 60000));
							return theme.fg("success", `hot:${mins}m`);
						}
						const coldMins = Math.floor(-remainingMs / 60000);
						return theme.fg("warning", coldMins > 0 ? `cold:${coldMins}m` : "cold");
					};

					// ── Cost (own major section) ─────────────────────────────────────
					const costStr = usage.cost > 0 ? theme.fg("muted", `$${usage.cost.toFixed(2)}`) : null;

					// ── Assemble, with graceful width degradation ────────────────────
					const bracketProvider = (compact: boolean) => {
						// Identity line. Build from widest to narrowest.
						const ds = dimSep(compact);
						const ms = majSep(compact);
						const modelWithBadge = ctxBadge
							? theme.fg("accent", modelLabel) + ds + theme.fg("dim", ctxBadge)
							: theme.fg("accent", modelLabel);
						const branchStr = branch ? ms + theme.fg("dim", branch) : "";
						const provColored = theme.fg("muted", providerLabel);
						return [
							// full: provider │ model · badge │ level │ branch
							(providerLabel ? provColored + ms : "") + modelWithBadge + ms + level + branchStr,
							// drop branch
							(providerLabel ? provColored + ms : "") + modelWithBadge + ms + level,
							// drop provider
							modelWithBadge + ms + level + branchStr,
							modelWithBadge + ms + level,
							// drop badge
							theme.fg("accent", modelLabel) + ms + level,
							theme.fg("accent", modelLabel),
						];
					};

					// Active extension work, spelled out (idle badges already filtered).
					const statuses: string[] = [];
					for (const [key, raw] of footerData.getExtensionStatuses()) {
						if (!raw) continue;
						const label = activeStatus(key, raw);
						if (label) statuses.push(theme.fg("warning", label));
					}

					// Build line 2 from sections. Each section may have a full and a
					// compact rendering; we first try all-full, then progressively
					// compact and drop the least important sections, always keeping the
					// context segment and (if present) cost.
					const buildLine2 = (lineCompact: boolean): string => {
						const ms = lineCompact ? SEP_MAJOR_TIGHT : SEP_MAJOR;
						const joiner = theme.fg("dim", ms);
						const sessionFull = buildSession(false);
						const sessionTight = buildSession(true);
						const fresh = buildCacheFreshness();

						// Ordered middle sections (between ctx and cost), least → most
						// important is reflected by trimming from the end of this list.
						// Each entry carries a preferred and a fallback (compact) form.
						const middle: Array<{ full: string; tight: string }> = [];
						if (sessionFull) middle.push({ full: sessionFull, tight: sessionTight ?? sessionFull });
						if (fresh) middle.push({ full: fresh, tight: fresh });
						for (const s of statuses) middle.push({ full: s, tight: s });

						const assemble = (mids: string[]): string => {
							const parts = [ctxColored, ...mids];
							if (costStr) parts.push(costStr);
							return parts.join(joiner);
						};

						// For each retained count (most → fewest middle sections), prefer the
						// full forms but fall back to compact forms before dropping a section.
						// This keeps e.g. "Σ:8.8M · cache:43%" on screen at medium widths
						// instead of dropping the whole session group.
						for (let keep = middle.length; keep >= 0; keep--) {
							const full = assemble(middle.slice(0, keep).map((m) => m.full));
							if (visibleWidth(full) <= width) return full;
							const tight = assemble(middle.slice(0, keep).map((m) => m.tight));
							if (visibleWidth(tight) <= width) return tight;
						}
						// Floor: ctx + cost only, then ctx alone.
						const ctxCost = costStr ? [ctxColored, costStr].join(joiner) : ctxColored;
						if (visibleWidth(ctxCost) <= width) return ctxCost;
						return truncateToWidth(ctxColored, width);
					};

					// Pick the widest layout (spaced separators) that fits the identity
					// line; fall back to tight separators only when spaced won't fit.
					const pickLine1 = (): { line: string; compact: boolean } => {
						for (const v of bracketProvider(false)) {
							if (visibleWidth(v) <= width) return { line: v, compact: false };
						}
						for (const v of bracketProvider(true)) {
							if (visibleWidth(v) <= width) return { line: v, compact: true };
						}
						return { line: truncateToWidth(theme.fg("accent", modelLabel), width), compact: true };
					};

					const { line: line1, compact } = pickLine1();
					const line2 = buildLine2(compact);
					return [line1, line2];
				},
			};
		});
	});
}
