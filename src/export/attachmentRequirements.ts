import { FILE_BLOCK_TYPES } from "../notion/blocks.js";

type Node = Record<string, unknown>;
export interface AttachmentRequirement {
  url: string;
  target: Node;
}
/** Enumerate semantic media carriers; ordinary URL properties are references. */
export function attachmentRequirements(raw: unknown): AttachmentRequirement[] {
  const found: AttachmentRequirement[] = [];
  const seen = new Set<object>();
  function media(value: unknown, targetOverride?: Node): void {
    if (!value || typeof value !== "object") return;
    const n = value as Node;
    const kind = n.type;
    if (kind !== "file" && kind !== "external" && kind !== "custom_emoji") return;
    const payload = n[kind] as Node | undefined;
    if (payload && typeof payload.url === "string" && payload.url) {
      found.push({ url: payload.url, target: targetOverride ?? payload });
    }
  }
  function walk(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    const n = value as Node;
    if (n.object === "page" || n.object === "database" || "properties" in n) {
      media(n.icon);
      media(n.cover);
    }
    if (typeof n.type === "string" && FILE_BLOCK_TYPES.has(n.type)) {
      const payload = n[n.type];
      if (payload && typeof payload === "object") media(payload, payload as Node);
    }
    if (n.type === "callout") media((n.callout as Node | undefined)?.icon);
    if (n.type === "files" && Array.isArray(n.files)) for (const file of n.files) media(file);
    if (n.type === "mention") media(n.mention);
    for (const [key, child] of Object.entries(n)) {
      if (key === "properties" && child && typeof child === "object") {
        for (const prop of Object.values(child)) walk(prop);
      } else walk(child);
    }
  }
  walk(raw);
  return found;
}
