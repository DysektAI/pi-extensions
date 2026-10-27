/** Stock Pi 1.4.0 requires Node 22.19+ for runtime integration. */
export function supportsStockSdk(version: string): boolean {
 const [major = 0, minor = 0] = version.split(".").map(Number);
 return major > 22 || (major === 22 && minor >= 19);
}
