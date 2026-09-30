import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Keep native OpenCode stream wrappers when changing a pool key at runtime. */
export function registerPoolKey(
	pi: ExtensionAPI,
	id: string,
	key: string,
	ctx: ExtensionContext,
) {
	const provider =
		id === "opencode" || id === "opencode-go"
			? ctx.modelRegistry.getProvider?.(id)
			: undefined;
	if (!provider) {
		pi.registerProvider(id, { apiKey: key });
		return;
	}
	pi.registerProvider({
		...provider,
		auth: {
			...provider.auth,
			apiKey: {
				...provider.auth.apiKey,
				name: provider.auth.apiKey?.name ?? "Credential pool",
				check: undefined,
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					return { auth: { apiKey: key }, source: "credential pool" };
				},
			},
		},
	});
}
