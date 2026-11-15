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
- Added Linux-only process group, full bootstrap/second-instance, active child shutdown, shutdown deadline, and detached-child-boundary integration coverage. At the time this Phase 6 entry was first drafted, Windows could not execute these assertions; the subsequent successful Ubuntu runs below closed that platform gap for the tested commit.
- Moved the server subprocess fixture from `test/fixtures` to `test-support/` after the full test run found Node's default discovery tried to execute the fixture as a standalone test. This fixed a real suite-discovery failure without suppressing tests.
- Added real-manager failure injection hooks for output rename and storage `statfs`; fixtures exercise ENOSPC, read-only/rename errors, low-space processing, oversized result, durable SQLite failure, and preservation/quarantine behavior.
- Expanded manager lifecycle tests for AAC copy, MKV and MP3, TTL leases, symlink handling where supported, route-specific limits, retention, and repeated recovery.

## Verification performed locally

- `npm test` (Windows, full suite after the Linux fixture fixes): **54 tests; 53 passed, 0 failed, 1 skipped**. The skip is symlink creation, rejected by Windows with `EPERM`.
- `node --check` across `src`, `test`, and `test-support`: **37 JavaScript files passed**.
- Linux process-group and POSIX symlink runtime assertions: Windows cannot run these assertions. Ubuntu workflow run `43652204319` executed but failed in `npm test`; Windows wrapper results are not counted as Linux validation.
- `git diff --check`: passed for the initial isolated branch before push. The follow-up correction is being rechecked before push.
- GitHub Actions Ubuntu results: runs `43652204319`, `43652665561`, `43652904681`, `43653487525`, and `43653771115` failed at `npm test`, exposing Linux-only fixture issues. Fixes retained the SIGKILL escalation timer, wrapped ESM manager exports in a mutable object, used a valid ESM fake downloader, made the normal-exit fixture flush output before exiting, and added spawn/job diagnostics. Run `43654011121` passed; run `43654339413` passed with an explicit TAP annotation: **58 tests, 58 passed, 0 failed, 0 skipped**.

## Acceptance matrix — Phase 6

| Acceptance criterion | Status | Evidence / limit |
| --- | --- | --- |
| Linux process-group cancellation and descendant SIGTERM handling | **PASS** | Full Ubuntu suite passed on run `43654011121`; Linux cancellation/escalation test no longer appears among failure annotations. |
| Linux SIGKILL escalation after ignored SIGTERM | **PASS** | Full Ubuntu suite passed on run `43654011121`, including the escalation fixture. |
| Parent normal exit cleanup behavior | **PASS** | Full Ubuntu suite passed after fixture now explicitly exits after flushing PID output. |
| Server SIGTERM while managed child active; shutdown deadline and DB/lock outcome | **PASS** | Full Ubuntu suite passed on run `43654011121` after manager wrapper and fake process fixes. |
| Child calling `setsid()` / leaving managed process group | **PARTIAL** | Ubuntu test passed and explicitly verifies teardown, but a deliberately detached process remains outside the process-group kill guarantee by design. |
| Symlink escape and cleanup protection on actual manager | **PASS** | Ubuntu run `43654339413` passed with zero skipped tests; the actual manager symlink/cleanup test ran. Windows remains skipped with `EPERM`. |
| Full bootstrap, recovery-before-listen, second-instance lock, shutdown/restart | **PASS** | Full Ubuntu suite passed on run `43654011121`, including subprocess bootstrap and deadline tests. |
| `/formats` route-specific rate limit | **PASS** | Fastify inject verifies threshold, 429 response, body, and headers on Windows. |
| `POST /downloads` route-specific rate limit | **PASS** | Fastify inject verifies independent threshold, 429 response, body, and headers on Windows. |
| Filesystem failure injection (rename/read-only/ENOSPC/free-space/oversize) | **PASS** | Real manager with deterministic hooks and temporary storage; verifies failed durable state and no false completed artifact. This is injected failure, not physical disk exhaustion. |
| Retention stress and repeated recovery | **PASS** | Temporary SQLite/storage fixture with 1,000 terminal jobs; active job and temporary artifact are retained; repeated recovery does not duplicate records. |
| Manager lifecycle MP4 AAC copy, MKV, MP3 | **PASS** | Fake yt-dlp child + real manager, Fastify, SQLite, FFmpeg/FFprobe, and local generated fixtures on Windows. This does not prove compatibility with a production yt-dlp binary or YouTube source formats. |
| Windows full test suite | **PASS** | 53 pass, 0 fail, 1 expected platform skip, 54 total. |
| Ubuntu Linux workflow | **PASS** | Run `43654339413` on commit `7e86f47`: 58 pass, 0 fail, 0 skipped. Runner setup, Node 22, FFmpeg, `npm ci`, all-source syntax check, and full test suite passed. |

## Residual risk and release assessment

- This residual note reflected the state before the successful Ubuntu runs recorded below. Runs `43654339413` and `43655063515` later passed with zero skipped tests; the latter tested the current HEAD. Phase 7 below gives the current release decision and remaining blockers.
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

On GitHub, inspect [Linux CI run 43654339413](https://github.com/smkypm4xiirpl/ytdlp-api/actions/runs/43654339413). It passed the full Linux suite with zero skips; earlier failed runs remain documented as test-development findings. The current HEAD was subsequently tested in [Linux CI run 43655063515](https://github.com/smkypm4xiirpl/ytdlp-api/actions/runs/43655063515), also with 58/58 tests and no skips. Linux detached-child behavior remains a documented boundary of process-group cancellation.

## GitHub Actions execution status

The default SSH identity was `ImmoDevs`, which lacked write permission. The configured `github.com-rpl` alias uses `~/.ssh/rpl` and authenticated as `smkypm4xiirpl`. The isolated branch was pushed successfully. Runs `43652204319` through `43653771115` exposed and helped close Linux-only test-fixture defects. Ubuntu run `43654339413` on commit `7e86f47` passed: **58/58 tests, no skips**. Current push remote is `git@github.com-rpl:smkypm4xiirpl/ytdlp-api.git`.

# PHASE 7 — Final Release Review

Review date: 2026-11-15. This is a review-only phase on the isolated local clone. No source code, dependencies, secrets, production data, VPS, services, or remote repository state were changed. No deployment, restart, commit, or push was performed.

## Branch, commit, and CI evidence

- Branch: `codex/phase6-linux-ci`; HEAD: `e2d29b6884b983c0f207dd08e342405aa316e9c0` (`Record passing Linux CI and acceptance totals`). The working tree was clean before this documentation update.
- The older Phase 6 run `43654339413` passed on `7e86f47`, which is not HEAD. However, a later successful run, [43655063515](https://github.com/smkypm4xiirpl/ytdlp-api/actions/runs/43655063515), ran the workflow present at HEAD on branch `codex/phase6-linux-ci`, commit prefix `e2d29b6` (full SHA matches HEAD), Ubuntu 24.04 / Node 22. Its workflow annotation reports 58 tests, 58 pass, 0 fail, 0 skipped. Thus Linux CI is not stale for the source/workflow under review; no rerun is required solely due to later source changes. The run page currently displays a warning that `actions/checkout@v4` and `actions/setup-node@v4` use a Node 20 action runtime that the runner forces to Node 24; the project runtime setup remains Node 22. This warning is not a project test failure.
- The Phase 7 review changed documentation only. No source, workflow, dependency, or lockfile change followed the tested HEAD.

## Verification performed on the reviewed checkout

| Scope | Result | Evidence / limit |
|---|---|---|
| Windows full suite | **PASS with one platform skip** | `npm test`: 54 tests, 53 pass, 0 fail, 1 skip. Skip is the real-manager symlink fixture (`EPERM`). Linux-only assertions are behind a Linux platform guard and do not execute on Windows. |
| Ubuntu GitHub Actions | **PASS** | Run 43655063515 tested this exact HEAD: 58 pass, 0 fail, 0 skipped. Linux process-group, bootstrap, and symlink coverage was executed there. |
| Unit-style policy/validation/timeout helpers | **PASS** | Validation (4), media policy (1), timeout policy (1), and shutdown deadline helper (2) all passed in the full Windows run. |
| API integration | **PASS** | 9 Fastify integration tests passed, including auth, validation, endpoints, rate limits, redaction, range responses, disconnect, and lease release. |
| Queue integration | **PASS** | 6 queue tests passed across actual P-Queue behavior and the internal queue abstraction: capacity, concurrency, rejection, cancellation, and idle settlement. |
| Process lifecycle | **PASS on Windows; PASS on Linux CI for Linux-specific cases** | Windows: fake process cancellation/tree (1), managed process (3), yt-dlp runner behavior (2), shutdown helper (2) passed. Exact Linux process-group/shutdown tests passed in run 43655063515. Deliberately detached descendants are outside the process-group guarantee. |
| Media | **PASS for synthetic/local fixtures** | 5 FFmpeg/FFprobe synthetic tests plus 1 policy test passed; real-manager Fastify/SQLite fixture tests also passed for MP4/MKV/MP3. No YouTube network or production yt-dlp behavior was exercised. |
| Filesystem / SQLite | **PASS with Windows symlink skip** | SQLite fixture integration (7), recovery (2), manager TTL/lease, failure injection, and retention cases passed. Manager symlink case skipped on Windows and ran in the successful Ubuntu suite. ENOSPC/read-only/rename paths are deterministic injected failures, not physical disk exhaustion. |
| Syntax | **PASS** | `node --check` run for every JavaScript file under `src`, `test`, and `test-support`. |
| Clean install | **PASS** | `npm ci` completed from the committed lockfile. Dependency tree: `@fastify/rate-limit@10.3.0`, `dotenv@16.6.1`, `fastify@5.12.8`, `p-queue@8.1.1`. |
| Dependency audit | **PASS** | `npm audit --omit=dev` on 2026-11-15: 0 vulnerabilities. No dependency or lockfile changes. |
| Diff checks | **PASS** | `git diff --check` and `git diff --cached --check` passed before Phase 7 documentation edits; rerun after edits is recorded below. |

The exact `npm test` Windows output was `1..54`, `pass 53`, `fail 0`, `skipped 1`. Some test layers overlap; the categorized counts above are not intended to sum to the suite total. GitHub Actions run 43655063515 reports the Linux total separately as 58/58.

## Security, configuration, and compatibility review

- Authentication uses `x-api-key` and supported Bearer form; health is public while the other API routes are authenticated. Tests cover missing, incorrect, malformed, and accepted test credentials, and log redaction. The checked-in workflow and tests use no GitHub secrets. No secret contents were read or added to this report.
- URL validation restricts supported YouTube hosts and single-video URL forms, rejects credentials, custom ports, fragments, playlist/extra query parameters, and malformed IDs. yt-dlp/FFmpeg launch uses argument arrays with `shell:false`; executable output, media type, stored path, and file size are checked. File streaming enforces a job UUID and manager-owned resolved path, supports one byte range, and holds a lease during transfer. Symlink escape and cleanup behavior ran on Ubuntu CI.
- Global and route-specific limits exist; `/info`, `/formats`, and `POST /downloads` have independent limits. Their 429 behavior and headers are covered. Health remains public. Request validation and error handling avoid returning child stack traces or filesystem paths. CORS is not enabled; no browser cross-origin use is part of the stated API contract.
- Managed subprocesses use `shell:false`, bounded output, timeouts, abort handling, TERM/KILL escalation, and Linux process groups. A descendant that deliberately invokes `setsid()` can leave the group and is not guaranteed to be stopped. The test explicitly cleans its detached fixture; no stronger OS sandbox is implemented.
- Recovery validates actual media with FFprobe, format/container/codec policy, size, and regular-file checks before completion. MP4 policy requires H.264, AAC-LC when audio exists, preserves audio tracks, and uses faststart. MKV/MP3 synthetic lifecycle output passed. This does not prove every production yt-dlp selector/source combination.
- Queue cancellation removes waiting tasks in the application queue; running slots remain occupied until the work settles. SQLite uses an exclusive lock, WAL, bounded busy timeout, error propagation, and recovery. Stale lock removal is intentionally an operator decision after PID/ownership verification.
- Environment requirements inspected from source and safe project files only: Node 22-compatible runtime, default port 3100, configurable host and executable paths, `STORAGE_PATH`, database/storage/log locations, duration/file/queue limits, timeout bounds, and required configuration validation. No actual `.env` values were inspected. CI and local runtime passed on Node 22. The known VPS runtime `v22.23.3` is the same major runtime but was not tested on the VPS. No database schema migration was identified in this review; SQLite creates/uses the `jobs` table and index.
- **P2 compatibility mismatch:** `package.json` declares `engines.node >=20`, but source imports `node:sqlite`; official Node documentation records that built-in module as added in v22.5.0. Thus Node 20 is not actually supported by this implementation despite package metadata. The stated VPS Node 22.23.3 is compatible; declare a Node 22 minimum in a separately approved code change before claiming Node 20 compatibility. [Node.js SQLite documentation](https://nodejs.org/api/sqlite.html#sqlite).
- Runtime dependencies are all used by the app. `npm audit --omit=dev` found no current production advisories. No upgrade was made; the lockfile remains authoritative.

## New findings and residual risk

### P1 — Failed initial durable save leaves a ghost in-memory job

In `src/services/download-manager.js`, `createDownload()` inserts the newly queued job into `jobs` before calling `persistJob(job, { required: true })` (current reviewed lines 636–637). If SQLite rejects that first save, the Map entry is not removed and the task is never added to the queue. The ghost can appear in `GET /downloads`, remain in `queued` indefinitely, and is not represented durably. Fastify's error handler also converts the manager's `JOB_PERSISTENCE_FAILED` 503 into generic `INTERNAL_ERROR`/500 because it forwards only 4xx statuses. Existing tests prove SQLite save errors propagate and prove a later completed-write failure is contained, but do not exercise this exact manager-level initial-save failure. This is a data/state integrity blocker; fix by persisting before publishing to the Map or rolling back the Map entry on failure, then add manager+Fastify+SQLite failure-injection coverage. No source fix was made in this review-only phase.

### P2 — Declared Node engine range is broader than required runtime

`engines.node >=20` conflicts with the `node:sqlite` dependency introduced in Node 22.5. It does not block the known Node 22 VPS target, but it can cause unsupported Node 20 installs to appear valid.

### Accepted / unclosed operational risks

- The API is currently reachable over public HTTP according to the supplied deployment context. API keys and response data can be observed or altered by a network-path observer. User acceptance of HTTP temporarily does not remove that exposure. Without changing the friend-owned Nginx/TLS/firewall services, practical mitigations are to limit callers to trusted networks where already possible, avoid sending credentials over public paths, and use an SSH tunnel for operator-only access when SSH access is separately authorized. These mitigations are not claimed as applied.
- Process-group cancellation cannot guarantee termination of a child that intentionally detaches with `setsid()` or equivalent. It needs explicit fixture cleanup; no broad-kill is used.
- Fake yt-dlp and generated media prove the application's pipeline/arguments/validation under controlled inputs, not YouTube availability, cookies, production yt-dlp binary behavior, or live format selection. No YouTube download was performed.
- ENOSPC/read-only/rename failures are injected deterministically. Physical storage exhaustion, device-level failures, sustained VPS throughput, and actual production free-space behavior remain unmeasured.
- CI success is evidence for commit `e2d29b6884b983c0f207dd08e342405aa316e9c0`, not proof of production environment, secrets, executable paths, actual storage mount, or service integration.
- Tmux itself is not a supervisor for machine reboot and does not guarantee automatic restart after host failure. Stale lock after forced termination requires manual owner verification; never remove it automatically.

## Final acceptance matrix

| Criterion | Status | Evidence / limitation |
|---|---|---|
| Reviewed branch/commit matches passing Linux CI | **PASS** | HEAD is `e2d29b6884b983c0f207dd08e342405aa316e9c0`; run 43655063515 is successful on this exact commit/workflow. |
| Windows full suite | **PASS** | 53 pass, 0 fail, 1 symlink permission skip out of 54 tests. |
| Ubuntu Linux full suite | **PASS** | Exact-HEAD run: 58 pass, 0 fail, 0 skip. |
| Unit-style validation/policy/timeout helpers | **PASS** | 8 assertions groups/test cases as described above; all pass. |
| Fastify/API integration | **PASS** | 9 tests pass; dummy credentials only. |
| Queue integration and cancellation | **PASS** | 6 tests pass; no stranded waiter in application queue tests. |
| Process lifecycle and Linux group shutdown | **PASS** | Linux CI proves owned process group/shutdown cases. Detached child remains explicitly outside guarantee. |
| Synthetic media and real-manager format lifecycle | **PASS** | Local synthetic media/fake downloader only; no production yt-dlp or live source proof. |
| Filesystem and SQLite fixtures | **PASS** | Manager/SQLite/recovery paths pass; physical ENOSPC not tested; Windows symlink test skips but Linux symlink test passes. |
| Authentication, redaction, rate limits, ranges | **PASS** | Fastify integration with dummy secrets; no production key used. |
| Dependency audit | **PASS** | 0 production vulnerabilities on 2026-11-15. |
| Durable state when first job save fails | **FAIL** | Ghost in-memory queued job is possible; exact failure path has not been covered by a manager-level test. |
| Node 20 package-engine claim | **PARTIAL** | Known target Node 22 is compatible; package metadata incorrectly allows Node 20 despite `node:sqlite`. |
| Production HTTP confidentiality | **PARTIAL** | User accepts HTTP temporarily, but API key confidentiality is not protected on a public network path. |
| Production yt-dlp/YouTube and physical storage behavior | **NOT TESTED** | Deliberately excluded from local/CI tests. |
| Deployment and rollback runbook | **PASS — written only** | Detailed procedure is in `RELEASE_REVIEW.md`; no step was executed. Owner approval and backups remain prerequisites. |

## Decision

**NO-GO.** Do not advance this commit to deployment review yet. Linux CI and the broader test matrix are strong, but the confirmed P1 initial-persistence failure can leave an API-visible queued job that has no queue task and no SQLite row. Close that state-integrity bug and add a failing-save integration test before requesting another release review. Also correct the Node engine metadata in an approved implementation change. This decision is review-only; no deployment or restart was attempted.

`RELEASE_REVIEW.md` contains the operator summary and a written, unexecuted deployment/rollback runbook. All runbook steps require explicit approval from the VPS owner and must be performed by an authorized operator; this phase did not contact or access the VPS.

# PHASE 8 — Job Creation Atomicity & Persistence Error Handling

Date: 2026-11-15. Work was limited to the isolated Phase 6 clone on branch `codex/phase6-linux-ci`, based at HEAD `e2d29b6884b983c0f207dd08e342405aa316e9c0`. At start, the working tree already contained the Phase 7 documentation changes (`AUDIT_REPORT.md` modified and `RELEASE_REVIEW.md` untracked); those were preserved. No checkout/reset/stash/clean, commit, push, VPS access, deployment, or restart was performed. No `.env`, cookies, production database, logs, API key, or downloads were read or changed.

## Root cause and implementation

- **P1 fixed locally:** `createDownload()` previously inserted into the in-memory `jobs` Map before required SQLite persistence. A failed insert returned an error but left a queued-looking job that had no durable row and no queue task.
- `src/services/sqlite-store-core.js` now offers `createJob()` using a plain prepared `INSERT`, separate from the existing upsert `saveJob()`. This makes initial creation atomic and ensures a UUID collision cannot overwrite another row. A failing SQLite statement leaves no partial row.
- `src/services/job-store.js` exposes the new operation as `createStoredJob()`.
- `src/services/download-manager.js` now creates a temporary job and durably inserts it first. The synchronous `JobQueue.add()` admission follows. The queue defers `run()` to a microtask, so after admission the manager publishes the Map entry in the same JavaScript turn before any worker can observe it. There is no `await` between queue capacity check, initial insert, admission, and publication; concurrent request handlers cannot interleave those steps in the event loop.
- If initial INSERT fails, no Map entry or task has been made. The manager throws a sanitized `JOB_PERSISTENCE_FAILED`/503 error and logs only a safe SQLite error code, not SQL, path, or error message.
- If synchronous queue admission fails after persistence, the manager never publishes to the Map. It attempts a durable DELETE. If DELETE fails, it attempts a compensating `failed` update. If both fail, it logs the job UUID and safe error codes only; any residual durable `queued` row is not API-visible and existing startup recovery transitions it to `interrupted`. This residual path is tested. The recovery rule is retained rather than deleting or hiding an uncertain durable record.
- A Map publication exception after queue admission aborts the task, suppresses its rejected promise, and runs the same compensation path. Because the actual queue executes work on a later microtask, abort happens before worker processing can begin in this synchronous failure path.
- Concurrent create requests and create-only ID collision are tested. SQLite's single synchronous insert and the queue's synchronous admission prevent interleaving within create; `INSERT` rejects duplicate IDs instead of upserting.
- `src/services/job-queue.js` documents its synchronous-admission/deferred-run contract. `getDownloadManagerDiagnostics()` and `setQueueAdmissionForTests()` provide internal observability/failure injection; they are not API routes.

## HTTP error mapping

- Previously, the manager's `AppError` with `statusCode: 503` and `JOB_PERSISTENCE_FAILED` fell through `src/app.js` to the generic 500 handler.
- The error handler now maps only the known job persistence, queue-admission, and job-publication service errors to fixed safe 503 responses. Other unknown 5xx errors remain HTTP 500 `INTERNAL_ERROR` with a generic message.
- Generic 5xx logs now include only a validated error code, not an error object/stack/cause. Manager persistence logs include only the job UUID and safe error code. Tests verify that SQL/path fixture strings do not appear in API responses or captured logs.

## Node.js minimum audit

`node:sqlite` / `DatabaseSync` was added in Node 22.5.0, but this application reads `database.isOpen` in `src/services/sqlite-store-core.js`; Node's v22.23.3 documentation lists `DatabaseSync.isOpen` as added in v22.15.0. `fs.statfs` used by the manager predates that floor. The accurate minimum for the currently used APIs is therefore **Node >=22.15.0**. [Node.js v22.23.3 SQLite API history](https://nodejs.org/download/release/v22.23.3/docs/api/sqlite.html#databaseisopen) documents the property version.

- `package.json` and the root package metadata in `package-lock.json` now state `>=22.15.0`; dependency lock versions were not upgraded.
- `src/runtime-requirements.js` provides a startup check. `src/server.js` calls it before dynamic imports of config, SQLite, and the manager, so older Node versions receive the explicit minimum-version message before the application opens storage or reads runtime secrets.
- The GitHub workflow continues to use Node 22 on Ubuntu 24.04. Local Windows Node is v22.15.1; known VPS Node v22.23.3 is above the minimum. No VPS version/path/config was checked.

## Added/updated tests and actual results

### Targeted Phase 8 tests

- `node --test test/real-manager-integration.test.js test/fastify-integration.test.js` (rerun after the final worker-order and log-redaction assertions): **25 tests, 24 pass, 0 fail, 1 skip**. The skip is the existing symlink test blocked by Windows `EPERM`. New runtime integration cases prove initial SQLite failure, successful creation with a held fake downloader, two concurrent creations with exactly one execution each, queue-admission compensation, and double compensation failure followed by interrupted recovery.
- `node --test test/fastify-integration.test.js test/sqlite-integration.test.js test/runtime-requirements.test.js`: **19 tests, 19 pass, 0 fail, 0 skip**. Includes unknown 503→generic 500, safe error response, SQLite create-only ID collision protection, and version floor behavior.

### Full Windows verification

- `npm ci`: **PASS**, 55 packages added / 56 audited, 0 vulnerabilities. No dependency version upgrade.
- Syntax check for all JavaScript under `src`, `test`, and `test-support`: **PASS**, 39 files.
- `npm test`: **62 tests, 61 pass, 0 fail, 1 skip**. The skipped test is symlink creation on Windows (`EPERM`). Linux-only tests remain behind Linux platform guards and are not counted as Windows behavioral proof.
- `git diff --check` and `git diff --cached --check`: **PASS** after final edits. Manual trailing-whitespace scan of both Markdown documents: **PASS**.
- The targeted Phase 8 tests were run separately as listed above; the full suite was run after `npm ci`.

### Linux CI

**NOT TESTED for Phase 8.** Passing run `43655063515` tested Phase 7 commit `e2d29b6884b983c0f207dd08e342405aa316e9c0`; it does not prove this local Phase 8 patch. No push was performed, so a workflow run for the new source is unavailable. Linux CI must be run on an authorized commit containing this patch before release review can pass.

## Phase 8 acceptance matrix

| Criterion | Status | Evidence / residual |
|---|---|---|
| Initial SQLite failure returns 503 `JOB_PERSISTENCE_FAILED` | **PASS — Windows** | Real Fastify + manager + SQLite trigger. Safe message; no SQL/path leaked. |
| No Map publication, queue task, SQLite row, or downloader after failed initial insert | **PASS — Windows** | Map/list and queue diagnostics unchanged, row count unchanged, fake runner call count unchanged, health still 200. |
| Successful creation durable before API exposure | **PASS — Windows** | Initial durable row, valid ID, Map/detail visibility, one real JobQueue task and one held fake downloader. |
| Queue admission failure compensation | **PASS — Windows** | Injected sync admission failure deletes SQLite row; no Map/queue/task/process remains; stable safe 503. |
| Compensation delete and update both fail | **PASS — Windows** | Row remains durable but unpublished; safe residual log; startup recovery changes it from `queued` to `interrupted`. |
| Concurrent create requests and duplicate ID protection | **PASS — Windows** | Two simultaneous requests produce distinct durable IDs and one execution each; SQLite create-only operation rejects collision without overwriting the original row. |
| Recognized persistence error status/code/message | **PASS — Windows** | HTTP 503 with `JOB_PERSISTENCE_FAILED` and fixed safe message. |
| Unknown errors stay generic 500 | **PASS — Windows** | HTTP 500 `INTERNAL_ERROR`; test SQL/path details absent from response. |
| Minimum Node metadata and startup guard | **PASS — Windows** | Node >=22.15.0 in package and root lock metadata; unit tests reject 22.14 and accept 22.15.0/22.23.3; startup guard runs before config/store imports. |
| Full Windows regression suite | **PASS** | 61 pass, 0 fail, 1 platform skip, 62 total. |
| Linux CI for Phase 8 patch | **NOT TESTED** | Must run against a commit containing the Phase 8 patch; no push/commit was made. |
| Public HTTP confidentiality / detached descendants / real YouTube / physical ENOSPC | **NOT TESTED / residual** | Unchanged and outside this phase; Phase 7 risks remain. |

## Files changed in Phase 8

- Modified: `src/services/sqlite-store-core.js`, `src/services/job-store.js`, `src/services/download-manager.js`, `src/services/job-queue.js`, `src/app.js`, `src/server.js`, `package.json`, `package-lock.json`, `test/real-manager-integration.test.js`, `test/fastify-integration.test.js`, `test/sqlite-integration.test.js`, `AUDIT_REPORT.md`, `RELEASE_REVIEW.md`.
- Added: `src/runtime-requirements.js`, `test/runtime-requirements.test.js`.
- No other prior changes, backups, staging, `.env`, cookies, database, storage, logs, or user files were removed or reset.

## Residual risk and decision

- The create/initial persistence P1 is fixed and its specified local Windows integration paths pass. The queue rollback double-failure case intentionally may leave a durable `queued` row until startup; it is not exposed in memory and recovery converts it to `interrupted`. The safe diagnostic log is the only immediate signal if both compensation operations fail.
- The HTTP public API key exposure remains; this phase made no TLS/infrastructure changes. Process-group cancellation still cannot guarantee a deliberately detached descendant is stopped. Tests still use fake yt-dlp and synthetic media, and physical disk exhaustion is not tested.
- No Linux run covers the changed Phase 8 source. The previous Phase 7 Linux run cannot be reused as proof.

**Release decision remains NO-GO pending Linux CI on the Phase 8 patch and a new review.** No deployment, restart, commit, push, or VPS access occurred.
