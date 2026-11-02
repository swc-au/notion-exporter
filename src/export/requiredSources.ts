import fsp from "node:fs/promises";
import { z } from "zod";

const source = z
  .object({
    id: z
      .string()
      .min(1)
      .refine((v) => v.trim() === v),
    object: z.enum(["page", "database"]),
  })
  .strict();
const inventory = z
  .array(source)
  .min(1)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id))
        ctx.addIssue({ code: "custom", message: "duplicate required source ID" });
      seen.add(item.id);
    }
  });
export type RequiredSource = z.infer<typeof source>;
export function parseRequiredSources(value: unknown): RequiredSource[] {
  return inventory.parse(value);
}
export async function readRequiredSources(file: string): Promise<RequiredSource[]> {
  return parseRequiredSources(JSON.parse(await fsp.readFile(file, "utf8")));
}
/** Minimum independently supplied coverage, not an exhaustive descendant inventory. */
export function assertRequiredSources(required: unknown, actual: readonly RequiredSource[]): void {
  const expected = parseRequiredSources(required);
  const found = new Map(actual.map((item) => [item.id, item.object]));
  for (const item of expected) {
    if (found.get(item.id) !== item.object)
      throw new Error(`Required source missing or wrong kind: ${item.id}`);
  }
}
