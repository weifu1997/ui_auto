export function cleanProjectSlug(value: string) {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "project";
}
