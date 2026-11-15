# YT-DLP API — Release Review

- **Decision:** NO-GO
- **Phase 7 base:** `codex/phase6-linux-ci` at `e2d29b6884b983c0f207dd08e342405aa316e9c0`
- **Phase 8 state:** local, uncommitted patch based on that commit
- **Review date:** 2026-11-15 (Phase 8 addendum)

This review was performed on the local Phase 6 clone only. No production/VPS access, deployment, restart, push, or commit was performed. No `.env`, cookies, production database, logs, API key, or download was read or changed.

## Decision summary

The commit under review has strong local and Linux CI evidence. The latest Ubuntu 24.04 / Node 22 run, [GitHub Actions 43655063515](https://github.com/smkypm4xiirpl/ytdlp-api/actions/runs/43655063515), is on this exact HEAD and reports 58/58 tests passing with no skips. The Windows suite also passed, with the expected symlink permission skip.

The Phase 7 **NO-GO** finding was the initial persistence ordering and 503 error mapping. Phase 8 now fixes those paths in this local patch and adds actual Fastify + manager + SQLite failure-injection tests. The patch has not been pushed and has not run on Linux. The current decision remains **NO-GO** until Ubuntu CI tests the Phase 8 source and the resulting patch receives a new review.

Additional limits: Node 20 is unsupported; Phase 8 sets the actual minimum to Node 22.15.0 because `DatabaseSync.isOpen` is used. Public HTTP does not protect API key confidentiality; process-group cancellation cannot contain intentionally detached children; fake yt-dlp and synthetic media do not prove production yt-dlp/YouTube behavior; disk-full cases are injected rather than physical.

## Verification results

| Category | Result |
|---|---|
| Windows full test suite | 54 total; 53 pass, 0 fail, 1 skip (`EPERM` creating symlink). |
| Ubuntu GitHub Actions | 58 pass, 0 fail, 0 skip on exact reviewed HEAD, run 43655063515. |
| Unit-style validation / media policy / timeout helpers | All passed (8 cases/groups: 4 validation, 1 media policy, 1 timeout policy, 2 shutdown deadline helper). |
| Fastify integration | 9 passed: auth, schema, endpoint behavior, rate limits, log redaction, ranges, disconnect, and leases. |
| Queue integration | 6 passed: actual P-Queue comparison and application queue concurrency, capacity, cancellation, rejection, idle behavior. |
| Process lifecycle | Windows fake process tree, managed-process, runner, and shutdown helper passed; Linux group, escalation, bootstrap shutdown cases passed in run 43655063515. A deliberately detached descendant is outside the process-group guarantee. |
| Media | Synthetic FFmpeg/FFprobe and policy tests passed; real-manager tests exercise MP4/MKV/MP3 with local fixtures and fake yt-dlp. No live YouTube or production yt-dlp test. |
| Filesystem / SQLite | SQLite, recovery, retention, TTL/leases, and injected storage-failure tests passed. Windows symlink test skipped, but ran in Linux CI. Physical ENOSPC not exercised. |
| Syntax / clean install / diff | All JavaScript syntax checks passed; `npm ci` passed; `git diff --check` passed after the documentation-only changes. |
| Dependency audit | `npm audit --omit=dev` on 2026-11-15: 0 vulnerabilities. |

Test-layer counts overlap by design and must not be summed. `AUDIT_REPORT.md` contains detailed evidence and the final acceptance matrix.

## Priority findings

### P1 — Initial SQLite save failure leaves a ghost job (Phase 7 finding; fixed locally in Phase 8)

In `src/services/download-manager.js`, `createDownload()` calls `jobs.set(id, job)` before `persistJob(job, { required: true })`. When `saveJob()` throws, the Map insertion remains, while `queue.add()` is never reached. The job can appear as permanently queued in list/detail responses despite having no queue task or durable row. The manager throws `JOB_PERSISTENCE_FAILED` with status 503, but Fastify's error handler converts it to generic `INTERNAL_ERROR`/500 because it forwards only 4xx statuses. Current tests cover store-level failure propagation and a completed-state write failure, but not this initial manager-level save path.

Phase 7 required closure was to persist before publication and prove the error path through Fastify + the actual manager. Phase 8 evidence is recorded in the addendum below.

### P2 — Runtime engine range was inaccurate (corrected locally in Phase 8)

Phase 7 found `engines.node >=20` inconsistent with the SQLite API use. Phase 8 sets the minimum to `>=22.15.0`, the earliest Node 22 minor containing the `DatabaseSync.isOpen` API used by this source. The known target Node `v22.23.3` is above that minimum.

## Security and environment notes

- API key authentication, Bearer handling, schema checks, URL restrictions, route limits, log redaction, output validation, and range/lease behavior have test evidence with dummy credentials.
- Public HTTP leaves API keys and responses observable/modifiable by network-path observers. The user accepts HTTP temporarily; the cryptographic exposure remains. Without changing the friend-owned Nginx, TLS, firewall, or other services, realistic mitigations are to avoid sending keys over untrusted paths, restrict clients to trusted networks where that is already available, and use an SSH tunnel for operator-only access if separately authorized. None is claimed as applied.
- Linux process groups stop owned processes that remain in the group. A child that deliberately calls `setsid()` or otherwise detaches can escape; do not claim it is guaranteed to stop.
- Tests use fake downloader executables, generated local media, temporary storage, and SQLite fixtures. They do not validate YouTube access, cookies, live format availability, or the exact production yt-dlp binary.
- ENOSPC, readonly, rename, and low-space failures use deterministic injection. Actual physical exhaustion and VPS filesystem behavior were not tested.
- Config review was limited to source, variable names, validators, defaults, and examples. No current `.env` values were inspected. Known Node `v22.23.3` and default API port 3100 are compatible with the reviewed major version and default port; actual VPS executable paths, host binding, mount, cookies, and environment values remain unverified. No VPS interaction occurred.

## Deployment and rollback readiness

**Readiness: written procedure only; not executed. Deployment is not authorized by this review.** Follow the existing tmux method for this API only, after the P1 fix passes review and the VPS owner explicitly approves a maintenance window. Do not change Nginx, ports 80/443, DNS, firewall, Docker, or the friend's services. Do not use root/sudo, `pkill`, broad `kill`, or commands that stop all Node processes.

### Pre-deployment checklist — future authorized operator only

1. Obtain the VPS owner's explicit approval and agree on a maintenance window and a rollback decision-maker.
2. Confirm the exact project path and tmux session/pane with the owner. Manually verify pane working directory, command, and process ownership identify this YT-DLP API. Do not infer the target from a session name alone. Do not inspect or capture logs in a way that could expose credentials. If the pane could be Next.js or another service, stop and ask the owner.
3. Verify the candidate branch/commit and all acceptance evidence. This NO-GO commit must not be deployed until the P1 defect above is fixed and reviewed.
4. Make a complete, timestamped source backup in a private location before replacing files. Preserve file ownership/permissions. Protect any configuration and cookies already present: do not print or copy secret contents to a terminal, repository, public artifact, or insecure backup location. Keep source backup distinct from database and user download storage.
5. Identify database, `-wal`, and `-shm` locations from the approved deployment configuration without displaying secret values. While the API is running, take a consistent SQLite online backup using the SQLite CLI `.backup` command, for example with operator-substituted private paths:

   ```sh
   sqlite3 "$DB_PATH" ".timeout 5000" ".backup '$BACKUP_DB_PATH'"
   ```

   Verify the backup opens and contains the expected schema using a read-only check. Do not copy an active SQLite database file as a raw filesystem backup. Do not manually remove `-wal` or `-shm`; SQLite owns their lifecycle. Store the backup with restricted permissions.
6. Check free space on both database and `STORAGE_PATH` volumes without touching downloads (for example, `df -h "$DB_PATH" "$STORAGE_PATH"`). Confirm the planned backup will not fill either volume. Do not clean or move user files to make space without owner approval.
7. Confirm `.env`, cookies, DB, logs, and download storage are outside the files being replaced or otherwise protected by a verified backup. Do not display their values.
8. If an instance lock exists, verify it manually: inspect its recorded PID, confirm the PID's command, owner, and working directory correspond to this API, and confirm it is no longer active before treating the lock as stale. PID reuse or ambiguous ownership means stop and involve the owner. Never remove a lock automatically or while an instance may own it.
9. Confirm the authorized runtime is Node 22 (known VPS version: `v22.23.3`), `npm` is available without elevation, and the configured yt-dlp, FFmpeg, and FFprobe executables are executable. Verify paths without printing secrets. Confirm port 3100 is for this API only and do not disturb the friend's listeners/services.

### Deployment steps — future authorized operator only

1. Only after approval, update files in the verified YT-DLP API project directory. Keep `.env`, cookies, database, logs, and download storage untouched.
2. Stop only the API process in the verified tmux pane, using the existing project procedure (normally Ctrl-C in that pane). Never use `pkill`, `killall`, `taskkill /IM`, or a broad Node process match. Do not stop Next.js or any other pane/service.
3. Install the locked production dependencies for this project only (`npm ci --omit=dev`) if that is part of the owner's established deployment practice. Do not run from the parent TWEBot directory and do not alter the lockfile on the VPS.
4. Start using the existing tmux session/pane method and the project's existing `npm start` command. Do not change Nginx, DNS, firewall, Docker, or service configuration.
5. Keep the prior source backup and SQLite online backup until acceptance is complete and the owner approves disposal. Do not run deployment as part of this report.

### Post-deployment smoke checklist — only after separate approval

1. Health: request `GET /api/v1/health` on the approved API address and verify the expected healthy response.
2. Authentication: request `/api/v1/info` and `/api/v1/formats` with an authorized key in a protected shell/session, never a URL or command history literal. Verify unauthenticated requests are denied and no key appears in logs/responses. Avoid shell tracing and verbose curl output that prints headers.
3. Download: only with owner approval, use a specifically approved low-impact single-video test. Verify one MP4, MKV, or MP3 output according to the selected acceptance check; use `ffprobe` to inspect container, codecs, and streams. Do not use production cookies outside the approved API configuration or download unrelated content.
4. Verify file endpoint `Content-Type`, `Content-Disposition`, full response, and a small `Range` response (expected 206); verify invalid range behavior (expected 416 per API contract).
5. Verify job detail/list consistency and persistence after an owner-approved orderly restart/recovery window. Do not perform another restart just to test unless it is explicitly within the approved window.
6. Review application logs for errors and secret leakage without copying secrets into the report. Confirm download storage and existing user files remain intact.

No smoke test was run during Phase 7.

### Rollback steps — future authorized operator only

1. If the release fails acceptance, identify the same verified API tmux pane and stop only this API process using the existing pane method. Do not stop all Node processes or touch other services.
2. Restore the complete pre-deployment source backup into the verified API project path, preserving protected config and permissions. Do not restore an old database automatically and do not replace current DB, WAL/SHM, cookies, logs, or downloads with backup copies.
3. Start the previous version in the same API tmux session/pane using the established command.
4. Check health and authenticated info, inspect sanitized logs, and verify existing jobs and files using the API. Confirm data created after deployment remains available. If DB schema incompatibility or corruption is suspected, stop and involve the VPS owner; do not overwrite the current database to force rollback.
5. Preserve both backups and the failed release for diagnosis until the owner confirms recovery.

Involve the VPS owner immediately if the target tmux pane or PID is ambiguous, the lock may be active, backups cannot be validated, free space is insufficient, the database reports corruption, another service shares the target port/session, source restore would overwrite user data, or rollback requires database restoration or infrastructure changes.

**All procedures above are documentation only and were not executed.** Any deployment decision requires a separate review after the P1 fix and explicit authorization from the VPS owner.

## Phase 7 files changed

- `AUDIT_REPORT.md` — corrected stale Phase 6 statements in context and appended this review's evidence, findings, acceptance matrix, and decision. Earlier phase history was retained.
- `RELEASE_REVIEW.md` — added this operator-facing decision summary and unexecuted deployment/rollback runbook.

# Phase 8 Addendum — Local Patch Review

The Phase 8 patch is based on the same Phase 7 HEAD above, but is currently uncommitted and unpushed. The code now performs a durable insert-only SQLite create, synchronously admits one `JobQueue` task, and then publishes the job into the Map before the queue's deferred worker callback can run. Queue-admission failure removes the Map entry and deletes the row; if deletion fails it persists `failed`, and if both compensations fail it safely logs the residual and startup recovery converts any remaining `queued` row to `interrupted`.

Verification on Windows Node `v22.15.1`:

- Full `npm test`: **62 total, 61 pass, 0 fail, 1 skip** (`EPERM` symlink fixture).
- Targeted real manager + Fastify integration rerun after final ordering/log assertions: **25 total, 24 pass, 0 fail, 1 skip**. Covers failing initial SQLite insert, successful held fake downloader, concurrent creates, queue admission failure, failed compensation, recovery, and generic error redaction.
- Earlier focused Fastify/SQLite/runtime tests: **19 pass, 0 fail, 0 skip**. The final full suite reran these tests after all source changes.
- Syntax checks: **39 JavaScript files pass**. `npm ci` succeeded and reported 0 vulnerabilities. `git diff --check` and manual whitespace checks pass.

Runtime minimum is now `>=22.15.0`: Node documents `DatabaseSync` in `node:sqlite` as added in 22.5.0, but this source uses `DatabaseSync.isOpen`, added in 22.15.0. The startup guard checks the version before loading config, SQLite, or opening storage. `package.json`, the root package-lock metadata, and local runtime tests match that floor. CI remains on Node 22 / Ubuntu 24.04.

**Linux CI for the Phase 8 patch: NOT TESTED.** The passing Phase 7 run 43655063515 tested the earlier commit and cannot establish Linux success for these new changes. No push was authorized or performed. Run the existing workflow against a commit containing this patch after separate authorization; until that run passes and is reviewed, decision remains **NO-GO**.

The known HTTP credential exposure, detached-child boundary, fake yt-dlp/media limitation, and injected (not physical) storage failure limitation remain. No deployment or restart was performed. `AUDIT_REPORT.md` records the Phase 8 acceptance matrix and files changed.
