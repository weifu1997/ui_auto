export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function publicResourceData(value: unknown) {
  const data = asRecord(value);
  if (data.secret === true) return { ...data, value: "", hasValue: Boolean(data.hasValue) };
  return data;
}
