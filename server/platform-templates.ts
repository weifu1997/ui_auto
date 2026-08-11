export function rewriteTemplateReferences(value: unknown, ids: Map<string, string>, depth = 0): unknown {
  if (depth > 100) throw new Error("TEMPLATE_SNAPSHOT_TOO_DEEP");
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteTemplateReferences(item, ids, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteTemplateReferences(item, ids, depth + 1)]));
  return value;
}
