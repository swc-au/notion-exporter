# notion-exporter

[![CI](https://github.com/dmetzner/notion-exporter/actions/workflows/ci.yml/badge.svg)](https://github.com/dmetzner/notion-exporter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/notion-exporter.svg)](https://www.npmjs.com/package/notion-exporter)

A small, dependency-light CLI that backs up **one** Notion workspace to a
timestamped directory on your disk — raw JSON, readable Markdown, browsable
HTML, and every image/file pulled local before its signed URL expires. No
hosting, no OAuth, no SaaS dashboard: point a Nextcloud / Dropbox / Syncthing
folder at the output and you have an honest archive.

## Highlights

- **Three output formats in one pass** — full-fidelity `raw/` JSON, deterministic
  `markdown/` (no `notion-to-md` dependency), and a navigable `html/` mini-site
  with sidebar, sitemap, and client-side search.
- **Rich block coverage** — math equations (KaTeX, inline + block), native
  `<audio>` / `<video>` players, YouTube / Vimeo / Loom embed iframes, fallback
  bookmark cards for other embeds, and a click-to-zoom image lightbox.
- **Kanban-style database rendering** — Notion DBs grouped by a status or
  select property render as column-grouped kanban boards in HTML; override
  with `EXPORT_DB_VIEW=auto|table|kanban` to force a specific layout.
- **Per-database view config via Notion description** — drop a
  `%%notion-exporter` JSON fence into a database's description and the
  renderer honours `view` / `groupBy` / `order` / `hideFilters` /
  `cardMeta` for that DB. See [Recipes](#per-database-view-config) for the
  full key reference. JSON only (not YAML).
- **Canonical kanban column order** — when a DB ships with its
  data-source schema, kanban columns and select / status filter chips use
  the workspace's canonical option order. Precedence: `config.order`
  (description fence) > `dataSource` schema > built-in `STATUS_RANK`
  heuristic > first-occurrence (stable). "No status" is always anchored
  last.
- **Compact card view** — inline DBs nested in a `column_list` with
  small row counts and no cover images render as a quiet card list
  instead of full table chrome, so dashboard pages stay readable. Force
  a different layout per DB via the `%%notion-exporter` fence above.
- **Type-aware database filters** — inline DB views ship per-column filter
  chips for `select` / `status`, date and number range filters, a sort
  dropdown, and URL-hash filter state so a shared link reopens the same
  filtered view. Filter strip is collapsible.
- **Page comments** — top-level comments fetched and rendered inline with
  author and timestamp (requires the integration's **Read comments**
  capability).
- **Accessible by default** — WCAG-AA contrast on every swatch in both light
  and dark themes, enforced by `pnpm contrast`.
- **Custom Markdown converter** — extend `src/export/markdown/blocks.ts` for new
  block types; behavior stays deterministic and snapshot-tested.
- **Incremental + resume on by default** — re-runs only re-fetch pages whose
  `last_edited_time` changed, and a crash mid-export picks up where it stopped.
- **Retention pruning** — keep the last N stamped exports, prune the rest.
- **Custom workspace branding** — set `EXPORT_TITLE` and `EXPORT_ICON` (emoji
  or path) for the HTML sidebar.
- **Rate-limited Notion client** — Bottleneck + exponential 429/5xx retry so
  large workspaces don't get throttled.
- **Asset deduplication** — content-addressed `assets/` directory; identical
  images appear once on disk.
- **Rerender + repair commands** — fix renderer bugs or re-sign expired asset
  URLs without re-fetching the whole workspace.

## Requirements

- **Node.js ≥ 22.19** (LTS). Earlier versions are not supported.
- **pnpm 9+** — only for working from source. Runtime install via `npm` / `npx` works without pnpm.

## Quick start

```bash
# One-shot, no install
export NOTION_TOKEN=secret_xxx
npx notion-exporter check         # verify token + visibility
npx notion-exporter export        # writes ./exports/<timestamp>/
```

From source:

```bash
git clone https://github.com/dmetzner/notion-exporter
cd notion-exporter
pnpm install
cp .env.example .env              # then edit NOTION_TOKEN
pnpm dev check                    # validate setup
pnpm dev export                   # run from source via tsx
```

## Setup in 3 minutes

1. Open <https://www.notion.so/my-integrations> and create a new **internal**
   integration. Copy the secret (`secret_…`).
2. Put it in `.env` as `NOTION_TOKEN=…` (start from [`.env.example`](.env.example)).
3. In Notion, open the top-level page or teamspace you want to back up and
   click **··· → Connections → \<your integration\>**. Child pages inherit
   access — for a private workspace you typically share once at the top.
4. Run `pnpm dev check` (or `npx notion-exporter check`). If it reports
   `0 visible objects`, you haven't shared anything yet — go back to step 3.
5. **Optional — enable comments.** In the integration's **Capabilities** tab,
   tick **Read comments**. Without it, `export` silently omits the comments
   section (no error). If you grant it after a first run, do `pnpm dev export
   --force` to backfill — `rerender` reads from disk and can't pull new
   comments on its own.

## Commands

| Command    | When to use                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| `check`    | Smoke-test `NOTION_TOKEN` and list how many objects the integration sees.   |
| `export`   | The main one. Crawl, fetch, render, write a fresh stamped export directory. |
| `rerender` | Regenerate Markdown/HTML/sitemap/search from existing `raw/` JSON — no API. |
| `repair`   | Retry assets that failed last run (re-signs expired Notion S3 URLs).        |

### `export` flags

| Flag               | Default      | Effect                                                                                       |
| ------------------ | ------------ | -------------------------------------------------------------------------------------------- |
| `-f`, `--force`    | off          | Full fresh export: ignore previous output, refetch everything (= `--no-incremental --no-resume`). |
| `--no-incremental` | off          | Re-fetch every page even if `last_edited_time` is unchanged (default: incremental ON).       |
| `--no-resume`      | off          | Start fresh instead of continuing a partial export (default: resume ON).                     |
| `--no-progress`    | off          | Disable the TTY progress bar; emit JSON logs only (auto-off in non-TTY).                     |
| `--dry-run`        | off          | List object IDs the integration sees without writing any files.                              |
| `--out <dir>`      | `./exports`  | Output directory for the stamped export (overrides `OUT_DIR`).                               |
| `--retention <n>`  | `0`          | Keep only the last N stamped exports under `--out`. `0` = keep all (overrides `RETENTION`).  |

## Desktop launcher & automation

The optional [`launcher/`](launcher/) folder wraps the CLI in a cross-platform
convenience layer: one command (or one click) to pull the latest code, rebuild,
run an `export`, and open the result — plus an opt-in daily schedule.

| Front-end        | Run it                                                                | Platform |
| ---------------- | --------------------------------------------------------------------- | -------- |
| Terminal UI      | `node launcher/tui.mjs`                                               | any      |
| One-shot CLI     | `node launcher/refresh.mjs [flags]`                                  | any      |
| Windows tray app | double-click `launcher/windows/launch.vbs` (Update / Export / Open / daily schedule) | Windows  |

`refresh.mjs` flags: `--no-open`, `--no-update` (export only), `--no-export`
(update only). Full design, plus the Windows desktop-icon and scheduled-task
setup, is documented in [`launcher/README.md`](launcher/README.md).

## Two things to know before you start

**The first export is slow, and that is Notion's API, not this tool.** Everything
is fetched through a rate-limited client (`NOTION_MIN_TIME` 150 ms between calls,
`NOTION_MAX_CONCURRENT` 4), because the alternative is a wall of 429s. A page costs
at least one request and usually several — its block tree is paginated, and databases
add a query per view. On a real workspace of ~830 pages and databases with ~660
assets, that is thousands of sequential-ish requests: budget **tens of minutes to a
few hours** for a cold run, and leave it going. This is the shape of the problem, not
a bug to report.

The good news is that you pay it once. Incremental mode is on by default, so later
runs re-fetch only pages whose `last_edited_time` moved and skip the rest — typically
minutes. A crash mid-export resumes rather than starting over. Raising
`NOTION_MAX_CONCURRENT` mostly buys you 429s and backoff; the defaults are chosen
to be boringly reliable overnight.

**The HTML output is opinionated, and the opinions are the author's.** The renderer
was built against one real workspace and its conventions, so the styling, sidebar
layout, database view heuristics (`auto` picks kanban when a database is grouped by
status/select, else table) and touches like `STYLE_BACK_LINKS` reflect how those
pages happen to be written. It is deliberately not a neutral, theme-agnostic
exporter yet. Expect to want changes if your workspace looks different — the styles
are split into small modules under `src/export/styles/` and the Markdown converter is
extensible per block type, so this is meant to be edited rather than fought. Issues
and PRs that generalise a hardcoded assumption are the most welcome kind.

If you only want the data and not the presentation, `raw/*.json` and `markdown/` are
untouched by any of this.

## Configuration

All settings come from environment variables (or a `.env` / `.env.local` file
in the working directory). See [`.env.example`](.env.example) for a copy-paste
starting point.

### Core

| Var            | Type   | Default              | Meaning                                                       |
| -------------- | ------ | -------------------- | ------------------------------------------------------------- |
| `NOTION_TOKEN` | string | _(required)_         | Internal integration token (`secret_…`).                      |
| `OUT_DIR`      | string | `./exports`          | Parent directory for timestamped export dirs.                 |
| `RETENTION`    | int    | `0`                  | Keep only the N newest stamped exports. `0` = keep all.       |
| `LOG_LEVEL`    | enum   | `info`               | One of `trace`, `debug`, `info`, `warn`, `error`.             |

### Output

| Var                 | Type        | Default              | Meaning                                                                                          |
| ------------------- | ----------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `EXPORT_TITLE`      | string      | `Your Notion archive` | Workspace title shown in the HTML sidebar header.                                                |
| `EXPORT_ICON`       | string      | `📚`                  | Single emoji glyph, or a path (relative to `html/`) to an image used as the sidebar icon.        |
| `EXPORT_ROW_MEDIA`  | bool        | `true`               | Download per-row cover/icon images on databases. Set `false` to skip row icon/cover downloads. Snapshots with required row media left remote-only cannot pass preservation verification.    |
| `EXPORT_DB_VIEW`    | enum        | `auto`               | Database view layout: `auto` (kanban when grouped by status/select, else table), `table`, or `kanban`. |
| `EXPAND_CHILD_PAGES`| bool        | `true`               | Walk block trees to discover subpages `search` misses. Disable only if `search` already returns everything. |
| `PRETTY_RAW_JSON`   | bool        | `true`               | Pretty-print `raw/*.json`. Set `false` for compact JSON on very large workspaces.                |
| `STYLE_BACK_LINKS`  | bool        | `false`              | Style "↩️ Back to …" links below an H1 as a pill — opt-in personal convention.                  |

### Performance

| Var                  | Type | Default | Meaning                                                                                               |
| -------------------- | ---- | ------- | ----------------------------------------------------------------------------------------------------- |
| `ASSET_CONCURRENCY`  | int  | `16`    | Parallel asset downloads (1–64).                                                                      |
| `PAGE_CONCURRENCY`   | int  | `4`     | Parallel page renders (1–32).                                                                         |
| `CRAWL_CONCURRENCY`  | int  | `8`     | Parallel block-tree walks during discovery (1–32).                                                    |

### Notion API

| Var                    | Type | Default | Meaning                                                                  |
| ---------------------- | ---- | ------- | ------------------------------------------------------------------------ |
| `NOTION_MIN_TIME`      | int  | `150`   | Min ms between API calls (Bottleneck `minTime`).                         |
| `NOTION_MAX_CONCURRENT`| int  | `4`     | Max concurrent in-flight Notion requests.                                |
| `NOTION_MAX_RETRIES`   | int  | `8`     | Retries on 429 / 5xx with exponential backoff.                           |

## Output layout

```
exports/2026-05-29T14-00-00Z/
├── raw/
│   ├── pages/<title>.<id>.json
│   └── databases/<title>.<id>.json
├── markdown/
│   └── <hierarchy>/<title>.<id>.md
├── html/
│   ├── index.html               # navigable sitemap + sidebar
│   ├── assets/                  # sidebar CSS/JS, icons
│   └── <hierarchy>/<title>.<id>.html
├── assets/                      # content-addressed, deduped
│   └── <sha-prefix>.<ext>
├── search-index.json            # client-side search payload
├── state.json                   # incremental + resume bookkeeping
└── manifest.json                # counts, content hashes, tool version
```

## Reprocessing without re-fetching

Two operations skip the Notion API entirely and reuse what's already on disk:

```bash
# Renderer changed? Regenerate md/html/sitemap/search from raw/ JSON.
pnpm dev rerender
pnpm dev rerender --export ./exports/2026-05-29T14-00-00Z

# Some assets failed (expired S3 URL, transient network)? Refresh just those.
pnpm dev repair
pnpm dev repair --export ./exports/2026-05-29T14-00-00Z
```

Both default to the most recent export under `OUT_DIR` when `--export` is omitted.

## Restore

The Notion API does not support full restore programmatically. This tool is a
**backup / archive**, not a sync. Keep the `raw/` JSON and `assets/` — if you
need a page back, drag the Markdown file into Notion or use
[Notion's import](https://www.notion.so/help/import-data-into-notion). This is
by design; see [SECURITY.md](SECURITY.md) for the rationale.

## View modes

Inline databases pick one of four HTML layouts at render time. The
default is `auto`; the `%%notion-exporter` fence (see below) and the
`EXPORT_DB_VIEW` env var can both override it.

| Mode      | Picked when                                                                                  |
| --------- | -------------------------------------------------------------------------------------------- |
| `table`   | Default. Full table chrome with sortable headers and filter chips.                           |
| `kanban`  | DB is grouped by a `status` or `select` property (auto) or forced via fence / env override.  |
| `gallery` | Rows carry cover images (auto when covers are present).                                      |
| `compact` | DB is nested inside a `column_list`, has ≤ 8 rows, and no cover images — renders as a quiet card list. |

## Recipes

### Per-database view config

Drop a `%%notion-exporter` fence into a database's description in Notion
and the renderer will read it on every export / rerender:

```
%%notion-exporter
{"view":"kanban","groupBy":"Status","order":["Todo","Doing","Done"]}
%%
```

The body is **JSON** (not YAML — a YAML-shaped body is rejected with a
warn log). All five keys are optional:

| Key           | Type                | Effect                                                                                                  |
| ------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `view`        | `table \| kanban \| gallery \| compact` | Force a specific layout, bypassing the `auto` heuristic and `EXPORT_DB_VIEW`.       |
| `groupBy`     | string              | Property name to group on for kanban view (must be `status` / `select` / `multi_select`).               |
| `order`       | string[]            | Explicit column order. Beats the canonical schema order and `STATUS_RANK`. Unlisted columns trail.       |
| `hideFilters` | boolean             | Hide the filter strip on inline DB views (chips, range filters, sort dropdown).                          |
| `cardMeta`    | string[]            | Property names to surface as meta lines under each kanban / gallery / compact card title.                |

### Verify colour contrast (WCAG-AA)

```bash
pnpm contrast
```

One-shot check of every text/background swatch in `src/export/styles/`
against WCAG-AA in both light and dark themes. CI runs this on every PR;
run it locally after touching any colour value.

### Nightly cron (Linux/macOS)

```cron
0 3 * * *  cd /srv/notion-exporter && /usr/bin/env NOTION_TOKEN=$(cat .token) node dist/cli.js export --retention 30 >> log 2>&1
```

### docker-compose with Nextcloud sync

> The `ghcr.io/dmetzner/notion-exporter` image is published by the
> release workflow on `v*.*.*` tags — available after the first tagged
> release. Until then, build locally with `docker build -t notion-exporter .`
> and swap the `image:` line for `image: notion-exporter`.

```yaml
services:
  notion-exporter:
    image: ghcr.io/dmetzner/notion-exporter:latest
    environment:
      NOTION_TOKEN: ${NOTION_TOKEN}
      RETENTION: "30"
    volumes:
      - /mnt/nextcloud-sync/Notion-Backup:/exports
    restart: "no"
```

Schedule the container with a cron or systemd timer; the Nextcloud client
picks up the output on its own.

### GitHub Action (push backup to a private repo)

```yaml
name: Notion backup
on:
  schedule: [{ cron: "0 3 * * *" }]
  workflow_dispatch:
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx notion-exporter@latest export --out backup --retention 30
        env:
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
      - run: |
          git config user.email backup@example.com
          git config user.name "Backup Bot"
          git add backup && git diff --cached --quiet || git commit -m "backup $(date -u +%FT%TZ)"
          git push
```

## Development

```bash
pnpm install
pnpm dev export    # run from source via tsx
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome
pnpm build         # tsup → dist/cli.js
```

Roadmap: [ROADMAP.md](ROADMAP.md). Release notes live in git history and on the [Releases page](https://github.com/dmetzner/notion-exporter/releases).

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Issues with reproduction
steps are gold.

## Security

See [SECURITY.md](SECURITY.md). The tool stores a Notion token — treat it like
a password.

## License

MIT — see [LICENSE](LICENSE).

### Independent required-source coverage

Set `REQUIRED_SOURCES_FILE` to an owner-maintained JSON file outside the export directory:

```json
[{"id":"00000000-0000-0000-0000-000000000001","object":"page"}]
```

List required pages and databases using the exact API IDs and `page` or `database` kinds. The list must be nonempty, unique and independently confirmed; do not generate it from the same crawl being checked. A missing file, malformed policy, missing source or kind mismatch aborts before export output, resume or retention. Extra discovered content is allowed. The policy is saved in the manifest and checked during archive verification; repair and rerender preserve it.

This proves only that the listed sources are included, not complete descendant or database-row access. Without this optional policy, verification checks discovered-source integrity and historical source-loss protection; it does not establish first-run workspace coverage. Establish the real expected list separately before relying on a live backup. Legitimate deletions still require explicit reconciliation; changing the required list does not bypass historical source-loss checks.
