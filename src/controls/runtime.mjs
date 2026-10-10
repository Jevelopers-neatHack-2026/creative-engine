/** Evaluated runtime lines. API availability alone is not host certification. */
export function assertSupportedRuntime(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error('Controls require Node 22.23.3+ (22.x) or 24.15.0+ (24.x).');
  const [major, minor, patch] = match.slice(1).map(Number);
  if (!((major === 22 && (minor > 23 || (minor === 23 && patch >= 3))) || (major === 24 && minor >= 15))) {
    throw new Error('Controls require Node 22.23.3+ (22.x) or 24.15.0+ (24.x).');
  }
}
