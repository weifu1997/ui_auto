export function notificationHostAllowed(host: string, allowlist: string[]) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return allowlist.some((entry) => (
    entry.startsWith("*.")
      ? normalized.endsWith(entry.slice(1)) && normalized !== entry.slice(2)
      : normalized === entry.replace(/\.$/, "")
  ));
}
