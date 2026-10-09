/**
 * Cache-first catalog registration for network-backed providers.
 *
 * Pi loads extensions serially, so awaiting a `/models` fetch in each provider
 * factory stacks every provider's network latency (up to its timeout) onto
 * startup. With a cached catalog the provider registers immediately and the
 * fresh catalog replaces it in the background; only a cold cache blocks.
 */
export interface CacheFirstCatalog<T> {
	/** `undefined` means no usable cache: the first fetch then blocks. */
	loadCache: () => Promise<T[] | undefined>;
	fetchFresh: () => Promise<T[]>;
	saveCache: (models: T[]) => Promise<void>;
	register: (models: T[]) => void;
	/** Cold-cache fetch failure: the provider's existing fallback path. */
	onColdFailure: (error: unknown) => Promise<void> | void;
	/** Background refresh failure; the cached catalog stays registered unless this removes it. */
	onRefreshFailure?: (error: unknown) => void;
}

/** Wrapped so awaiting the registration never waits for the background refresh. */
export interface CacheFirstResult {
	refresh?: Promise<void>;
}

export const nonEmpty = <T>(models: T[]): T[] | undefined => (models.length > 0 ? models : undefined);

/** Non-auth refresh failure: the cached catalog stays, but say it may be stale. */
export function warnStaleCatalog(tag: string, error: unknown): void {
	const reason = error instanceof Error ? error.message : String(error);
	console.warn(`[${tag}] Catalog refresh failed (${reason}); keeping cached models.`);
}

export async function registerCacheFirst<T>(catalog: CacheFirstCatalog<T>): Promise<CacheFirstResult> {
	const cached = await catalog.loadCache();
	if (cached !== undefined) {
		catalog.register(cached);
		return { refresh: refreshInBackground(catalog, JSON.stringify(cached)) };
	}
	try {
		const fresh = await catalog.fetchFresh();
		await catalog.saveCache(fresh);
		catalog.register(fresh);
	} catch (error) {
		await catalog.onColdFailure(error);
	}
	return {};
}

async function refreshInBackground<T>(catalog: CacheFirstCatalog<T>, previous: string): Promise<void> {
	try {
		const fresh = await catalog.fetchFresh();
		await catalog.saveCache(fresh);
		if (JSON.stringify(fresh) !== previous) catalog.register(fresh);
	} catch (error) {
		try {
			catalog.onRefreshFailure?.(error);
		} catch {
			// A reloaded extension's API is inactive; nothing is left to update.
		}
	}
}
