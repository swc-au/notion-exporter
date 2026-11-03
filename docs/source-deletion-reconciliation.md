# Source deletion reconciliation design

An export can lose access to a page or database while still successfully reading everything visible to its integration. The historical inventory guard rejects that export when an ID from the latest sealed inventory is missing. A genuine deletion looks the same to this guard. Absence from a crawl, or a response that can also mean lost permission, cannot authorize a deletion.

Run `notion-exporter inspect-source-loss --out <history-root> --candidate <candidate-root>` to list missing sources and changed kinds against the latest sealed inventory. It verifies the local candidate, including its recorded required sources, and can read a stage that passed archive integrity but was blocked by the historical source-loss guard. The report is diagnostic and has no effect on publication. An operator would independently check the missing sources, confirm deletion, and review their required-source policy. The review artifact should bind the exact approved IDs and kinds to the SHA-256 of the historical sealed manifest and to the intended required-source policy. Required sources must still pass the current coverage check. Moving an ID out of that policy is a separate explicit change.

A fresh export would consume an artifact only when the sealed baseline still matches and the set of missing IDs and kinds exactly equals the approved set. Any unexpected missing ID, reappearance, kind mismatch, stale baseline, or invalid artifact must stop publication. The new manifest should capture the approved reconciliation and its baseline digest for later review. The initial reconciliation should keep retention disabled so the prior snapshot remains readable with the deleted content. The approval becomes stale once the new snapshot becomes the baseline.

Use offline fixtures to test one approved deletion, a deletion mixed with access loss, changed kind, stale baseline, a still-required deleted ID, and an interrupted or retried publication. For every rejection, confirm the earlier snapshot is unchanged and remains eligible for verification.

## Apply an independently confirmed deletion

Create an approval JSON file with the following fields. Copy the baseline digest from `inspect-source-loss`. The `missing` list uses `object` for the kind, and the `requiredSources` list must match the policy used by the export. An empty policy is represented by `[]`.

```json
{
  "version": 1,
  "baselineSha256": "<64-character digest from the report>",
  "missing": [{ "id": "<confirmed deleted ID>", "object": "page" }],
  "requiredSources": []
}
```

Run the fresh export against the same output root:

```sh
notion-exporter export --out <history-root> --force --retention 0 \
  --deletion-approval <approval.json>
```

The destination timestamp must sort after the baseline timestamp. This prevents a clock rollback from publishing an archive that would leave the same approval eligible for reuse. The new sealed manifest records the approval. The prior snapshot stays in the output root, and the same approval cannot be reused once the reconciled snapshot becomes the latest sealed baseline. The approval is an operator assertion about confirmed deletions. The exporter can validate the exact IDs, baseline, and policy, but it cannot independently determine why a source disappeared.
