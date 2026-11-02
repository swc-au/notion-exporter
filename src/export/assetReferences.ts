import path from "node:path";

/** Stored local paths are root-relative POSIX paths, never URLs or aliases. */
export function validateLocalAssetPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("assets/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.normalize(value) !== value ||
    value === "assets/"
  ) {
    throw new Error("Invalid local asset reference: expected a canonical assets/ path");
  }
  return value;
}

/**
 * Read the exporter's local_path fields throughout raw page/database JSON.
 * Parse JSON first: regex scanning misses escaped keys and path characters.
 * A properties map contains operator-named keys, not media fields; its values
 * are still walked so file properties, rollups and row media are covered.
 */
export function collectLocalAssetPaths(raw: unknown): Set<string> {
  const paths = new Set<string>();
  const pending = [{ value: raw, propertyMap: false }];
  while (pending.length > 0) {
    const { value, propertyMap } = pending.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, propertyMap: false });
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "local_path" && !propertyMap) {
        paths.add(validateLocalAssetPath(child));
      } else {
        pending.push({ value: child, propertyMap: key === "properties" });
      }
    }
  }
  return paths;
}
