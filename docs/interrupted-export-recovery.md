# Recover from an interrupted export

A terminated export can leave `.export.lock`, a hidden `.staging-*` directory, and an empty timestamp directory in the output root. A termination after publication can leave the lock alongside a fully published timestamp directory. Treat each of these as separate evidence.

1. Pause scheduled exports and maintenance for the affected root. Check the original launcher or host to confirm the exporter and any maintenance processes have stopped. The lock records a PID and start time. A missing local PID or an old timestamp alone cannot establish ownership or inactivity on another host.
2. Keep the affected root intact. Check the published snapshot against its sealed manifest before relying on it. Compare the manifest digest with the verification marker and check the size and SHA-256 of each raw record and local asset. The marker alone cannot detect changes made after publication. An empty timestamp directory is a reservation. A hidden stage may contain incomplete files or may have finished verification just before the process stopped.
3. If a fresh snapshot is needed, export into a new output root using the same required-source inventory. Use `export --force --retention 0 --out <new-root>` to disable resume, incremental reuse and retention for that run. Verify the new published snapshot before pointing readers or maintenance jobs to it. Keep the earlier verified snapshot available independently.
4. Record the affected root, last verified snapshot, recovery root, and the verification results. Treat disposal of the old lock, stages and reservations as a separate operator decision after confirming who owns the root and that its readers and writers have moved.

Version 2 lock records include the hostname, stage, destination, and the device and inode observed after exclusive reservation. A crash before this record is complete can leave an empty reservation and an unusable lock. A matching device and inode is diagnostic evidence, since filesystems can reuse identifiers. Stage age, directory order and the presence of a verification marker do not establish that binding. The fresh export path above leaves the interrupted attempt available for investigation.

Run `notion-exporter inspect-recovery --out <affected-root>` to inspect a fresh export attempt. The command reports missing or unrecognized lock records, the observed directory types, and whether the current destination identity matches the record. Its output is a point-in-time observation. For a staged directory it also checks the verification marker and revalidates the snapshot using the same verifier used for retention. A verified result records what passed during inspection and does not establish writer inactivity.

## Requirements for in-place recovery

A future recovery command needs an ownership mechanism shared by export and maintenance, plus a durable attempt record that binds the lock owner, stage and reserved destination. It must verify the stage again before publication and refuse a destination that no longer belongs to that attempt. Legacy or ambiguous state should remain available for manual investigation.

Exercise interruption before lock metadata is written, after reservation, during stage writes, after verification, and after publication. Include concurrent writers, PID reuse, a different host, corrupt stages and occupied destinations. For every rejected recovery, compare the earlier verified archive byte for byte. Resuming a partial archive also requires reconstructing and validating its asset records before verification.

### Publish a verified stage

Keep the original `.export.lock` in place throughout recovery so export, repair, and rerender remain excluded. Require an operator to confirm that the original writer has stopped and that the output root is under exclusive administrative control. Hostname, PID, timestamps, and a matching reservation are supporting evidence. They cannot establish this precondition, especially on a shared volume.

Run `notion-exporter recover-stage --out <affected-root> --writer-stopped` only after confirming that precondition. The command takes a separate, exclusive recovery lock in the same root and then reread the original record. It accepts only a complete fresh attempt record with the expected stage and destination names. It checks that the destination is still the recorded empty directory and verify the entire stage again. Publication uses the same rename into that empty directory as a fresh export. A successful recovery verifies the published snapshot before releasing the original writer lock, and leaves retention for a separate invocation.

If recovery stops after the rename, the next inspection should distinguish a missing stage and a verified destination from an empty reservation. An interrupted recovery lock requires the same operator investigation as an interrupted writer lock. A rejected recovery preserves the writer lock. If the stage was renamed but the destination failed verification, the destination and writer lock are retained for investigation.

### Legacy partial exports

The legacy resume path accepts a timestamp directory without a manifest. It reuses raw records based on their filenames. The raw records can contain local asset references, but the asset collector only knows about assets obtained during the current run. A legacy stage therefore cannot prove the provenance and integrity of reused media from the filename or the bytes alone. The exporter now refuses a partial with local media references before writing into it. Use a fresh export into a separate root when the partial contains media or its completeness is uncertain.

A replacement resume path should build a fresh stage and reuse an entry only when its raw record, rendered outputs, and every referenced asset have a validated checkpoint. Refetch entries without such a checkpoint. Cover media in page blocks and database rows, missing bytes, malformed raw records, renamed pages, and a crash after only part of an entry was written.
