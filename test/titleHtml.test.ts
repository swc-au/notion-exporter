import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { enrichSitemapTitleHtml } from "../src/commands/export.js";
import { loadConfig } from "../src/config.js";
import { createAssetCollector } from "../src/export/assets.js";
import { formatProp } from "../src/export/markdown.js";
import { buildPaths } from "../src/export/paths.js";
import { type RenderContext, renderPage } from "../src/export/pipeline.js";
import { enrichTitleHtml } from "../src/export/titleHtml.js";
import { createLogger } from "../src/logger.js";

// `enrichTitle*` helpers are consolidated into `src/export/titleHtml.ts`.
// These tests pin the attr-escape-first invariant across all callsites.

describe("titleHtml: shared enrichTitleHtml escapes the whole title", () => {
  it("escapes script-like payloads outside the :slug: match", () => {
    const map = new Map<string, string>([["smile", "assets/abcd.png"]]);
    const html = enrichTitleHtml("<script>alert(1)</script> :smile:", map);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script>/i);
    expect(html).toContain('<img class="custom-emoji"');
    expect(html).toContain('src="assets/abcd.png"');
    expect(html).toContain('alt="smile"');
  });

  it("escapes attribute-breaking quotes and angle brackets in the title", () => {
    const map = new Map<string, string>([["wave", "assets/wave.png"]]);
    const html = enrichTitleHtml('Hello " onclick=alert(1) " :wave: <img src=x>', map);
    expect(html).not.toContain('" onclick=alert(1) "');
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;img");
  });

  it('url-escapes a tampered local_path so it can\'t break out of src="…"', () => {
    const map = new Map<string, string>([["evil", 'assets/x" onerror=alert(1)']]);
    const html = enrichTitleHtml(":evil:", map);
    // The injected quote MUST be url-encoded (%22) — never raw inside src="…".
    expect(html).not.toContain('"x" onerror=alert(1)');
    // `urlEsc` encodes `"` `(` `)` ` ` etc — none of them can break the attr.
    expect(html).toContain("%22"); // "
    expect(html).toContain("%28"); // (
    expect(html).toContain("%29"); // )
    expect(html).toMatch(/<img class="custom-emoji" src="[^"]*" alt="evil" title="evil">/);
  });

  it("returns the attr-escaped title when no shortcodes match", () => {
    expect(enrichTitleHtml("<b>plain</b>", new Map())).toBe("&lt;b&gt;plain&lt;/b&gt;");
  });

  it("leaves unknown shortcodes as escaped literal text", () => {
    const html = enrichTitleHtml(":unknown: <b>", new Map([["other", "assets/x.png"]]));
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain(":unknown:");
    expect(html).not.toContain("<img");
  });

  it("returns the literal shortcode when resolveSrc throws (defense in depth)", () => {
    // pipeline.ts wires `assertWithinRoot` into `resolveSrc`; a tampered raw
    // JSON with a path-traversing local_path would otherwise abort the whole
    // render. The throw should be swallowed and the literal `:slug:` preserved.
    const map = new Map<string, string>([["smile", "assets/../escape.png"]]);
    const html = enrichTitleHtml("hello :smile: world", map, () => {
      throw new Error("path escapes root");
    });
    expect(html).toContain(":smile:");
    expect(html).not.toContain("<img");
    expect(html).toContain("hello");
    expect(html).toContain("world");
  });
});

describe("titleHtml: integration across all four callsites", () => {
  it("export.enrichSitemapTitleHtml ships escaped <script> for a tampered title", () => {
    const map = new Map<string, string>([["smile", "assets/abcd.png"]]);
    const html = enrichSitemapTitleHtml("<script>alert(1)</script> :smile:", map);
    expect(html).not.toBeNull();
    expect(html!).toContain("&lt;script&gt;");
    expect(html!).not.toMatch(/<script>/i);
  });

  // pipeline.enrichTitle is exercised end-to-end via renderPage: a tampered
  // child-page title flows into the `<h1>` titleHtml + breadcrumb + page-link
  // card. Specifically: when the customEmojiByName map is empty, the title
  // must still be attr-escaped (a prior impl bailed early and returned the
  // raw title verbatim).
  it("pipeline.renderPage escapes a tampered title in the page H1", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-title-pipeline-"));
    await fsp.mkdir(path.join(tmp, "assets"), { recursive: true });
    await fsp.mkdir(path.join(tmp, "markdown"), { recursive: true });
    await fsp.mkdir(path.join(tmp, "html"), { recursive: true });

    const cfg = loadConfig({ NOTION_TOKEN: "secret_x", OUT_DIR: tmp });
    const log = createLogger("error");
    const paths = buildPaths(path.dirname(tmp), path.basename(tmp));
    const assets = createAssetCollector({
      assetsDir: paths.assets,
      exportRoot: paths.root,
      log,
      concurrency: 1,
    });

    const pageId = "xss1-page-id-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const evilTitle = "<script>alert(1)</script>";
    const pageIndex = new Map([
      [
        pageId,
        {
          id: pageId,
          title: evilTitle,
          kind: "page" as const,
          mdAbsPath: path.join(paths.markdown, `evil.${pageId}.md`),
          subdir: "",
        },
      ],
    ]);

    const ctx: RenderContext = {
      paths,
      pageIndex,
      dbDataById: new Map(),
      // When the map is EMPTY, the title must still be attr-escaped (a
      // prior impl bailed early and returned the raw title).
      customEmojiByName: new Map(),
      archiveIcon: cfg.render.exportIcon,
      archiveTitle: cfg.render.exportTitle,
      cfg,
      assets,
      log,
      exportTimestamp: "2025-01-02T00:00:00.000Z",
      ancestorIds: () => [],
    };

    const rendered = await renderPage(
      ctx,
      {
        id: pageId,
        title: evilTitle,
        page: { id: pageId, parent: { type: "workspace" } },
        blocks: [],
      },
      {},
    );
    expect(rendered).not.toBeNull();
    const md = rendered!.md;
    const html = await fsp.readFile(rendered!.htmlAbs, "utf8");
    // The H1 markdown line and the rendered HTML must both carry the
    // escaped form. A raw `<script>` would slip through marked unchanged
    // because pageToMarkdown interpolates `titleHtml` directly into the H1.
    expect(md).not.toContain("<script>alert(1)</script>");
    expect(md).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);

    await fsp.rm(tmp, { recursive: true, force: true });
  });
});

describe("pipeline.pagePropertiesRow: formatProp output gets HTML-escaped", () => {
  // `formatProp`'s return contract is mixed — relation/rollup/title/rich_text
  // emit HTML; select/status/email/etc. return raw operator-controlled text.
  // A prior shape interpolated the raw text into `<td>${value}</td>` with no
  // escape, shipping XSS via a workspace member's select-option name.
  it("escapes a malicious select option name in the page-props <td>", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-props-xss-"));
    await fsp.mkdir(path.join(tmp, "assets"), { recursive: true });
    await fsp.mkdir(path.join(tmp, "markdown"), { recursive: true });
    await fsp.mkdir(path.join(tmp, "html"), { recursive: true });

    const cfg = loadConfig({ NOTION_TOKEN: "secret_x", OUT_DIR: tmp });
    const log = createLogger("error");
    const paths = buildPaths(path.dirname(tmp), path.basename(tmp));
    const assets = createAssetCollector({
      assetsDir: paths.assets,
      exportRoot: paths.root,
      log,
      concurrency: 1,
    });

    const pageId = "props-page-id-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pageIndex = new Map([
      [
        pageId,
        {
          id: pageId,
          title: "Row",
          kind: "page" as const,
          mdAbsPath: path.join(paths.markdown, `Row.${pageId}.md`),
          subdir: "",
        },
      ],
    ]);

    const ctx: RenderContext = {
      paths,
      pageIndex,
      dbDataById: new Map(),
      customEmojiByName: new Map(),
      archiveIcon: cfg.render.exportIcon,
      archiveTitle: cfg.render.exportTitle,
      cfg,
      assets,
      log,
      exportTimestamp: "2025-01-02T00:00:00.000Z",
      ancestorIds: () => [],
    };

    // DB-row page with a select property whose `.name` is a script payload.
    const rawPage = {
      id: pageId,
      parent: { type: "database_id", database_id: "db-id" },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Row" }] },
        Status: { type: "select", select: { name: "<script>alert(1)</script>", color: "red" } },
      },
    };

    const rendered = await renderPage(
      ctx,
      { id: pageId, title: "Row", page: rawPage, blocks: [] },
      { formatProp },
    );
    expect(rendered).not.toBeNull();
    const html = await fsp.readFile(rendered!.htmlAbs, "utf8");
    expect(html).toContain('class="page-props"');
    // The malicious select name MUST be escaped inside the <td>.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // And the raw form MUST NOT appear inside the page-props table.
    const propsStart = html.indexOf('class="page-props"');
    const propsEnd = html.indexOf("</table>", propsStart);
    const propsSlice = html.slice(propsStart, propsEnd);
    expect(propsSlice).not.toMatch(/<script>alert\(1\)<\/script>/);

    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("renders a nested row with local media and safe URL properties", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-props-xss-"));
    await fsp.mkdir(path.join(tmp, "assets"), { recursive: true });
    await fsp.mkdir(path.join(tmp, "markdown"), { recursive: true });
    await fsp.mkdir(path.join(tmp, "html"), { recursive: true });

    const cfg = loadConfig({ NOTION_TOKEN: "secret_x", OUT_DIR: tmp });
    const log = createLogger("error");
    const paths = buildPaths(path.dirname(tmp), path.basename(tmp));
    const assets = createAssetCollector({
      assetsDir: paths.assets,
      exportRoot: paths.root,
      log,
      concurrency: 1,
    });

    const pageId = "props-page-id-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pageIndex = new Map([
      [
        pageId,
        {
          id: pageId,
          title: "Row",
          kind: "page" as const,
          mdAbsPath: path.join(paths.markdown, "section", `Row.${pageId}.md`),
          subdir: "section",
        },
      ],
    ]);

    const ctx: RenderContext = {
      paths,
      pageIndex,
      dbDataById: new Map(),
      customEmojiByName: new Map(),
      archiveIcon: cfg.render.exportIcon,
      archiveTitle: cfg.render.exportTitle,
      cfg,
      assets,
      log,
      exportTimestamp: "2025-01-02T00:00:00.000Z",
      ancestorIds: () => [],
    };

    const rawPage = {
      id: pageId,
      parent: { type: "database_id", database_id: "db-id" },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Row" }] },
        Source: { type: "url", url: "https://example.com/source.md" },
      },
    };

    const rendered = await renderPage(
      ctx,
      {
        id: pageId,
        title: "Row",
        page: rawPage,
        blocks: [{ id: "image-id", type: "image", image: { local_path: "assets/photo.jpg" } }],
      },
      { formatProp },
    );
    expect(rendered).not.toBeNull();
    const html = await fsp.readFile(rendered!.htmlAbs, "utf8");
    const md = await fsp.readFile(rendered!.mdAbs, "utf8");
    expect(md).toContain("![](../../assets/photo.jpg)");
    expect(html).toContain('src="../../assets/photo.jpg"');
    expect(html).toContain(
      '<a href="https://example.com/source.md">https://example.com/source.md</a>',
    );

    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("escapes a malicious property NAME (column header) too", async () => {
    // The name comes from `Object.entries(p.properties)`, which is the
    // operator-controlled property key. `renderPropertyTable` already runs
    // it through `escapeHtmlText` — this pins that gate.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-props-name-"));
    await fsp.mkdir(path.join(tmp, "assets"), { recursive: true });
    await fsp.mkdir(path.join(tmp, "markdown"), { recursive: true });
    await fsp.mkdir(path.join(tmp, "html"), { recursive: true });

    const cfg = loadConfig({ NOTION_TOKEN: "secret_x", OUT_DIR: tmp });
    const log = createLogger("error");
    const paths = buildPaths(path.dirname(tmp), path.basename(tmp));
    const assets = createAssetCollector({
      assetsDir: paths.assets,
      exportRoot: paths.root,
      log,
      concurrency: 1,
    });

    const pageId = "propname-page-id-aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pageIndex = new Map([
      [
        pageId,
        {
          id: pageId,
          title: "Row",
          kind: "page" as const,
          mdAbsPath: path.join(paths.markdown, `Row.${pageId}.md`),
          subdir: "",
        },
      ],
    ]);

    const ctx: RenderContext = {
      paths,
      pageIndex,
      dbDataById: new Map(),
      customEmojiByName: new Map(),
      archiveIcon: cfg.render.exportIcon,
      archiveTitle: cfg.render.exportTitle,
      cfg,
      assets,
      log,
      exportTimestamp: "2025-01-02T00:00:00.000Z",
      ancestorIds: () => [],
    };

    const evilColName = "<img src=x onerror=alert(1)>";
    const rawPage = {
      id: pageId,
      parent: { type: "database_id", database_id: "db-id" },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Row" }] },
        [evilColName]: { type: "select", select: { name: "ok", color: "red" } },
      },
    };

    const rendered = await renderPage(
      ctx,
      { id: pageId, title: "Row", page: rawPage, blocks: [] },
      { formatProp },
    );
    expect(rendered).not.toBeNull();
    const html = await fsp.readFile(rendered!.htmlAbs, "utf8");
    const propsStart = html.indexOf('class="page-props"');
    const propsEnd = html.indexOf("</table>", propsStart);
    const propsSlice = html.slice(propsStart, propsEnd);
    expect(propsSlice).toContain("&lt;img");
    expect(propsSlice).not.toContain("<img src=x");

    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("rich_text property with href renders <a> in <td>, not literal [text](url)", async () => {
    // `formatProp("rich_text"/"title")` goes through `rt()`, which emits
    // `[text](url)` markdown for href annotations. The page-props table
    // inlines the value into `<td>${p.value}</td>` with no marked-pass, so
    // without the `mdLinksToAnchors` conversion the brackets would surface
    // literally in the rendered HTML.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ne-props-href-"));
    await fsp.mkdir(path.join(tmp, "assets"), { recursive: true });
    await fsp.mkdir(path.join(tmp, "markdown"), { recursive: true });
    await fsp.mkdir(path.join(tmp, "html"), { recursive: true });

    const cfg = loadConfig({ NOTION_TOKEN: "secret_x", OUT_DIR: tmp });
    const log = createLogger("error");
    const paths = buildPaths(path.dirname(tmp), path.basename(tmp));
    const assets = createAssetCollector({
      assetsDir: paths.assets,
      exportRoot: paths.root,
      log,
      concurrency: 1,
    });

    const pageId = "propshref-page-id-aaaaaaaaaaaaaaaaaaaaaaaa";
    const pageIndex = new Map([
      [
        pageId,
        {
          id: pageId,
          title: "Row",
          kind: "page" as const,
          mdAbsPath: path.join(paths.markdown, `Row.${pageId}.md`),
          subdir: "",
        },
      ],
    ]);

    const ctx: RenderContext = {
      paths,
      pageIndex,
      dbDataById: new Map(),
      customEmojiByName: new Map(),
      archiveIcon: cfg.render.exportIcon,
      archiveTitle: cfg.render.exportTitle,
      cfg,
      assets,
      log,
      exportTimestamp: "2025-01-02T00:00:00.000Z",
      ancestorIds: () => [],
    };

    const rawPage = {
      id: pageId,
      parent: { type: "database_id", database_id: "db-id" },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Row" }] },
        Notes: {
          type: "rich_text",
          rich_text: [
            {
              type: "text",
              plain_text: "see docs",
              href: "https://example.com/docs",
            },
          ],
        },
      },
    };

    const rendered = await renderPage(
      ctx,
      { id: pageId, title: "Row", page: rawPage, blocks: [] },
      { formatProp },
    );
    expect(rendered).not.toBeNull();
    const html = await fsp.readFile(rendered!.htmlAbs, "utf8");
    const propsStart = html.indexOf('class="page-props"');
    const propsEnd = html.indexOf("</table>", propsStart);
    const propsSlice = html.slice(propsStart, propsEnd);
    // Real <a> anchor in the <td> — not literal markdown link syntax.
    expect(propsSlice).toContain('<a href="https://example.com/docs">see docs</a>');
    expect(propsSlice).not.toContain("[see docs](https://example.com/docs)");

    await fsp.rm(tmp, { recursive: true, force: true });
  });
});
