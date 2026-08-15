export function revisionNumber(rows: Array<{ revision_number: number }>) {
  return Math.max(0, ...rows.map((row) => row.revision_number)) + 1;
}
