import dns from "node:dns";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runExport } from "../src/commands/export.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const crash = vi.hoisted(() => ({ text: "BEFORE_CRASH" }));

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
                  { plain_text: crash.text },
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

it.each(["collision", "manifest crash", "publication crash", "writer lock"])(
  "preserves prior snapshot after %s",
  async (mode) => {
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), "ss89-collision-"));
    const oldFetch = global.fetch;
    const lookup = vi
      .spyOn(dns.promises, "lookup")
      .mockRejectedValue(Object.assign(new Error("offline"), { code: "ENOTFOUND" }));
    global.fetch = (async () =>
      new Response("synthetic", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
    const cfg = loadConfig({ NOTION_TOKEN: "offline", OUT_DIR: out, NOTION_MIN_TIME: "0" });
    const opts = { incremental: false, resume: false, retention: 0 };
    try {
      const first = await runExport(cfg, createLogger("error"), opts);
      const { isVerifiedSnapshot } = await import("../src/export/verifiedSnapshot.js");
      expect(await isVerifiedSnapshot(first.exportRoot!)).toBe(true);
      const before = new Map<string, string>();
      const manifest = JSON.parse(
        await fsp.readFile(path.join(first.exportRoot!, "manifest.json"), "utf8"),
      );
      for (const e of manifest.entries)
        before.set(e.rawPath, await fsp.readFile(path.join(first.exportRoot!, e.rawPath), "utf8"));
      expect((await fsp.readdir(out)).some((name) => name.startsWith(".staging-"))).toBe(false);
      crash.text = "AFTER_CRASH";
      if (mode === "writer lock")
        await fsp.writeFile(path.join(out, ".export.lock"), "other writer owns this lock");
      if (mode !== "collision") vi.setSystemTime(new Date("2026-11-02T00:00:01Z"));
      const originalRename = fsp.rename.bind(fsp);
      const renaming = vi
        .spyOn(fsp, "rename")
        .mockImplementation(async (...args: Parameters<typeof fsp.rename>) => {
          if (
            mode === "publication crash" &&
            path.basename(String(args[0])).startsWith(".staging-")
          )
            throw new Error("injected publication crash");
          return originalRename(...args);
        });
      const originalWrite = fsp.writeFile.bind(fsp);
      const writing = vi
        .spyOn(fsp, "writeFile")
        .mockImplementation(async (...args: Parameters<typeof fsp.writeFile>) => {
          if (mode === "manifest crash" && String(args[0]).endsWith("/manifest.json"))
            throw new Error("injected manifest write crash");
          return originalWrite(...args);
        });
      await expect(runExport(cfg, createLogger("error"), opts)).rejects.toThrow();
      writing.mockRestore();
      renaming.mockRestore();
      const { findLatestExport } = await import("../src/export/manifest.js");
      const { findVerifiedPreviousExport } = await import("../src/export/verifiedSnapshot.js");
      const { applyRetention } = await import("../src/export/retention.js");
      expect(await findLatestExport(out)).toBe(first.exportRoot);
      expect((await findVerifiedPreviousExport(out))?.root).toBe(first.exportRoot);
      expect(await applyRetention(out, 1, createLogger("error"))).toEqual([]);
      const preserved = await isVerifiedSnapshot(first.exportRoot!);
      let unchanged = true;
      for (const [rel, text] of before)
        if ((await fsp.readFile(path.join(first.exportRoot!, rel), "utf8")) !== text)
          unchanged = false;

      expect(preserved).toBe(true);
      expect(unchanged).toBe(true);
    } finally {
      vi.useRealTimers();
      lookup.mockRestore();
      global.fetch = oldFetch;
      vi.restoreAllMocks();
      await fsp.rm(out, { recursive: true, force: true });
    }
  },
);
