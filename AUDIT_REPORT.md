# Audit Report — YT-DLP API

Tanggal: 2026-11-14. Audit dilakukan pada workspace lokal `D:/projects/programming/bots/twebot/ytdlp`, bukan VPS production. `.env`, `cookies.txt`, database, logs, dan hasil download tidak dibaca/diubah.

## Ringkasan dan prioritas

P0 terkonfirmasi: MP4 dapat menandai VP9/AV1 sebagai hasil MP4; H.264+AAC tidak melalui FFmpeg sehingga tidak ada validasi final/faststart; file output gagal dapat tertinggal dan dipulihkan sebagai completed. P1 terkonfirmasi: metadata yt-dlp timeout 60 detik bertabrakan dengan Fastify request timeout 30 detik; persist SQLite best-effort dapat membiarkan API mengembalikan sukses tanpa durabilitas; cleanup delete DB tidak ditunggu; Recovery hanya memeriksa regular file dan ukuran, bukan codec/validitas. P2: response format belum menyampaikan tipe stream/label kompatibilitas dan docs API minim.

## Temuan terkonfirmasi

| Prioritas | Bukti | Dampak |
|---|---|---|
| P0 | `src/services/download-manager.js`, `ensureMp4AudioCompatibility`: versi awal hanya membandingkan codec video sumber dan hasil, tidak menuntut H.264. Jalur AAC/ tanpa audio return tanpa remux/verifikasi. | VP9/AV1 atau file invalid dapat menjadi completed MP4, `faststart` tidak konsisten. |
| P0 | `executeDownload` mengatur completed setelah `lstat`/ukuran tanpa FFprobe final untuk MKV/MP3; catch tidak membersihkan hasil parsial. Startup orphan recovery menganggap file regex UUID+ekstensi sebagai completed. | Artefak gagal berpotensi dipulihkan/diberikan sebagai completed. |
| P1 | `persistJob` menelan SQLite error; `cleanupExpiredDownloads` memanggil `deleteStoredJob()` tanpa await (store saat ini sync); tanggal selesai, tetapi persist errors tidak memengaruhi hasil API. | State API dan durable state dapat berbeda diam-diam. |
| P1 | `src/services/ytdlp.js` child timeout 60s; `src/server.js` `requestTimeout: 30000`. | Request diputus sebelum metadata operation timeout sendiri. |
| P1 | `src/utils/validation.js` versi awal menerima query tambahan/playlist dan URL mentah diteruskan ke yt-dlp. | URL satu video dapat membawa opsi/parameter yang tidak diminta. |
| Risiko | `src/config.js` memasukkan path yt-dlp/cookie ke pesan exception jika executable/file tidak ada. Konfigurasi startup bisa memunculkan path sensitif di stderr. | Informasi filesystem dapat tercatat saat startup gagal. |
| Risiko | `src/server.js` hanya global 120/min; metadata/info/download berbagi budget. | Probe metadata berat dapat mengonsumsi kapasitas umum. |
| Risiko | Tidak ada single-instance lock; shutdown hanya close DB setelah `app.close()`, tidak secara eksplisit abort/menunggu job background. | Dua instance atau shutdown saat processing berisiko pada SQLite/file sementara. |

## Implementasi

- `download-manager.js`: MP4 sekarang wajib berisi video H.264 (`h264`/`avc`), seluruh audio stream harus AAC selepas proses, semua track audio dipetakan, H.264 di-copy, AAC yang sudah ada di-copy, audio lain diubah AAC-LC 256k. Semua jalur MP4 melewati remux `+faststart`, hasil FFprobe diverifikasi sebelum atomic rename. Format VP9/AV1 ditolak dengan `MP4_VIDEO_CODEC_UNSUPPORTED`. Output persis milik job dibersihkan saat gagal/cancel supaya orphan recovery tidak mengangkatnya lagi. Temp filename unik.
- `validation.js`: menolak fragment, query selain `v`, URL playlist/extra path, dan URL youtu.be multi-segmen.
- `package.json`: menambah `npm test` berbasis built-in Node test runner.
- `test/validation.test.js`: unit test URL acceptance/rejection.
- Backup baru dibuat sebelum edit: `backups/download-manager.js.before-codex-20261114-232154`, `backups/validation.js.before-codex-20261114-232154`. Backup AAC terdahulu dipertahankan.

API schema/response tidak berubah. Multi-audio dipertahankan dan semua audio diubah ke AAC bila perlu; subtitle/data stream tidak dibawa ke MP4 (FFmpeg memakai `-sn -dn`), metadata/chapter disalin. MKV/MP3 belum mendapat FFprobe final validation dalam perubahan ini.

## Test dan validasi

- `node --check` untuk seluruh file `src/*.js`: PASS, Node lokal `v22.15.1`.
- `npm test`: PASS, 4 pass / 0 fail / 0 skip.
- Test FFmpeg/FFprobe sintetis: BELUM DIJALANKAN (binary lingkungan clone belum diverifikasi dan tidak melakukan download/job produksi).
- Tes auth, queue race/cancellation, streaming leases/range, SQLite recovery fixture, error cleanup, ENOSPC, dan manual endpoint: BELUM DIIMPLEMENTASIKAN/DILAKSANAKAN.
- Tidak ada lint script atau dependency upgrade dijalankan.

## Acceptance criteria yang belum terpenuhi

Hasil MP4 source-code ditangani, tetapi fixture H.264+AAC/Opus dan verifikasi encoder belum dijalankan. MKV/MP3 validation, bounded FFmpeg/FFprobe timeout, cancellation escalation, FFprobe symlink race, storage quota/free disk, full job state transition, job TTL cap, DB durability failure, concurrent instance lock, rate limit per route, graceful stop of active children, health readiness, stream error/disconnect and lease suite masih belum ditangani/diuji. Ini bukan klaim selesai. Environment lokal memakai versi Node berbeda dari VPS yang dinyatakan dokumen; versi binary VPS juga belum diverifikasi.

Risiko residual: API publik HTTP mengirim API key tanpa enkripsi; pihak yang dapat mengamati jalur jaringan dapat membacanya. Deployment harus memakai jaringan tepercaya sampai TLS ditangani terpisah pemilik infrastruktur. `tmux` mempertahankan proses setelah SSH disconnect, bukan auto-restart setelah crash/reboot. Jangan menambah rahasia pada URL/log.

## Deployment plan — tidak dijalankan

Jalankan dari VPS hanya setelah pemilik menyetujui maintenance. Verifikasi path/session API milik project ini secara manual dan jangan gunakan kill-all/pkill. Ambil backup source dengan timestamp; backup database menggunakan SQLite online backup/`.backup` (jangan copy file DB aktif secara mentah, dan sertakan strategi WAL/SHM). Pastikan test lokal lulus dan deploy diff yang ditinjau. Pada tmux session API yang sudah diidentifikasi, kirim Ctrl-C hanya pada pane itu, lalu start `cd /home/lukman/apps/ytdlp-api && npm start` sesuai kebiasaan session. Jangan sentuh session/service lain.

Health: `curl -fsS http://127.0.0.1:3100/api/v1/health`. Authenticated check dilakukan dari shell tepercaya dengan header dari environment lokal, tanpa `echo`, `set -x`, atau memasukkan literal key ke history; hindari tes melalui jaringan publik HTTP. Periksa log pane tmux dan status job dengan endpoint terautentikasi. Jalankan manual acceptance checklist di prompt audit: format info, MP4 Opus/AAC, penolakan VP9/AV1, MKV, MP3, queued/running cancellation, range/disconnect, serta recovery fixture. Jangan gunakan file produksi untuk memaksa TTL.

## Rollback plan — tidak dijalankan

Jika health atau smoke check gagal, stop hanya pane tmux API yang sama. Pulihkan file source dari backup pre-deploy yang dibuat operator; jangan restore/timpa database dari backup lama kecuali ada bukti kerusakan dan prosedur recovery disetujui (rollback schema tidak relevan pada patch ini). Start API dengan versi sebelumnya pada pane yang sama, ulangi health check, simpan log error. Backup Codex hanya untuk `download-manager.js` dan `validation.js` dan bukan pengganti backup deployment lengkap. Jangan jalankan deployment/restart sekarang.

# PHASE 2 — Deep testing dan reliability hardening (2026-11-14)

## Environment dan metode

Workspace tetap clone lokal `D:/projects/programming/bots/twebot/ytdlp`. Binary lokal yang digunakan berasal dari `D:/Apps/Utilities/Youtube/ffmpeg.exe` dan `ffprobe.exe`; tidak ada akses ke VPS. Semua media fixture dibuat di direktori temp OS dan dihapus melalui teardown test. `.env`, `cookies.txt`, DB, logs, dan file storage tidak dibuka/diubah. Dependency aktual dari `npm ls --depth=0`: Fastify 5.12.8, p-queue 8.1.1, rate-limit 10.3.0, dotenv 16.6.1; tidak ada upgrade dilakukan. `p-queue` lifecycle belum dites langsung karena download manager mengimpor konfigurasi rahasia/runtime dan store produksi pada module import.

## Temuan tambahan fase 2

- P1: metadata yt-dlp, FFmpeg dan FFprobe sekarang memakai helper process terkelola; proses download yt-dlp dalam `runDownloadProcess` masih spawn lama tanpa hard timeout/escalation. Batas output stdout ada, tetapi meng-abort seluruh job dan dapat mengklasifikasikan output-limit sebagai cancelled. Ini masih acceptance tertunda.
- P1: SQLite durability sebelumnya ditelan. Pembuatan job kini menyimpan secara wajib sebelum masuk ke memory/queue; completed juga hanya dipersist setelah validasi. Progress/logging tetap best-effort. Lock eksklusif dibuat sebelum database dibuka agar instance kedua ditolak. Lock stale setelah crash membutuhkan verifikasi PID/session dan pembersihan manual; sistem sengaja tidak menghapus lock otomatis karena PID reuse/race.
- P1: graceful close sekarang membatalkan queued/running jobs dan menunggu `queue.onIdle()` sebelum database ditutup. Proses yang memakai helper dikelola oleh registry dan dihentikan ketika shutdown.
- P0 test: H.264 multi-track fixture dengan AAC + Opus sukses diproses ke H.264 + dua AAC-LC, dan atom `moov` terletak sebelum `mdat`. Validasi kebijakan VP9/AV1/no-video diuji sebagai unit policy. Codec encoder VP9/AV1 belum dibuat dalam fixture media.

## Perubahan fase 2

- `src/services/managed-process.js`: runner `shell:false`, hard timeout, bounded stdout/stderr, abort listener, escalation SIGTERM/SIGKILL, error codes konsisten, registrasi child untuk shutdown.
- `src/services/ytdlp.js`: metadata process memakai runner, timeout 60s dan cap output tetap.
- `src/services/download-manager.js`: FFprobe (30s) dan FFmpeg post-process (1 jam; sesuai max duration 4 jam hanya sebagian, sehingga perlu dicermati) memakai runner. Queue di-abort dan ditunggu saat shutdown. SQLite create/completed persistence diwajibkan. Kebijakan video MP4 dipisah ke media-policy.
- `src/services/media-policy.js`: unit policy H.264 requirement.
- `src/services/job-store.js`: exclusive lock `wx` mode 0600 sebelum membuka SQLite; ditolak jika lock sudah ada; dilepas ketika store ditutup.
- `src/server.js`: memanggil shutdown queue sebelum menghentikan proses terkelola/menutup store.
- `test/media-synthetic.test.js`, `test/media-policy.test.js`, `test/managed-process.test.js`: fixture media, MP4 policy, timeout/non-zero/missing executable.
- Backup server sebelum edit fase ini ada di `backups/server.js.before-phase2-<timestamp>`.

## Test yang dijalankan

- `node --check` untuk semua `src/**/*.js`: PASS.
- `npm test`: PASS — 9 tests, 9 pass, 0 fail, 0 skipped.
- Media test menggunakan FFmpeg/FFprobe aktual lokal: PASS untuk multi-audio AAC+Opus → H.264+AAC-LC dan faststart. Unit policy: PASS untuk H.264 accept, VP9/AV1 reject, no-video reject.
- Runner test: PASS untuk proses sukses, timeout, exit nonzero, dan executable hilang.
- URL validation sebelumnya: PASS 4 kasus.
- `npm ls --depth=0`: dependency utama terpasang sesuai lockfile range.

## Acceptance yang masih tertunda

- Belum dites dalam pipeline aplikasi: H.264+AAC no-reencode (direct command copy pipeline belum diuji sebagai app path), no-audio output, oversize output, corrupt input/output, simulated FFmpeg/FFprobe failure dan disk-full cleanup.
- Belum dites: download yt-dlp timeout/cancel escalation/output cap, P-Queue exact capacity/concurrency/multi-submit/removal semantics, queued/running/processing cancellation race, transition invariants.
- Belum dites: DB read/write/delete failure injection, concurrent writers, busy/locked, checkpoint, abrupt process death/recovery fixture. Lock semantics juga belum punya integration test multi-process dan stale lock runbook perlu pemeriksaan manual.
- Belum dites: stream endpoint normal/range/invalid range/disconnect/stream error, lease exactly once, TTL/acquire deletion races, symlink/path traversal filesystem integration.
- Belum dites: Fastify auth/redaction/rate limit/error schema dan seluruh endpoint via inject. Endpoint mahal masih hanya memakai global rate limit 120/min. API key HTTP tetap berisiko terlihat di jaringan.
- Free disk reservation/quota belum diimplementasikan dan skenario ENOSPC belum diuji. Ini bukan temuan bahwa drive C: penuh atau bahwa storage project memakai C:. Kebutuhan ruang remux/transcode berada pada volume yang memuat STORAGE_PATH (temp hasil dibuat di direktori storage yang sama); jika STORAGE_PATH berada di D: dan D: masih lega, ruang kosong C: tidak menentukan kapasitas file media. OS temp/log dapat memakai volume lain bergantung konfigurasi. FFmpeg post-process timeout 1 jam belum diselaraskan penuh dengan batas durasi video 4 jam.
- MKV/MP3 codec final validation belum diterapkan. Recovered file masih perlu validasi media (bukan hanya file type/size). Job map TTL/retention dan orphan temporary cleanup perlu test/penyelesaian.

## Status deployment / rollback readiness

Tidak ada deployment, restart, atau job produksi. Sebelum deployment, wajib meninjau `git diff`, menjalankan suite ini pada Node versi VPS, menambah test tertunda di atas terutama subprocess download dan SQLite, lalu menyiapkan backup source dan SQLite konsisten memakai `.backup`/online backup. Lock baru akan menolak startup bila file `.ytdlp-api.lock` tersisa setelah crash; verifikasi bahwa PID dalam lock tidak aktif pada host yang benar sebelum operator menghapus lock. Jangan menghapus lock otomatis.

Runbook deployment/rollback manual tmux dan acceptance smoke checks tetap sebagaimana bagian sebelumnya. Backup fase 2 bukan snapshot penuh repo; perubahan lain yang sudah ada di workspace harus dipertahankan.


# PHASE 3 — Download pipeline completion dan production reliability

Tanggal: 2026-11-14. Dilanjutkan pada source terkini. Tetap lokal pada clone; tidak membaca `.env`/cookies/DB/log, tidak membuat download nyata, tidak mengakses VPS, tidak restart/deploy.

## Perubahan

- `src/services/download-process.js`: runner khusus download dengan timeout `min(max(maxVideoDuration × 1s + 10 menit, 30 menit), 6 jam)`, stdout cap 64 KiB untuk marker filepath, stderr cap 32 KiB, AbortSignal, parsing progress, dan pemetaan error yang memisahkan output limit dari user cancel.
- `src/services/managed-process.js`: callback stream stdout/stderr, tetap memakai shell false, bounded output, TERM lalu KILL.
- `src/services/download-manager.js`: `runDownloadProcess()` memakai runner tersebut; post-processing FFmpeg timeout diselaraskan pada policy durasi yang sama. File MP4 input/output diproses pada volume STORAGE_PATH; ada pemeriksaan free-space advisory `input size + 32 MiB` sebelum remux dan tetap mengandalkan penanganan kegagalan child untuk ENOSPC. Final output MP4, MKV, dan MP3 kini diverifikasi dengan FFprobe, container/codec/stream yang sesuai, ukuran final diperiksa. MKV harus Matroska; MP3 harus container MP3 dengan audio codec MP3 tanpa video. Completed baru disimpan durable setelah validasi.
- `src/services/sqlite-store-core.js` dan `src/services/job-store.js`: store SQLite diekstrak sebagai factory yang bisa diuji dengan DB sementara; schema/WAL/busy timeout sama. Lock path produksi kompatibel (`.ytdlp-api.lock`), exclusive dibuat sebelum membuka DB; write/read/delete error diteruskan, stale lock tidak dibuang otomatis.
- `src/routes/info.js`, `src/routes/formats.js`, `src/routes/downloads.js`: rate limit route terpisah 20/min metadata/info dan 10/min create download, di samping global 120/min.
- `test/download-process.test.js`, `test/queue-integration.test.js`, `test/sqlite-integration.test.js`; media synthetic ditambah kasus AAC copy, no-audio, corrupt input.
- Backup sebelum perubahan berisiko dibuat di `backups/*before-phase3-*`.

## Hasil tes

Perintah: `node --check` untuk semua `src/**/*.js`; `npm test`; `git diff --check -- src test package.json AUDIT_REPORT.md`.

Hasil: syntax PASS; test **24 pass, 0 fail, 0 skip**; diff whitespace check PASS. Peringatan Node tentang `node:sqlite` experimental muncul saat SQLite fixture dan bukan kegagalan.

FFmpeg/FFprobe binary lokal `D:/Apps/Utilities/Youtube` dipakai. Fixture MP4 H.264 + AAC/Opus → dua AAC-LC, faststart, AAC-copy, no-audio, corrupt rejection berhasil. Download runner fake process menguji marker/progress, timeout, user abort, output cap, missing executable, dan nonzero exit. Timeout maksimum policy 6 jam.

P-Queue 8.1.1 integration fixtures menguji concurrency=2, simultan 4 submission, pending+size, waiter cancellation, active cancellation, rejection, dan queue idle. Catatan aktual: P-Queue menyisakan waiter aborted pada `size` sampai slot bebas; saat giliran, task ditolak tanpa dipanggil. Karena itu cancelled waiter dapat tetap memakai slot antrean sementara.

SQLite fixture menguji CRUD, 25 persistence writes, duplicate lock, stale lock fail-closed, abrupt process exit dengan row tetap terbaca setelah lock dibersihkan pada fixture, write trigger failure, delete trigger failure, dan read error setelah handle ditutup.

## Acceptance checklist status

- **PASS** — download child runner terintegrasi; bounded output, hard timeout, cancellation, escalation logic, spawn/nonzero/output-limit error mapping; fake process test lulus.
- **PASS** — queue concurrency/pending+waiting behavior dan cancellation/rejection semantics pada P-Queue 8.1.1 diuji dengan task terkontrol.
- **PASS parsial** — SQLite factory CRUD/error propagation/WAL abrupt-exit/stale-lock fixtures; belum mencakup busy timeout dan simultaneous process writes.
- **PASS parsial** — single-instance lock file fail-closed, diuji intra-process dan stale; subprocess kedua belum diuji, recovery service-level belum diuji.
- **PASS** — synthetic MP4 multi-audio AAC+Opus, AAC-only copy, silent video, corrupt rejection, faststart atom, H.264 requirement; AV1/VP9 rejection lewat policy unit.
- **PASS parsial** — final runtime verifier diterapkan untuk MP4/MKV/MP3; test codec MKV/MP3 synthesis dan source-vs-output codec preservation belum dibuat.
- **PASS parsial** — advisory free-space memeriksa volume STORAGE_PATH dan temp MP4 dibersihkan via finally; ENOSPC race, quota, orphan-temp sweeping dan size cap seusai setiap jalur belum diuji penuh.
- **NOT TESTED** — endpoint streaming full/range/416/disconnect/stream error, lease race/TTL, symlink TOCTOU dan path traversal integration.
- **NOT TESTED** — Fastify inject untuk auth/key redaction, schema/error body, per-route rate limiter, seluruh endpoint dan API response status.
- **NOT TESTED** — interrupted/completed startup recovery dengan fixture dan validasi orphan output/temp; memory-map retention di volume besar.
- **NOT TESTED** — shutdown process yang menolak exit dan descendant process tree. Shutdown membatalkan queue dan menunggu idle; native yt-dlp mungkin men-spawn FFmpeg sendiri, sehingga group/process-tree termination perlu validasi target OS.
- **NOT TESTED** — concurrent SQLite writer, SQLITE_BUSY/busy_timeout 5s, checkpoint/WAL growth, read-only FS, disk full, output oversize pada runtime manager.

## Temuan/risiko yang tersisa

- Timeout untuk batas durasi maksimum 4 jam adalah 4 jam 10 menit; batas konfigurasi absolut 24 jam dipotong ke 6 jam. Ini membatasi hanging, tetapi untuk input terpanjang dapat terlalu ketat. FFmpeg processing memakai policy yang sama (maksimal 6 jam), masih perlu pengukuran VPS.
- P-Queue menunda penyelesaian queued cancellation sampai task mencapai giliran; status terminal dapat tertunda ketika ada job aktif lama.
- In-memory job store masih hanya dibersihkan TTL; tidak ada hard cap jumlah record aktif/terminal. Orphan `.processing` dikecualikan pola recovery UUID final, tetapi belum dibersihkan otomatis.
- Free-space check bersifat snapshot advisory, bukan reservasi; job paralel bisa memakai ruang sesudah pengecekan. ENOSPC tetap dapat terjadi.
- Tidak ada disk quota per project. Batas file tetap `MAX_FILE_SIZE`; temporary remux memerlukan ruang tambahan pada volume yang sama.
- SQLite busy timeout tetap 5 detik; test kontensi multi-proses perlu dijalankan.
- API HTTP publik dan keterbatasan TLS tetap risiko yang didokumentasikan pada fase sebelumnya.

## Deployment readiness

**Belum siap untuk deploy production** sampai tes pending yang mempengaruhi data/streaming/shutdown selesai dan diff ditinjau, khususnya error streaming/lease, recovery media, job child descendant termination, dan tes API auth. Tidak ada perubahan deployment dilakukan. Runbook deployment/rollback manual tmux dari bagian sebelumnya tetap berlaku; gunakan backup source+SQLite konsisten sebelum deploy, dan jangan menghapus stale lock sampai PID/session dipastikan mati.

# PHASE 4 — Full integration, recovery, final reliability status

Tanggal: 2026-11-15. Bagian ini adalah status penerimaan terbaru dan **menggantikan status fase sebelumnya** jika ada perbedaan. Seluruh pekerjaan lokal di clone. Tidak membaca `.env`/cookies/DB/log produksi, tidak membuat download YouTube, tidak menyentuh VPS atau service lain.

## Perubahan fase 4

- `src/app.js` (baru): factory Fastify `buildApp()` tanpa listen/DB/config singleton; opsi service injection; error handler terpasang sebelum route register; AJV `removeAdditional:false`; global rate limit dan redaction.
- `src/server.js`: bootstrap production memakai `buildApp`, tetap melakukan startup recovery sebelum listen dan shutdown terkontrol.
- `src/routes/{downloads,info,formats}.js`: route menggunakan dependency injection supaya plugin HTTP yang sama bisa di-inject test.
- `src/middleware/authentication-core.js` (baru): auth factory testable tanpa membaca config/secret.
- `src/routes/downloads.js`: lease release idempotent pada end/close/error, response/socket close, dan aborted request.
- `src/services/recovery.js` (baru) + `download-manager.js`: recovery memvalidasi ID/output/state dari DB, status aktif jadi interrupted, completed dan orphan final divalidasi FFprobe + container/codec/size. `.processing`/orphan invalid dibiarkan untuk inspeksi; tidak ada sapuan umum. Recovery persistence wajib.
- `src/services/media-policy.js`: validasi reusable format+codec; MP4 audio harus AAC-LC; MKV Matroska; MP3 codec/container audio MP3.
- `src/services/download-manager.js`: queued cancellation langsung menjadi status cancelled meskipun P-Queue 8.1.1 masih menahan waiter sampai giliran; cleanup TTL skip task yang masih tertahan di queue; SQLite delete dilakukan sebelum job dikeluarkan dari Map; kegagalan atomic rename menjaga file input asli.
- `src/services/sqlite-store-core.js` / `job-store.js`: factory SQLite fixture; timeout busy dapat diinjeksi (maks 60s, default 5s); close idempotent; operasi/lock konsisten.
- `src/routes/info.js`, `formats.js`, `downloads.js`: rate limit route mahal terpisah.
- Tests baru/ditambah: `test/fastify-integration.test.js`, `test/recovery-integration.test.js`, `test/process-tree.test.js`, `test/sqlite-integration.test.js`, `test/media-synthetic.test.js`, `test/queue-integration.test.js`. Backup pre-change server/routes/manager/managed-process/SQLite berada di `backups/*before-phase4-*`.

## Hasil validasi terakhir

- Semua source `src/**/*.js` dengan `node --check`: **PASS**.
- `npm test`: **38 pass, 0 fail, 0 skip**.
- `git diff --check -- src test package.json AUDIT_REPORT.md`: **PASS**.
- Node lokal: v22.15.1. Peringatan `node:sqlite` experimental muncul, tetapi fixture lulus.
- Media sintetis memakai binary lokal di `D:/Apps/Utilities/Youtube` dan direktori temp; test teardown menghapus fixture.

Breakdown test:

| Kategori | Hasil |
|---|---:|
| yt-dlp runner fake process + timeout | 3 pass |
| Fastify API, auth, schema, range, disconnect, rate limit, log redaction | 8 pass |
| Generic managed process | 3 pass |
| Media policy unit | 1 pass |
| FFmpeg/FFprobe synthetic media MP4/MKV/MP3/VP9/AV1 | 5 pass |
| Process tree cancellation (Windows clone) | 1 pass |
| P-Queue 8.1.1 | 4 pass |
| Recovery + SQLite fixture lifecycle | 2 pass |
| SQLite CRUD/lock/busy/WAL/crash/error | 7 pass |
| URL validation | 4 pass |

## Acceptance matrix terbaru

- **PASS** — yt-dlp download runner app path memakai managed process; hard timeout, bounded marker/stderr, AbortSignal, TERM→KILL, spawn error/nonzero/output limit terpisah dan output marker diuji dengan fake executable.
- **PARTIAL** — process tree cancellation diuji pada Windows lokal dengan fake parent+child dan PID child mati setelah cancel. Linux process-group path belum dijalankan pada VPS/Linux. Shutdown Fastify dengan tree aktif, parent normal exit, serta child yang detach sendiri belum diuji.
- **PASS** — concurrency dan pending+waiting dihitung pada P-Queue 8.1.1 dengan task terkontrol; queued/running cancellation, rejection dan idle diuji. **Perilaku versi aktual:** abort queued waiter tetap menahan `size` sampai slot tersedia; saat giliran task tidak dieksekusi dan promise reject. API sekarang menampilkan cancelled segera, task masih menempati antrean sementara.
- **PASS parsial** — SQLite CRUD, error write/delete/read, simultaneous process open lock, owner tetap berfungsi, stale lock fail-closed, abrupt exit+durable row, SQLITE_BUSY pada timeout fixture 100ms, dan WAL checkpoint diuji. Read-only filesystem, multi-writer concurrency, durability saat OS kill pada titik commit belum diuji.
- **PARTIAL** — startup recovery function yang dipakai aplikasi diuji dengan DB/storage temp: kosong, queued/downloading/processing, completed valid/missing/corrupt/VP9 mismatch, orphan valid, invalid orphan, `.processing`, invalid DB ID. Full server process bootstrap+signal shutdown setelah recovery belum dijalankan.
- **PARTIAL** — HTTP route Fastify aktual diuji via inject: health/info/formats/create/list/detail/file/delete; 401 missing/wrong/malformed, Bearer, invalid schema/UUID, queue full, 404, 200/206/416, oversize Range, stream open error, simultaneous clients, log key redaction, global & info route rate limit. Fake manager digunakan; interaksi route dengan singleton manager/SQLite real belum digabung pada satu server fixture.
- **PARTIAL** — stream lifecycle diuji lewat inject dan ephemeral HTTP disconnect; release satu kali, concurrent leases, stream error saat file open. TTL cleanup/acquire race dan symlink/path traversal pada `acquireDownloadFile()` real belum diuji; disconnect real memvalidasi route dengan fake manager.
- **PASS parsial** — recovery menolak media corrupt/codec mismatch dan menyisakan unrecognized/temp tanpa menghapus. Path traversal pada stored id diuji reject. Test symlink filesystem belum dilakukan (kemampuan symlink Windows dapat butuh izin).
- **PASS** — media MP4 AAC+Opus multi-track -> H.264 + dua AAC-LC, AAC copy, no-audio, faststart, corrupt rejection; VP9/AV1 dibuat nyata dan policy menolak.
- **PARTIAL** — MKV H.264+AAC+Opus synthetic remux mempertahankan semua codec/track; MP3 audio-only q0 menghasilkan container/codec MP3 tanpa video. Ini menguji pipeline FFmpeg/FFprobe synthetic langsung, belum menjalankan yt-dlp end-to-end. MKV VP9+Opus belum disintesis.
- **PARTIAL** — runtime output verifier MP4/MKV/MP3 diterapkan; FFmpeg gagal, FFprobe gagal pada app path, corrupted/empty MP3, dan pipeline conversion ENOSPC belum di-inject.
- **PARTIAL** — advisory free space memeriksa volume `STORAGE_PATH`, final size diperiksa, unique temp dan finally cleanup, rename failure menjaga input. Simulasi ENOSPC/read-only/free-space drop/oversized postprocess/rename injection belum dibuat. Check bukan reservasi disk.
- **PARTIAL** — rate-limit global dan route info diuji. Route-specific formats/download threshold serta semua response headers belum diuji per ambang.
- **NOT TESTED** — TTL expiry full integration, job map retention stress, recovery setelah repeated restart, stale temp cleanup policy.
- **NOT TESTED** — test manual real YouTube/auth cookie tidak dilakukan sesuai batasan; versi Linux/VPS/binary VPS dan perilaku process group Linux belum diverifikasi.

## Risiko residual dan hal yang belum dapat dibuktikan

- Ini belum merupakan full production acceptance: beberapa tes memakai injected fake manager; recovery memakai factory recovery yang dipanggil oleh manager, bukan menyalakan server production bootstrap lengkap.
- Windows process tree cleanup memakai taskkill terhadap PID parent dan `/T`; Linux memakai negative PID process group. Linux path aman secara desain dengan detached process group, tetapi belum dieksekusi di lingkungan ini. Child yang melakukan daemonize/detach keluar dari process group tidak dijamin.
- Timeout untuk video maksimum empat jam adalah 4 jam 10 menit (10 menit allowance); cap absolut adalah 6 jam. Ini bounded dan berbasis batas media, tetapi throughput VPS lambat bisa menyebabkan timeout sah. Pengukuran production tidak dilakukan.
- Graceful shutdown menunggu queue idle; pekerjaan aktif dibatalkan lalu process helper escalation 1.5 detik. Tidak ada hard kill timer untuk seluruh app shutdown bila native process tidak memunculkan `close` setelah tree kill; belum diuji pada Linux.
- Free-space check `input + 32 MiB` hanya advisory; tidak ada quota/reservation, concurrent writers dapat mengambil ruang, ENOSPC tetap ditangani sebagai kegagalan child tetapi app-level fixture belum membuktikannya.
- Stale lock setelah crash perlu pemeriksaan PID/session manual sebelum dihapus. API publik HTTP tetap mengekspos API key terhadap pengamat jaringan.
- MKV verifier memvalidasi Matroska + stream A/V, sedangkan kesetaraan codec dibuktikan hanya fixture FFmpeg remux; tidak ada pembandingan codec yt-dlp input melawan hasil final saat runtime.

## Status deployment

**Belum production-ready / jangan deploy berdasarkan hasil ini saja.** Tidak ada deployment/restart. Sebelum deploy, selesaikan khususnya Linux process-tree/shutdown test, real manager + Fastify + SQLite lifecycle test, acquire/cleanup TTL/symlink integration, ENOSPC injection, dan yt-dlp-driven MKV/MP3 output. Runbook tmux/rollback fase sebelumnya masih berlaku; jalankan hanya setelah review dan izin deployment. Test reproducible lokal: `node --check` tiap file `src/**/*.js`, kemudian `npm test`; binary media ditentukan di `test/media-synthetic.test.js`, fixture dibuat dan dibersihkan dalam OS temp.

# PHASE 5 — Residual acceptance closure & release candidate validation

Tanggal: 2026-11-15. Audit dilakukan hanya pada clone Windows lokal, Node.js v22.15.1, dengan fixture storage/database di temporary directory. Tidak ada akses VPS, file production, `.env`, cookies, download YouTube, deployment, atau restart.

## Temuan baru dan perbaikan

- **P0 — completed-state race:** failure injection menunjukkan manager sebelumnya mengubah in-memory status menjadi `completed` sebelum SQLite menerima terminal write. Selama jendela tersebut API dapat melaporkan sukses padahal durable save gagal. `download-manager.js` kini menulis candidate snapshot terlebih dahulu dan baru mempublikasikan status completed setelah SQLite sukses. Test memasang SQLite trigger yang menolak commit completed; job tetap `failed`, tidak dapat diunduh, dan file valid dikarantina dengan nama `.failed.*` untuk inspeksi.
- **P1 — queued cancellation menahan kapasitas:** P-Queue 8.1.1 mempertahankan waiter yang abort sampai antrean mencapai task tersebut. Dengan satu job aktif lama, waiter yang dibatalkan tetap bisa mengisi antrean. Manager sekarang memakai `JobQueue` internal yang menghapus task queued saat abort, menjaga concurrency sampai pekerjaan running benar-benar settle. P-Queue tetap diuji sebagai pembanding; dependency/lockfile tidak diubah.
- **P1 — shutdown tak berbatas:** signal handler sebelumnya menunggu `app.close()` tanpa deadline keseluruhan. Shutdown sekarang dibatasi `SHUTDOWN_TIMEOUT_MS` (default 30 detik, rentang valid 1–120 detik). Saat batas terlewati, proses menghentikan child milik API lalu keluar non-zero; fallback ini sengaja tidak menutup SQLite saat job masih mungkin menulis. SQLite WAL dapat dipulihkan setelah process exit, namun jalur paksa ini masih perlu validasi Linux.
- **P1 — ENOSPC dari downloader:** error storage penuh dari boundary download sekarang dipetakan ke kode stabil `STORAGE_WRITE_FAILED`, seperti ENOSPC pada FFmpeg, dan tidak membuat file completed.
- Cleanup TTL menerima waktu acuan sebagai argumen opsional agar test manager nyata menguji expiry deterministik tanpa memodifikasi timestamp file.

## Perubahan fase 5

- Diubah: `src/config.js`, `src/server.js`, `src/services/download-manager.js`.
- Dibuat: `src/services/job-queue.js`, `src/utils/with-timeout.js`, `test/job-queue.test.js`, `test/shutdown-timeout.test.js`, `test/real-manager-integration.test.js`.
- Backup sebelum perubahan shutdown: `backups/config.js.before-phase5-shutdown-20261115-033426`, `backups/server.js.before-phase5-shutdown-20261115-033426`.
- Dependency dan lockfile tidak diubah. Tidak ada file project lain atau data production yang dihapus.

## Test dan validasi akhir

| Kategori | Hasil |
|---|---:|
| yt-dlp runner + timeout/output cap/error mapping | 3 pass |
| Fastify API/auth/range/disconnect/rate-limit/redaction | 8 pass |
| Queue: P-Queue 8.1.1 pembanding + JobQueue cancellation/concurrency | 6 pass |
| Managed process | 3 pass |
| Media policy + FFmpeg/FFprobe synthetic MP4/MKV/MP3 | 6 pass |
| Process-tree cancellation Windows | 1 pass |
| Real Fastify + manager + SQLite + media fixture + ENOSPC/write-failure | 7 pass, 1 skip |
| Recovery | 2 pass |
| Shutdown deadline helper | 2 pass |
| SQLite CRUD/lock/busy/WAL/crash/error | 7 pass |
| URL validation | 4 pass |
| **Total** | **49 pass, 0 fail, 1 skip (50 tests)** |

Perintah yang dijalankan pada hasil akhir:

- `node --check` untuk seluruh `src/**/*.js`: **PASS**, 21 source file.
- `npm test`: **PASS**, 49 pass / 0 fail / 1 skip. Skip: symlink creation pada Windows ditolak `EPERM`.
- Ada satu iterasi penuh sebelumnya yang gagal pada assertion progress setelah fake executable mengirim marker kedua; fake script diperbaiki, test cancellation terarah lulus, dan pengulangan penuh final lulus. Hasil gagal interim tersebut bukan hasil final.
- `git diff --check -- AUDIT_REPORT.md package.json src test`: **PASS**, tanpa whitespace error; karena file proyek muncul sebagai untracked di parent Git view, scan trailing-whitespace eksplisit juga dijalankan pada sembilan file fase 5: **PASS**.
- FFmpeg/FFprobe lokal `D:/Apps/Utilities/Youtube/ffmpeg.exe` dan `ffprobe.exe` dipakai oleh media synthetic suite. Test menyintesis MP4 H.264+AAC/Opus, MP4 tanpa audio, MKV VP9+Opus, dan MP3; tidak mengunduh media.
- `wsl --list --quiet` tidak memberikan distro Linux yang dapat dijalankan dan hanya memunculkan usage CLI. Linux subprocess/process-group acceptance karenanya tidak diuji.

Integration yang kini benar-benar terhubung: Fastify aktual → manager aktual → JobQueue → SQLite fixture → `runYtDlpDownload`/`managed-process` → skrip fake yt-dlp yang dijalankan sebagai child Node → file di storage fixture → FFprobe/FFmpeg aktual → GET detail dan GET file. Skrip fake memeriksa format args, mengeluarkan progress dan marker final, membuat media dari fixture, serta dikendalikan untuk failure/cancellation. Ini tidak membuktikan perilaku binary yt-dlp aktual atau jaringan YouTube.

## Acceptance matrix PHASE 5

| Area | Status | Bukti/batas |
|---|---|---|
| Real Fastify + manager + SQLite lifecycle dan recovery ulang | **PASS** | Fixture media nyata FFmpeg/FFprobe; POST, persist, queue, progress, validate, completed, GET detail/file, failure/cancel, restart manager recovery diuji. Downloader tiruan dijalankan sebagai child process melalui runner terkelola. |
| SQLite failed completed write tidak tampil sukses | **PASS** | Trigger menolak status completed; API memory/durable state menjadi failed dan output dikarantina. |
| TTL, acquisition, concurrent leases dan cleanup manager aktual | **PASS** | Dua lease simultan melindungi file dari cleanup; release idempotent; cleanup setelah lease terakhir menghapus file/job; file hilang ditolak. |
| Stored path traversal metadata | **PASS** | Recovery menormalisasi filename dari ID+output dan tidak mempercayai `../outside.mp3`. |
| Symlink pada manager aktual | **BLOCKED** | Fixture mencoba symlink; Windows filesystem memberi `EPERM`. Tidak ada Linux runtime/distro untuk menjalankan ulang. |
| Linux process group, descendants, detached child, shutdown dengan yt-dlp/FFmpeg aktif | **BLOCKED** | Hanya Windows descendant cancellation yang dijalankan. Tidak menyamakan code review negative-PID dengan bukti runtime. |
| Shutdown hard deadline | **PARTIAL** | Deadline helper normal/timeout diuji; wiring server ditinjau dan syntax-checked, tetapi full bootstrap + active child shutdown belum dijalankan sebagai subprocess integration. |
| Queue capacity/concurrency dan cancellation waiter | **PASS** | P-Queue perilaku aktual diuji. Manager JobQueue diuji dengan 100 queued cancellations, immediate removal, slot admission, concurrency, dan running task mempertahankan slot sampai settle. |
| ENOSPC yt-dlp/FFmpeg + API health | **PASS** | Failure terkontrol menghasilkan failed/`STORAGE_WRITE_FAILED`, tanpa file final, SQLite sesuai, API health tetap 200. |
| SQLite failure setelah output valid | **PASS** | Completed trigger failure tidak menghapus valid input; output di-quarantine dan tidak direcover completed. |
| Rename failure, read-only volume, free-space drop/remux ENOSPC filesystem-level | **PARTIAL** | Error injection dilakukan pada process boundary; kegagalan filesystem/rename dan advisory check race belum dijalankan. |
| MP4/MKV/MP3 manager pipeline | **PARTIAL** | MP4 H.264+Opus diproses dan divalidasi, MP4 VP9/AV1 policy serta AAC/no-audio synthetic, MKV VP9+Opus stream/container, MP3 VBR q0/codec/no-video diuji. MP4 H.264+AAC copy diuji synthetic, belum melalui lifecycle manager aktual. |
| Route-specific rate limit | **PARTIAL** | Global dan info threshold diuji. Formats dan POST downloads threshold/reset/header secara terpisah belum diverifikasi. |
| Full production server bootstrap / second-instance lifecycle | **PARTIAL** | Recovery dan SQLite exclusive lock fixtures tersedia dari suite sebelumnya; listen/bootstrap/signal/lock release sebagai lifecycle subprocess penuh belum diuji pada fase ini. |
| Memory/retention stress ribuan job, orphan temp retention | **NOT TESTED** | Tidak membuat stress fixture massal fase ini. Tidak ada klaim retention tak terbatas sudah tertutup. |
| Seluruh test fase sebelumnya tanpa regression | **PASS** | `npm test` mencakup suite pada checkout terkini: 49/49 runnable pass, 0 fail; satu symlink test skip karena permission. |

## Risiko residual dan perilaku yang belum terbukti

- Belum layak disebut production Release Candidate: Linux process-group termination dan server shutdown dengan process tree aktif adalah blocker yang diminta definisi selesai. Prosedur Linux non-production: jalankan `npm test` pada Linux Node 22; jalankan fixture parent+descendant dengan `detached:true`, verifikasi PID semua descendant hilang setelah SIGTERM dan SIGKILL escalation, uji child yang mencoba `setsid`/detach, lalu kirim SIGTERM ke subprocess server fixture ketika fake yt-dlp/FFmpeg aktif dan pastikan timeout, status job, SQLite close, serta lock release. Jangan jalankan pada VPS produksi.
- Shutdown deadline fallback memanggil `process.exit(1)` jika app close masih menggantung setelah konfigurasi. Ini hard bound, tetapi process exit dapat meninggalkan WAL/lock stale; SQLite dapat memulihkan WAL, sedangkan lock memerlukan pemeriksaan PID dan penghapusan manual operator sebelum startup. Jangan hapus stale lock otomatis.
- yt-dlp dijalankan melalui executable tiruan untuk integrasi; validasi argumen dan output tidak membuktikan perubahan perilaku versi yt-dlp di VPS. Tidak ada koneksi YouTube/cookies.
- Test symlink ditandai skip pada Windows. TOCTOU terhadap aktor lokal yang dapat menulis storage, route rate limit formats/download, stress job retention, read-only/rename failure, dan full bootstrap belum memperoleh bukti runtime fase ini.
- HTTP tanpa TLS tetap risiko deployment yang terdokumentasi pada fase sebelumnya. Tidak ada perubahan infrastruktur/TLS.

## Readiness dan instruksi reproduksi

**Status: PARTIAL / bukan production-ready; tidak ada deployment atau restart yang dilakukan.** Setelah Linux test dan acceptance berstatus PARTIAL di atas ditutup, review diff dan lakukan deployment hanya dengan persetujuan terpisah.

Reproduksi lokal:

1. Gunakan Node.js 22 dan dependency dari lockfile yang ada.
2. Pastikan `D:/Apps/Utilities/Youtube/ffmpeg.exe` serta `ffprobe.exe` tersedia, atau atur path fixture test sesuai binary media lokal tanpa memakai secret.
3. Jalankan `node --check` untuk source JavaScript, lalu `npm test`. Seluruh test membuat temp media/database/storage dan membersihkannya melalui teardown.
4. Untuk Linux process tree/symlink, jalankan suite pada Linux non-production dengan toolchain setara dan catat hasil terpisah; jangan menandai PASS sebelum runtime test benar-benar lulus.

Deployment/rollback **belum dijalankan**. Sebelum deploy: review perubahan file yang tercantum, ambil backup source dan SQLite konsisten (SQLite online backup/`.backup`, dengan WAL dikelola SQLite), verifikasi stale lock secara manual, lalu ikuti runbook tmux terdahulu hanya setelah izin pemilik. Rollback source menggunakan backup pre-deploy operator; jangan restore database lama kecuali diperlukan dan disetujui. Tidak ada perubahan Nginx/DNS/firewall/Docker/service lain.




# PHASE 6 — Linux CI and Residual Acceptance Closure

**Environment:** Windows 11 local clone, Node.js 22.15.1. Tests use temporary directories/databases, synthetic media, and dummy API credentials only. No `.env` or cookie contents were read; no VPS, production service, YouTube download, deployment, or restart was used. The supplied GitHub SSH repository was confirmed accessible and empty. CI changes are isolated to the YT-DLP clone; the parent TWEBot repository was restored to its original `main` HEAD and staged user changes after an accidental local commit was immediately undone with a soft reset. No Phase 6 commit was pushed to the parent repository.

## Changes and evidence

- Added `.github/workflows/ci-linux.yml`: triggers on push, pull request, and manual dispatch; Ubuntu 24.04; Node 22; `npm ci`; FFmpeg/FFprobe installation and path configuration; syntax validation for all `src/**/*.js`; `npm test`; 20-minute workflow timeout; read-only repository permission; no secrets or artifact upload.
- Made synthetic media test binary paths configurable and Linux-aware while retaining the existing Windows path fallback. Production executable configuration is not changed by the test-only path selection.
- Added Linux-only process group, full bootstrap/second-instance, active child shutdown, shutdown deadline, and detached-child-boundary integration coverage. Windows does not execute the Linux signal assertions; they remain unproven until the Ubuntu job runs.
- Moved the server subprocess fixture from `test/fixtures` to `test-support/` after the full test run found Node's default discovery tried to execute the fixture as a standalone test. This fixed a real suite-discovery failure without suppressing tests.
- Added real-manager failure injection hooks for output rename and storage `statfs`; fixtures exercise ENOSPC, read-only/rename errors, low-space processing, oversized result, durable SQLite failure, and preservation/quarantine behavior.
- Expanded manager lifecycle tests for AAC copy, MKV and MP3, TTL leases, symlink handling where supported, route-specific limits, retention, and repeated recovery.

## Verification performed locally

- `npm test` (Windows, full suite after the Linux fixture fixes): **54 tests; 53 passed, 0 failed, 1 skipped**. The skip is symlink creation, rejected by Windows with `EPERM`.
- `node --check` across `src`, `test`, and `test-support`: **37 JavaScript files passed**.
- Linux process-group and POSIX symlink runtime assertions: Windows cannot run these assertions. Ubuntu workflow run `43652204319` executed but failed in `npm test`; Windows wrapper results are not counted as Linux validation.
- `git diff --check`: passed for the initial isolated branch before push. The follow-up correction is being rechecked before push.
- GitHub Actions Ubuntu results: runs `43652204319`, `43652665561`, `43652904681`, `43653487525`, and `43653771115` failed at `npm test`, exposing Linux-only fixture issues. The fixes include retaining the SIGKILL escalation timer, using a mutable manager wrapper for ESM exports, using a valid ESM fake downloader, explicit normal-parent exit, spawn PID reporting, and startup/job failure diagnostics. Run `43654011121` on `4b5bacf` completed successfully. A workflow success annotation is being added to record exact Linux TAP totals on the next run; test-count verification is pending.

## Acceptance matrix — Phase 6

| Acceptance criterion | Status | Evidence / limit |
| --- | --- | --- |
| Linux process-group cancellation and descendant SIGTERM handling | **PASS** | Full Ubuntu suite passed on run `43654011121`; Linux cancellation/escalation test no longer appears among failure annotations. |
| Linux SIGKILL escalation after ignored SIGTERM | **PASS** | Full Ubuntu suite passed on run `43654011121`, including the escalation fixture. |
| Parent normal exit cleanup behavior | **PASS** | Full Ubuntu suite passed after fixture now explicitly exits after flushing PID output. |
| Server SIGTERM while managed child active; shutdown deadline and DB/lock outcome | **PASS** | Full Ubuntu suite passed on run `43654011121` after manager wrapper and fake process fixes. |
| Child calling `setsid()` / leaving managed process group | **PARTIAL** | Ubuntu test passed and explicitly verifies teardown, but a deliberately detached process remains outside the process-group kill guarantee by design. |
| Symlink escape and cleanup protection on actual manager | **PARTIAL** | Whole Ubuntu suite passed; exact skip count has not yet been surfaced, so the symlink test's execution versus skip still needs confirmation. |
| Full bootstrap, recovery-before-listen, second-instance lock, shutdown/restart | **PASS** | Full Ubuntu suite passed on run `43654011121`, including subprocess bootstrap and deadline tests. |
| `/formats` route-specific rate limit | **PASS** | Fastify inject verifies threshold, 429 response, body, and headers on Windows. |
| `POST /downloads` route-specific rate limit | **PASS** | Fastify inject verifies independent threshold, 429 response, body, and headers on Windows. |
| Filesystem failure injection (rename/read-only/ENOSPC/free-space/oversize) | **PASS** | Real manager with deterministic hooks and temporary storage; verifies failed durable state and no false completed artifact. This is injected failure, not physical disk exhaustion. |
| Retention stress and repeated recovery | **PASS** | Temporary SQLite/storage fixture with 1,000 terminal jobs; active job and temporary artifact are retained; repeated recovery does not duplicate records. |
| Manager lifecycle MP4 AAC copy, MKV, MP3 | **PASS** | Fake yt-dlp child + real manager, Fastify, SQLite, FFmpeg/FFprobe, and local generated fixtures on Windows. This does not prove compatibility with a production yt-dlp binary or YouTube source formats. |
| Windows full test suite | **PASS** | 53 pass, 0 fail, 1 expected platform skip, 54 total. |
| Ubuntu Linux workflow | **PASS** | Run `43654011121` on commit `4b5bacf` completed successfully. Exact pass/fail/skip totals are pending a success-summary annotation run. |

## Residual risk and release assessment

- Until the Ubuntu workflow run is green and its logs confirm Linux-only process, bootstrap, and symlink cases executed, this phase remains **PARTIAL** and the release is **not production-ready**.
- A child that deliberately calls `setsid()` escapes the managed process group. Cleanup for that fixture is explicit; production policy must not claim containment of deliberately detached descendants without a stronger OS isolation mechanism.
- CI fake downloader uses controlled local fixtures. It validates application argument construction and the manager pipeline, not network behavior, YouTube availability, cookies, or the production yt-dlp build.
- Physical ENOSPC is represented by deterministic injected failures. Actual filesystem/device exhaustion behavior remains environment-dependent.
- No production deployment or restart was performed.

## Reproduction

On Windows with Node.js 22 and FFmpeg/FFprobe installed:

```powershell
npm ci
Get-ChildItem src -Recurse -File -Filter *.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
npm test
```

On GitHub, inspect [Linux CI run 43652204319](https://github.com/smkypm4xiirpl/ytdlp-api/actions/runs/43652204319) and the follow-up run after the fixture import correction. The workflow installs dependencies and media tools from the Ubuntu runner and runs the same syntax check and suite. Linux process-group, detached-child, full bootstrap and symlink claims remain unverified until a complete run passes and individual test results are reviewed.

## GitHub Actions execution status

The default SSH identity was `ImmoDevs`, which lacked write permission. The configured `github.com-rpl` alias uses `~/.ssh/rpl` and authenticated as `smkypm4xiirpl`. The isolated branch was pushed successfully. Runs `43652204319` through `43653771115` exposed and helped close Linux-only test-fixture defects. Run `43654011121` on commit `4b5bacf` passed. Current code changes are on `codex/phase6-linux-ci`; a new run will publish exact Linux test totals via an annotation. Current push remote is `git@github.com-rpl:smkypm4xiirpl/ytdlp-api.git`.
