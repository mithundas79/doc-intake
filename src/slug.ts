/**
 * File-safe, sortable name fragment. Lives in its own module (no node
 * built-ins) so browser consumers - the demo included - can import it.
 */
export function slug(v: string | null, fallback: string): string {
  const s = String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || fallback;
}
