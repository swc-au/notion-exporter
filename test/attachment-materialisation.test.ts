import dns from "node:dns";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runExport } from "../src/commands/export.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

// Mock the Notion SDK Client so the integration test doesn't hit the network.
vi.mock("@notionhq/client", () => {
  const data = {
    search: vi.fn(async () => ({
      results: [
        {
          object: "page",
          id: "page-1",
          url: "https://notion/page-1",
          parent: { type: "workspace", workspace: true },
          properties: { Name: { type: "title", title: [{ plain_text: "Top" }] } },
        },
        {
          object: "page",
          id: "page-2",
          url: "https://notion/page-2",
          parent: { type: "page_id", page_id: "page-1" },
          properties: { Name: { type: "title", title: [{ plain_text: "Child" }] } },
        },
        {
          object: "database",
          id: "db-1",
          url: "https://notion/db-1",
          title: [{ plain_text: "Tasks" }],
          parent: { type: "page_id", page_id: "page-1" },
        },
      ],
      has_more: false,
      next_cursor: null,
    })),
    pagesRetrieve: vi.fn(async ({ page_id }: { page_id: string }) => ({
      id: page_id,
      object: "page",
      icon: { type: "file", file: { url: `https://signed/${page_id}-icon.png` } },
      cover: { type: "external", external: { url: `https://signed/${page_id}-cover.png` } },
      properties: {
        Attachments: {
          type: "files",
          files: [
            {
              name: "uploaded.txt",
              type: "file",
              file: { url: `https://signed/${page_id}-property.txt` },
            },
            {
              name: "external.txt",
              type: "external",
              external: { url: `https://signed/${page_id}-external-property.txt` },
            },
          ],
        },
        Name: { type: "title", title: [{ plain_text: `Page ${page_id}` }] },
        Links: {
          id: "links",
          type: "relation",
          has_more: true,
          relation: Array.from({ length: 25 }, (_, i) => ({ id: `related-${i}` })),
        },
      },
    })),
    blocksList: vi.fn(async ({ block_id }: { block_id: string }) => {
      if (block_id === "page-1") {
        return {
          results: [
            {
              id: "embed",
              type: "embed",
              has_children: false,
              embed: { url: "https://remote-reference.example/player" },
            },
            {
              id: "bookmark",
              type: "bookmark",
              has_children: false,
              bookmark: { url: "https://remote-reference.example/article" },
            },
            {
              id: "link",
              type: "paragraph",
              has_children: false,
              paragraph: {
                rich_text: [
                  {
                    type: "text",
                    plain_text: "ordinary link",
                    href: "https://remote-reference.example/link",
                    text: {
                      content: "ordinary link",
                      link: { url: "https://remote-reference.example/link" },
                    },
                  },
                ],
              },
            },
            ...["image", "file", "pdf", "video", "audio"].flatMap((type) =>
              ["file", "external"].map((kind) => ({
                id: `${type}-${kind}`,
                type,
                has_children: false,
                [type]: { type: kind, [kind]: { url: `https://signed/${type}-${kind}.txt` } },
              })),
            ),
            {
              id: "callout",
              type: "callout",
              has_children: false,
              callout: {
                rich_text: [],
                icon: { type: "external", external: { url: "https://signed/callout-icon.png" } },
              },
            },
            { id: "nested", type: "toggle", has_children: true, toggle: { rich_text: [] } },
            {
              id: "b1",
              type: "heading_1",
              has_children: false,
              heading_1: {
                rich_text: [
                  { plain_text: "OFFLINE_ACCEPTANCE_SENTINEL" },
                  {
                    type: "mention",
                    plain_text: ":sample:",
                    mention: {
                      type: "custom_emoji",
                      custom_emoji: {
                        id: "emoji-mention",
                        name: "sample",
                        url: "https://signed/mention-emoji.png",
                      },
                    },
                  },
                ],
              },
            },
            {
              id: "b2",
              type: "file",
              has_children: false,
              file: {
                type: "file",
                name: "acceptance-note.txt",
                file: { url: "https://signed/acceptance-note.txt", expiry_time: "x" },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        };
      }
      if (block_id === "nested")
        return {
          results: [
            {
              id: "nested-file",
              type: "file",
              has_children: false,
              file: { type: "file", file: { url: "https://signed/nested.txt" } },
            },
          ],
          has_more: false,
          next_cursor: null,
        };
      return { results: [], has_more: false, next_cursor: null };
    }),
    dbRetrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({
      id: database_id,
      object: "database",
      title: [{ plain_text: "Tasks" }],
      cover: { type: "file", file: { url: "https://signed/db-cover.png" } },
      icon: {
        type: "custom_emoji",
        custom_emoji: { id: "emoji-db", name: "database", url: "https://signed/db-emoji.png" },
      },
      data_sources: [{ id: `${database_id}-ds`, name: "default" }],
    })),
    dsRetrieve: vi.fn(async ({ data_source_id }: { data_source_id: string }) => ({
      id: data_source_id,
      object: "data_source",
      properties: {
        Name: { id: "title", name: "Name", type: "title", title: {} },
        Status: {
          id: "abc",
          name: "Status",
          type: "status",
          status: {
            options: [
              { id: "todo", name: "To-Do", color: "default" },
              { id: "doing", name: "In Progress", color: "blue" },
              { id: "done", name: "Done", color: "green" },
            ],
            groups: [],
          },
        },
      },
    })),
    dsQuery: vi.fn(async () => ({
      results: [
        {
          id: "row-1",
          object: "page",
          cover: { type: "file", file: { url: "https://signed/row-cover.png" } },
          icon: {
            type: "custom_emoji",
            custom_emoji: { id: "emoji-row", name: "row", url: "https://signed/row-emoji.png" },
          },
          properties: {
            Name: { type: "title", title: [{ plain_text: "Row1" }] },
            Attachments: {
              type: "files",
              files: [
                { name: "row.txt", type: "file", file: { url: "https://signed/row-property.txt" } },
              ],
            },
            Done: { type: "checkbox", checkbox: true },
            Links: {
              id: "links",
              type: "relation",
              has_more: true,
              relation: Array.from({ length: 25 }, (_, i) => ({ id: `related-${i}` })),
            },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    })),
    usersMe: vi.fn(async () => ({ id: "u1", name: "Bot", type: "bot" })),
    commentsList: vi.fn(async () => ({
      results: [
        {
          object: "comment",
          id: "comment-1",
          rich_text: [],
          attachments: [
            {
              category: "image",
              file: { url: "https://signed/comment.png", expiry_time: "later" },
            },
          ],
        },
      ],
      has_more: false,
      next_cursor: null,
    })),
    // Views API (GA): list → first ref is the default; retrieve → config;
    // queries.create/results → the filtered/sorted/group-ordered page ids.
    viewsList: vi.fn(async () => ({
      object: "list",
      results: [{ object: "view", id: "view-1" }],
      has_more: false,
      next_cursor: null,
    })),
    viewsRetrieve: vi.fn(async ({ view_id }: { view_id: string }) => ({
      object: "view",
      id: view_id,
      type: "board",
      name: "By status",
      configuration: {
        type: "board",
        group_by: { type: "status", property_id: "abc", property_name: "Status" },
      },
    })),
    viewQueryCreate: vi.fn(async () => ({
      object: "view_query",
      id: "q1",
      results: [{ object: "page", id: "row-1" }],
      has_more: false,
      next_cursor: null,
    })),
    viewQueryResults: vi.fn(async () => ({
      object: "list",
      results: [],
      has_more: false,
      next_cursor: null,
      type: "page",
    })),
  };

  class Client {
    search = data.search;
    pages = {
      retrieve: data.pagesRetrieve,
      properties: {
        retrieve: vi.fn(async ({ start_cursor }: { start_cursor?: string }) => ({
          object: "list",
          type: "property_item",
          results: Array.from({ length: start_cursor ? 16 : 25 }, (_, i) => ({
            object: "property_item",
            type: "relation",
            relation: { id: `related-${(start_cursor ? 25 : 0) + i}` },
          })),
          has_more: !start_cursor,
          next_cursor: start_cursor ? null : "relation-page-2",
        })),
      },
    };
    blocks = { children: { list: data.blocksList } };
    databases = { retrieve: data.dbRetrieve };
    dataSources = { query: data.dsQuery, retrieve: data.dsRetrieve };
    users = { me: data.usersMe };
    comments = { list: data.commentsList };
    views = {
      list: data.viewsList,
      retrieve: data.viewsRetrieve,
      queries: { create: data.viewQueryCreate, results: data.viewQueryResults },
    };
  }

  return { Client };
});

it.each([true, false])("enforces attachment preservation with row media=%s", async (rowMedia) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "attachment-materialisation-"));
  await fsp.mkdir(outDir, { recursive: true });
  const lookup = vi
    .spyOn(dns.promises, "lookup")
    .mockRejectedValue(Object.assign(new Error("offline synthetic DNS"), { code: "ENOTFOUND" }));
  const oldFetch = global.fetch;
  const requests: string[] = [];
  global.fetch = (async (url: unknown) => {
    const u = String(url);
    requests.push(u);
    if (!u.startsWith("https://signed/")) throw new Error(`Unexpected boundary ${u}`);
    return new Response(`SYNTHETIC_BYTES:${u}`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;
  try {
    const pending = runExport(
      loadConfig({
        NOTION_TOKEN: "offline_placeholder",
        OUT_DIR: outDir,
        NOTION_MIN_TIME: "0",
        EXPORT_ROW_MEDIA: String(rowMedia),
      }),
      createLogger("error"),
      { incremental: false, resume: false, retention: 0 },
    );
    if (!rowMedia) {
      await expect(pending).rejects.toThrow(/required attachment has no local path/);
      expect(requests).not.toContain("https://signed/row-cover.png");
      expect(requests).not.toContain("https://signed/row-emoji.png");
      expect(requests).toContain("https://signed/row-property.txt");
      return;
    }
    const result = await pending;
    const stamp = (await fsp.readdir(outDir))
      .filter((x) => /^\d{4}-/.test(x))
      .sort()
      .at(-1)!;
    const root = path.join(outDir, stamp);
    const manifest = JSON.parse(await fsp.readFile(path.join(root, "manifest.json"), "utf8"));
    const references: Array<{ location: string; url: string; localPath?: string }> = [];
    function scan(value: unknown, location: string) {
      if (!value || typeof value !== "object") return;
      const v = value as Record<string, unknown>;
      if (typeof v.url === "string" && v.url.startsWith("https://signed/"))
        references.push({ location, url: v.url, localPath: v.local_path as string | undefined });
      for (const [k, child] of Object.entries(v)) scan(child, `${location}.${k}`);
    }
    for (const entry of manifest.entries)
      scan(
        JSON.parse(await fsp.readFile(path.join(root, entry.rawPath), "utf8")),
        entry.kind + ":" + entry.id,
      );
    const evidence = {
      synthetic: true,
      sourceCommit: "11f579a757a416718b1f01ca050be7621089369d",
      result,
      manifestCounts: manifest.counts,
      failedAssets: manifest.failedAssets,
      requests,
      references,
      unrequested: references.filter((x) => !requests.includes(x.url)),
    };

    expect(result.errors).toBe(0);
    expect(manifest.counts.failedAssets ?? 0).toBe(0);
    const { isVerifiedSnapshot } = await import("../src/export/verifiedSnapshot.js");
    expect(await isVerifiedSnapshot(root)).toBe(true);
    expect(evidence.unrequested).toEqual([]);

    expect(requests).toContain("https://signed/nested.txt");
    expect(requests).toContain("https://signed/mention-emoji.png");
    expect(requests.some((u) => u.startsWith("https://remote-reference.example/"))).toBe(false);
  } finally {
    lookup.mockRestore();
    global.fetch = oldFetch;
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});
