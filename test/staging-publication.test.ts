import dns from "node:dns";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runExport } from "../src/commands/export.js";
import { inspectRecovery } from "../src/commands/inspectRecovery.js";
import { recoverStage } from "../src/commands/recoverStage.js";
import { runRepair } from "../src/commands/repair.js";
import { runRerender } from "../src/commands/rerender.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const crash = vi.hoisted(() => ({ text: "BEFORE_CRASH", omit: [] as string[] }));

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
      ].filter(({ id }) => !crash.omit.includes(id)),
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

it.each([
  "collision",
  "manifest crash",
  "publication crash",
  "writer lock",
  "legacy media",
  "approved deletion",
])("preserves prior snapshot after %s", async (mode) => {
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
    crash.text = "BEFORE_CRASH";
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
    if (mode === "writer lock") {
      const lockPath = path.join(out, ".export.lock");
      await fsp.writeFile(lockPath, "other writer owns this lock");
      for (const maintain of [runRepair, runRerender]) {
        await expect(maintain(cfg, createLogger("error"))).rejects.toMatchObject({
          code: "EEXIST",
        });
      }
      expect(await fsp.readFile(lockPath, "utf8")).toBe("other writer owns this lock");
    }
    if (mode === "approved deletion") {
      const baseline = JSON.parse(
        await fsp.readFile(path.join(first.exportRoot!, "verification.json"), "utf8"),
      );
      const approval = path.join(out, "approval.json");
      await fsp.writeFile(
        approval,
        JSON.stringify({
          version: 1,
          baselineSha256: baseline.manifestSha256,
          missing: [{ id: "page-2", object: "page" }],
          requiredSources: [],
        }),
      );
      const approved = { ...opts, deletionApprovalFile: approval };
      crash.omit = ["page-2"];
      vi.setSystemTime(new Date("2026-11-01T23:59:59Z"));
      await expect(runExport(cfg, createLogger("error"), approved)).rejects.toThrow(
        "destination must be newer",
      );

      crash.omit = ["page-2", "db-1"];
      vi.setSystemTime(new Date("2026-11-02T00:00:01Z"));
      await expect(runExport(cfg, createLogger("error"), approved)).rejects.toThrow(
        "exact missing sources",
      );
      crash.omit = ["page-2"];
      const requiredFile = path.join(out, "required.json");
      await fsp.writeFile(requiredFile, JSON.stringify([{ id: "page-2", object: "page" }]));
      await expect(
        runExport(
          { ...cfg, io: { ...cfg.io, requiredSourcesFile: requiredFile } },
          createLogger("error"),
          approved,
        ),
      ).rejects.toThrow("Required source missing or wrong kind");
      await expect(
        runExport(cfg, createLogger("error"), { ...approved, retention: 1 }),
      ).rejects.toThrow("explicit retention 0");

      vi.setSystemTime(new Date("2026-11-02T00:00:02Z"));
      const result = await runExport(cfg, createLogger("error"), approved);
      expect(await isVerifiedSnapshot(result.exportRoot!)).toBe(true);
      expect(await isVerifiedSnapshot(first.exportRoot!)).toBe(true);
      const reconciled = JSON.parse(
        await fsp.readFile(path.join(result.exportRoot!, "manifest.json"), "utf8"),
      );
      expect(reconciled.deletionApproval).toEqual(JSON.parse(await fsp.readFile(approval, "utf8")));
      expect(reconciled.entries.map((entry: { id: string }) => entry.id)).not.toContain("page-2");
      vi.setSystemTime(new Date("2026-11-02T00:00:03Z"));
      await expect(runExport(cfg, createLogger("error"), approved)).rejects.toThrow(
        "latest sealed baseline",
      );
      return;
    }
    if (mode === "legacy media") {
      const partial = path.join(out, "2026-11-02T00-00-01Z");
      const raw = path.join(partial, "raw", "pages");
      await fsp.mkdir(raw, { recursive: true });
      const record = path.join(raw, "page.json");
      const original = JSON.stringify({ blocks: [{ local_path: "assets/example.png" }] });
      await fsp.writeFile(record, original);
      await expect(
        runExport(cfg, createLogger("error"), { ...opts, resume: true }),
      ).rejects.toThrow("Legacy partial contains local media without asset records");
      expect(await fsp.readFile(record, "utf8")).toBe(original);
      expect(await fsp.readdir(partial)).toEqual(["raw"]);
      expect(await isVerifiedSnapshot(first.exportRoot!)).toBe(true);
      return;
    }
    if (mode !== "collision") vi.setSystemTime(new Date("2026-11-02T00:00:01Z"));
    let publicationLock: unknown;
    const originalRename = fsp.rename.bind(fsp);
    const renaming = vi
      .spyOn(fsp, "rename")
      .mockImplementation(async (...args: Parameters<typeof fsp.rename>) => {
        if (
          mode === "publication crash" &&
          path.basename(String(args[0])).startsWith(".staging-")
        ) {
          publicationLock = JSON.parse(await fsp.readFile(path.join(out, ".export.lock"), "utf8"));
          const reserved = await fsp.lstat(args[1], { bigint: true });
          expect(publicationLock).toMatchObject({
            version: 2,
            reservation: { device: reserved.dev.toString(), inode: reserved.ino.toString() },
            pid: process.pid,
            hostname: os.hostname(),
            stage: path.basename(String(args[0])),
            destination: path.basename(String(args[1])),
          });
          expect(await inspectRecovery(out)).toMatchObject({
            state: "observed-attempt",
            reservationMatches: true,
            stageVerification: "verified",
          });
          const stageManifest = path.join(String(args[0]), "manifest.json");
          const sealed = await fsp.readFile(stageManifest);
          await fsp.appendFile(stageManifest, " ");
          expect(await inspectRecovery(out)).toMatchObject({
            reservationMatches: true,
            stageVerification: "unverified",
          });
          await fsp.writeFile(stageManifest, sealed);
          throw new Error("injected publication crash");
        }
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
    if (mode === "publication crash") {
      await expect(runExport(cfg, createLogger("error"), opts)).rejects.toThrow(
        "injected publication crash",
      );
    } else {
      await expect(runExport(cfg, createLogger("error"), opts)).rejects.toThrow();
    }
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
    if (mode === "manifest crash" || mode === "publication crash") {
      const { findPartialExport } = await import("../src/export/manifest.js");
      expect(await findPartialExport(out)).toBeNull();
      vi.setSystemTime(new Date("2026-11-02T00:00:02Z"));
      const original = fsp.rename.bind(fsp);
      const destinations: string[] = [];
      const publishing = vi
        .spyOn(fsp, "rename")
        .mockImplementation(async (...args: Parameters<typeof fsp.rename>) => {
          if (path.basename(String(args[0])).startsWith(".staging-"))
            destinations.push(String(args[1]));
          return original(...args);
        });
      const retry = await runExport(cfg, createLogger("error"), { ...opts, resume: true });
      publishing.mockRestore();
      expect(destinations).toEqual([retry.exportRoot]);
      expect(await isVerifiedSnapshot(first.exportRoot!)).toBe(true);
      expect(await isVerifiedSnapshot(retry.exportRoot!)).toBe(true);
      if (mode === "publication crash") {
        // The injected exception unwinds normally. Restore the lock that a
        // terminated process would have left behind.
        const writerLock = path.join(out, ".export.lock");
        await fsp.writeFile(writerLock, JSON.stringify(publicationLock), { flag: "wx" });
        await expect(recoverStage(out, false)).rejects.toThrow("Confirm the original writer");
        const attempt = await inspectRecovery(out);
        const destination = path.join(out, attempt.destination!);
        const occupied = path.join(destination, "occupied");
        await fsp.writeFile(occupied, "preserve this");
        await expect(recoverStage(out, true)).rejects.toThrow("must be empty");
        expect(await fsp.readFile(occupied, "utf8")).toBe("preserve this");
        await fsp.unlink(occupied);

        const stage = path.join(out, attempt.stage!);
        const movedStage = path.join(out, "original-stage");
        await fsp.rename(stage, movedStage);
        await fsp.cp(movedStage, stage, { recursive: true });
        expect(await inspectRecovery(out)).toMatchObject({
          stageIdentityMatches: false,
          stageVerification: "verified",
        });
        await expect(recoverStage(out, true)).rejects.toThrow("original reservation");
        await fsp.rename(stage, path.join(out, "substitute-stage"));
        await fsp.rename(movedStage, stage);

        const contenders = await Promise.allSettled([
          recoverStage(out, true),
          recoverStage(out, true),
        ]);
        expect(contenders.filter((result) => result.status === "fulfilled")).toEqual([
          { status: "fulfilled", value: destination },
        ]);
        const rejected = contenders.find((result) => result.status === "rejected");
        expect(rejected?.reason).toMatchObject({ code: "EEXIST" });
        expect(await inspectRecovery(out)).toEqual({ state: "no-lock" });
        expect(await isVerifiedSnapshot(destination)).toBe(true);
        // Model termination after publication and before writer lock cleanup.
        await fsp.writeFile(writerLock, JSON.stringify(publicationLock), { flag: "wx" });
        const retainedLock = await fsp.readFile(writerLock);
        expect(await inspectRecovery(out)).toMatchObject({
          state: "observed-attempt",
          stageInfo: { state: "missing" },
          destinationVerification: "verified",
          destinationMatchesStageIdentity: true,
          reservationMatches: false,
        });
        await expect(recoverStage(out, true)).rejects.toThrow(
          "requires a verified stage and its original reservation",
        );
        expect(await fsp.readFile(writerLock)).toEqual(retainedLock);
        expect(await isVerifiedSnapshot(destination)).toBe(true);
        expect(await isVerifiedSnapshot(first.exportRoot!)).toBe(true);
        for (const [relative, text] of before) {
          expect(await fsp.readFile(path.join(first.exportRoot!, relative), "utf8")).toBe(text);
        }
      }
    }
  } finally {
    crash.omit = [];
    vi.useRealTimers();
    lookup.mockRestore();
    global.fetch = oldFetch;
    vi.restoreAllMocks();
    await fsp.rm(out, { recursive: true, force: true });
  }
});
