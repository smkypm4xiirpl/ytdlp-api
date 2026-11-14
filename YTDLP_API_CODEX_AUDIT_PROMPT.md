# Master Task untuk Codex — Audit, Hardening, dan Improvement YT-DLP REST API

> **Tujuan:** lakukan audit teknis menyeluruh terhadap project `ytdlp-api`, perbaiki bug dan risiko yang terbukti, tingkatkan reliability/security/maintainability, lalu berikan laporan dan prosedur pengujian yang bisa diverifikasi.
>
> **Cara menggunakan:** buka folder project `~/apps/ytdlp-api` di Codex, lalu berikan seluruh dokumen ini sebagai instruksi utama. Jangan menganggap semua dugaan di bawah sebagai bug yang sudah pasti; verifikasi terhadap source code dan versi dependency yang terpasang sebelum mengubah apa pun.

---

## 0. Peran dan standar kerja

Bertindak sebagai **senior Node.js/Fastify backend engineer, media-processing engineer, dan application security reviewer**. Kerjakan secara sistematis, bukan sekadar memberi saran.

1. Audit source code, konfigurasi, dependency, alur request, proses child-process, penyimpanan file, queue, persistence, dan lifecycle server.
2. Identifikasi akar masalah dengan bukti dari kode atau hasil pengujian. Bedakan antara bug terkonfirmasi, risiko potensial, dan improvement opsional.
3. Buat rencana singkat berdasarkan prioritas sebelum mengedit.
4. Implementasikan perbaikan yang jelas manfaatnya dan aman dalam batasan di dokumen ini. Jangan berhenti hanya pada laporan jika perbaikannya dapat dilakukan dengan aman.
5. Jangan melakukan refactor besar hanya demi gaya. Pertahankan API contract dan struktur project kecuali ada alasan teknis yang kuat.
6. Jangan mengklaim test berhasil jika test belum benar-benar dijalankan. Catat perintah dan hasilnya.
7. Jangan menyembunyikan kegagalan. Jika suatu test memerlukan akses jaringan, video, kredensial, resource, atau izin yang tidak tersedia, tandai sebagai **belum diuji** dan berikan cara uji manual.

**Penting:** project berada di VPS yang juga menjalankan layanan milik orang lain. Prioritaskan isolasi dan non-disruption. Tidak ada izin untuk mengubah layanan lain.

---

## 1. Konteks project dan lingkungan yang diketahui

### Project

- Nama: `YTDLP API`.
- Lokasi: `/home/lukman/apps/ytdlp-api`.
- Runtime: Node.js `v22.23.3`, npm `10.9.9`.
- Framework: Fastify 5.
- Queue: `p-queue`.
- Persistence job: SQLite melalui `node:sqlite`, WAL dan busy timeout telah digunakan.
- Downloader: yt-dlp `2026.10.26`.
- Media tools: FFmpeg dan FFprobe static `7.0.2`.
- Binary yt-dlp: `/home/lukman/bin/yt-dlp`.
- Direktori FFmpeg: `/home/lukman/bin` (executable `/home/lukman/bin/ffmpeg`).
- Binary FFprobe: `/home/lukman/bin/ffprobe`.
- Port API: `3100`, bind `0.0.0.0`.
- Proses dijalankan secara manual melalui `tmux`; belum menggunakan Docker atau systemd.

### Struktur yang diketahui

```text
~/apps/ytdlp-api/
├── src/
│   ├── routes/
│   │   ├── health.js
│   │   ├── info.js
│   │   ├── formats.js
│   │   └── downloads.js
│   ├── services/
│   │   ├── ytdlp.js
│   │   ├── download-manager.js
│   │   └── job-store.js
│   ├── middleware/
│   │   └── authentication.js
│   ├── utils/
│   │   ├── errors.js
│   │   └── validation.js
│   ├── config.js
│   └── server.js
├── storage/downloads/
├── logs/
├── backups/
├── .env
├── .gitignore
├── package.json
└── package-lock.json
```

Struktur aktual dapat berbeda. Periksa terlebih dahulu, jangan mengasumsikan semua file persis sama.

### Konfigurasi runtime yang diketahui (nilai rahasia sengaja tidak dicantumkan)

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=3100
API_KEY=<JANGAN DIBACA, DITAMPILKAN, ATAU DICATAT>
YTDLP_PATH=/home/lukman/bin/yt-dlp
FFMPEG_PATH=/home/lukman/bin
FFPROBE_PATH=/home/lukman/bin/ffprobe
STORAGE_PATH=/home/lukman/apps/ytdlp-api/storage/downloads
LOG_PATH=/home/lukman/apps/ytdlp-api/logs
DOWNLOAD_CONCURRENCY=2
MAX_QUEUE_SIZE=30
MAX_FILE_SIZE=8589934592
MAX_VIDEO_DURATION=14400
FILE_TTL_MINUTES=60
YTDLP_COOKIES_PATH=/home/lukman/apps/ytdlp-api/cookies.txt
```

Jangan membuka atau mencetak `.env`, `cookies.txt`, database yang mengandung data sensitif, API key, cookie, authorization header, maupun secret lainnya. Boleh membaca nama variabel dari source/config, tetapi jangan membaca nilai rahasianya. Jangan pernah memasukkan secret ke laporan, terminal output, patch, atau commit.

### Kondisi jaringan dan permission VPS

- User proses adalah `lukman`, bukan root; tidak memiliki hak `sudo`.
- `tmux` tersedia dan digunakan untuk menjalankan API.
- Port `3100` milik API ini.
- Port/layanan lain yang diketahui: website Next.js pada `3000`, bot Node lain pada `8788`, Docker API lain pada `18080`, Nginx pada `80/443`, Minecraft Bedrock UDP `19132`, serta service router pada `20128`.
- Jangan mengubah, menghentikan, me-restart, atau mengganggu port/service tersebut.
- Jangan menjalankan `sudo`, mengubah Nginx, sertifikat TLS, DNS, firewall, routing, atau konfigurasi host.
- Jangan meminta root atau meminta akses ke service milik teman/admin.
- API saat ini diakses melalui HTTP publik. Pemilik project memahami dan menerima risiko ini untuk sementara. Jangan mencoba memasang TLS/reverse proxy atau mengubah infrastruktur. Namun, dokumentasikan secara jujur bahwa API key melalui HTTP dapat terlihat oleh pihak yang bisa mengamati koneksi; jangan menyebut koneksi HTTP aman dan jangan menyarankan mengirim secret melalui jaringan publik yang tidak tepercaya.
- Jangan migrasi ke Docker/systemd. Pertahankan model deploy `tmux` kecuali pemilik meminta sebaliknya.

### Batasan resource dan operasional

- Download concurrency: `2`.
- Maksimum queue: `30` (perlu verifikasi arti limit: queued saja atau queued + active; rekomendasi: batasi total in-flight agar batas operasional jelas).
- Maksimum file: `8 GiB`.
- Maksimum durasi video: `4 jam`.
- TTL file/job: `60 menit`.
- Storage, logs, dan backups berada di direktori project.
- Jangan menghapus file download nyata milik user selama audit.
- Ada setidaknya satu file hasil download nyata yang pernah dipakai untuk uji MP4; jangan hapus atau timpa file tersebut.

---

## 2. Riwayat masalah dan perubahan yang sedang ada

### Masalah MP4 yang sudah direproduksi

Satu download dengan `formatId: "136"` dan `output: "mp4"` pernah menghasilkan:

- Container: MP4.
- Video: H.264.
- Audio: Opus.

Artinya `--remux-video mp4` hanya mengganti/remux container, bukan mengubah codec audio. File MP4 tersebut valid menurut container, tetapi audio Opus tidak kompatibel dengan sejumlah pemutar/perangkat.

### Kebijakan media yang diinginkan

**MP4 (prioritas kompatibilitas):**
- Target video: H.264/AVC.
- Target audio: AAC-LC.
- Jika video sumber sudah H.264, copy video tanpa re-encoding.
- Jika audio sumber sudah AAC, copy audio tanpa re-encoding bila memungkinkan.
- Jika audio bukan AAC, konversi audio ke AAC-LC dengan target bitrate `256k`.
- Jangan pernah mengklaim konversi meningkatkan kualitas audio. Transcoding lossy tidak mengembalikan detail yang sudah hilang.
- Jangan mengubah bitrate audio sumber yang di-download melalui pembatasan paksa 192/256 kbps di yt-dlp. `256k` adalah target encoder ketika konversi diperlukan, bukan batas bitrate sumber YouTube.
- Sertakan `+faststart` pada hasil MP4 bila dapat dilakukan dengan aman.
- Bila video sumber bukan H.264, jangan diam-diam menghasilkan MP4 dengan VP9/AV1 lalu menyebutnya kompatibel. Pilih kebijakan yang eksplisit dan aman: secara default lebih baik menolak format MP4 yang tidak kompatibel dengan pesan kesalahan yang jelas, atau implementasikan opsi transcode video hanya jika diminta secara eksplisit dan resource/encoder tersedia. Jangan melakukan transcode video CPU-intensif secara diam-diam.
- Audio stream yang memang tidak ada boleh tetap tidak ada, tetapi harus diverifikasi/ditangani secara eksplisit. Jangan mengasumsikan setiap video memiliki audio.
- Jika ada beberapa audio stream, jangan diam-diam menghilangkan track bahasa tanpa dokumentasi. Tentukan apakah semua track perlu dipertahankan atau API hanya mendukung satu track; dokumentasikan dan uji keputusan tersebut.

**MKV:**
- Pertahankan codec video/audio sumber (stream copy/remux) bila format sumber dan muxer memungkinkan.
- Jangan melakukan re-encoding tanpa kebutuhan atau opsi eksplisit.

**MP3:**
- Tetap gunakan ekstraksi audio MP3 VBR kualitas `0` (yt-dlp `--audio-quality 0`, ekuivalen target V0 pada jalur FFmpeg yang sesuai).
- Pastikan endpoint dan output file benar-benar MP3.

### Patch yang baru diterapkan sebelum audit Codex

File `src/services/download-manager.js` telah diedit dan `node --check` sebelumnya lolos. Backup sebelum patch dibuat di `backups/` dengan pola `download-manager.js.before-aac-*`.

Patch tersebut menambahkan:
- `probeMedia(filePath, signal)` menggunakan FFprobe.
- `convertMp4AudioToAac(job, inputPath, outputPath)` menggunakan FFmpeg, `-c:v copy`, `-c:a aac`, `-profile:a aac_low`, `-b:a 256k`, `-movflags +faststart`.
- `ensureMp4AudioCompatibility(job, filePath)` yang mengonversi jika audio bukan AAC dan mengganti file melalui temporary file setelah verifikasi.
- Verifikasi jumlah/codec audio dan bahwa codec video tidak berubah.
- Pemeriksaan final file memakai `lstat` dan nama/path yang diharapkan.
- Queue check diubah menjadi `queue.size + queue.pending >= config.maxQueueSize`.

**Jangan menganggap patch ini sempurna. Audit dan perbaiki bila perlu.** Kekurangan yang sudah diketahui/perlu ditinjau:
- Patch hanya memverifikasi codec video tidak berubah, belum memastikan H.264/AVC. VP9/AV1 bisa tetap lolos.
- Belum ada bukti bahwa `/api/v1/formats` mengelompokkan atau memberi label codec yang cocok untuk MP4.
- Perlu audit apakah format ID yang dipilih pengguna benar-benar diverifikasi terhadap codec yang dihasilkan.
- Perlu audit timeout FFmpeg/FFprobe, penanganan spawn/error/close/abort, proses yang menggantung, output stderr, serta file sementara saat proses crash.
- Perlu audit apakah `+faststart` dijamin juga ketika input audio sudah AAC dan jalur konversi dilewati.
- Perlu audit bagaimana perilaku MP4 jika input tidak punya audio atau memiliki beberapa audio stream.
- Perlu audit apakah file hasil download harus dihapus ketika post-processing gagal, atau disimpan sementara untuk retry; jangan sampai file gagal dapat diakses sebagai completed.
- Periksa queue semantics versi `p-queue` yang benar-benar terpasang. Pastikan `size` dan `pending` digunakan dengan benar dan tidak menghasilkan off-by-one atau double-counting.
- Periksa apakah task yang dibatalkan saat masih queued dan saat sedang berjalan selalu menghasilkan state final yang konsisten.

---

## 3. Ruang lingkup audit dan perbaikan

Lakukan audit menyeluruh pada area di bawah. Prioritaskan bug yang dapat menyebabkan data hilang, job macet, file invalid, resource exhaustion, kebocoran secret, atau service crash.

### A. Arsitektur, dependency, dan kualitas kode

1. Baca `package.json`, lockfile, seluruh source `src/`, konfigurasi, serta dokumentasi yang tersedia.
2. Verifikasi versi Node, Fastify, p-queue, yt-dlp, FFmpeg, FFprobe, dan SQLite API yang kompatibel dengan environment ini.
3. Jangan melakukan upgrade major dependency secara otomatis. Identifikasi dependency usang/berisiko dan usulkan upgrade terpisah dengan alasan serta dampak.
4. Cari import tidak terpakai, error handling tidak konsisten, duplikasi, state yang tidak tervalidasi, dan potensi race condition.
5. Pastikan ESM module, path handling, dan penggunaan Node 22 konsisten.
6. Jangan menambahkan dependency baru kecuali benar-benar dibutuhkan; jelaskan manfaat, ukuran, kompatibilitas, dan alternatif tanpa dependency.
7. Pastikan seluruh error memiliki kode stabil dan HTTP status yang masuk akal; detail internal tidak boleh bocor ke client.

### B. yt-dlp dan format selection

1. Audit `src/services/ytdlp.js`, khususnya `runYtDlp`, metadata, timeout, format parsing, cookies, JS runtime, FFmpeg location, dan penanganan stderr.
2. Periksa format output dari yt-dlp: `format_id`, `ext`, `vcodec`, `acodec`, `container`, `protocol`, `filesize`, `filesize_approx`, `abr`, `tbr`, `fps`, `width`, `height`, `dynamic_range`, dan informasi lain yang relevan.
3. Pastikan API tidak menyebut format sebagai kompatibel hanya berdasarkan ekstensi container. Bedakan container (`mp4`, `webm`, `mkv`) dengan codec (`avc1/h264`, `vp9`, `av01`, `mp4a`, `opus`, dan lainnya).
4. Audit pengelompokan format video-only, audio-only, dan progressive. Jangan menyusun format selector yang menghasilkan stream duplikat atau kombinasi yang salah.
5. Periksa apakah format ID yang diterima endpoint download dapat berupa ID video-only, audio-only, atau kombinasi. Validasi ini harus sesuai dengan kontrak endpoint dan `buildYtDlpArgs()`.
6. Untuk output MP4, expose/label hanya pilihan yang memenuhi kebijakan H.264 atau tolak format tidak kompatibel di server-side. Jangan percaya hanya pada label dari client; verifikasi file hasil dengan FFprobe.
7. Pastikan fallback format selector tidak secara diam-diam berpindah ke format yang tidak memenuhi codec target.
8. Audit `--max-filesize`, `--match-filter duration <= ...`, playlist prevention, cookies, `--socket-timeout`, `--no-overwrites`, output template, dan flags lainnya berdasarkan versi yt-dlp terpasang. Periksa perilaku bila duration/filesize tidak diketahui.
9. Pastikan proses tidak bisa mengambil URL arbitrer. Pertahankan validasi allowlist domain YouTube dan video ID. Periksa redirects, URL yang malformed, port khusus, userinfo, IP literal, hostname mirip, dan parameter yang tidak diperlukan.
10. Jangan mematikan pemeriksaan TLS untuk yt-dlp atau mengabaikan error sertifikat.
11. Pastikan cookies hanya digunakan untuk domain yang diperlukan melalui mekanisme yt-dlp yang tepat, tidak dibaca/dilog oleh API, dan permissions file cukup ketat.
12. Metadata/info/formats yang lambat harus memiliki timeout dan rate-limit sesuai beban, tidak memblokir server.

### C. Kebijakan media: MP4, MKV, MP3

1. Rancang pipeline media yang konsisten dengan kebijakan pada Bagian 2.
2. Gunakan FFprobe untuk memeriksa input dan hasil akhir, bukan hanya ekstensi file.
3. MP4: verifikasi H.264/AVC untuk video dan AAC untuk setiap audio track yang dipertahankan. Bila sumber bukan H.264, default jangan melakukan transcode video diam-diam; berikan error actionable atau sediakan opsi eksplisit yang terdokumentasi.
4. MP4: bila audio sudah AAC, hindari re-encode. Bila bukan AAC, transcode ke AAC-LC 256k. Jangan mengubah video H.264 (copy saja).
5. MP4: pastikan `+faststart` diterapkan pada output final baik jalur AAC-copy maupun jalur AAC-encode, jika dapat dilakukan tanpa menurunkan kompatibilitas.
6. MP4: jangan menghasilkan file selesai jika proses konversi gagal, file invalid, tidak ada stream video yang seharusnya ada, atau codec tidak sesuai kebijakan.
7. MKV: pertahankan stream codec sumber. Pastikan remux sukses dan semua track penting ditangani.
8. MP3: pastikan audio hasil MP3 valid, dengan target kualitas yang konsisten. Periksa metadata cover art/thumbnail agar tidak menyebabkan format salah.
9. Audit subtitle, chapters, metadata, thumbnail, attachment/data streams, multi-audio, language tags, rotation/display matrix, HDR, frame rate, dan stream disposition. Tetapkan apa yang dipertahankan/dihilangkan dan dokumentasikan.
10. Periksa apakah `-map 0:v? -map 0:a?` sesuai kebutuhan. Jangan menghilangkan track penting secara diam-diam; jangan menyertakan subtitle/data yang tidak kompatibel tanpa keputusan eksplisit.
11. Pastikan file temporary berada di storage yang sama dengan file tujuan untuk atomic rename.
12. Pertimbangkan ruang disk sementara: selama transcode mungkin ada file asli dan file baru sekaligus. Pastikan storage tidak melewati batas yang ditetapkan; bila tidak ada quota filesystem, sediakan pemeriksaan ruang bebas dan penanganan `ENOSPC`.
13. Pastikan temporary output memakai nama unik per job dan tidak bisa tertimpa oleh proses lain.
14. Tangani process cancellation, timeout, SIGTERM/SIGKILL escalation, `error` dan `close` tanpa promise hang/double settlement.
15. Jangan mematikan proses lain atau menggunakan `pkill`/`killall`. Hanya child process yang dibuat oleh job tersebut yang boleh dihentikan.

### D. Download manager, queue, dan lifecycle job

Audit seluruh fungsi di `download-manager.js`, bukan hanya bagian yang telah diubah.

1. State machine yang diperbolehkan harus jelas, misalnya `queued -> downloading -> processing -> completed`; jalur gagal/cancel/interrupted harus konsisten.
2. Cegah transisi tidak valid, misalnya completed berubah kembali menjadi processing, atau cancelled menjadi completed.
3. Pastikan queue capacity menghitung queued + active sesuai definisi limit. Verifikasi API `p-queue` pada versi terpasang.
4. Pastikan concurrency benar-benar mematuhi `DOWNLOAD_CONCURRENCY`.
5. Pastikan saat queue penuh tidak ada job yang telanjur tersimpan ke Map/SQLite.
6. Pastikan queued job yang dibatalkan tidak pernah mulai download dan tidak meninggalkan job Promise rejection yang tidak ditangani.
7. Pastikan running job yang dibatalkan menghentikan yt-dlp/FFmpeg/FFprobe yang terkait, lalu state menjadi cancelled.
8. Tangani race cancellation saat job tepat selesai, saat rename, dan saat persist state.
9. Pastikan error dari task PQueue, fungsi `executeDownload`, serta `task.catch` tidak menghasilkan state ganda atau overwrite status final.
10. Pastikan progress tidak naik ke 100% sebelum post-processing selesai. Definisikan arti progress saat download dan processing; gunakan status processing ketika FFmpeg berjalan.
11. Hindari `progress` menjadi `NaN`, `Infinity`, negatif, atau lebih dari 100.
12. Batasi ukuran stdout/stderr child-process. Jangan mengakumulasi output tanpa batas. Batasi/catat informasi diagnostik yang relevan tanpa menyimpan secret.
13. Pastikan `runDownloadProcess()` selalu settle walau binary tidak ada, permission denied, signal abort, child error, atau output marker tidak ditemukan.
14. Pastikan file final hanya ditandai `completed` setelah validasi final dan persistence yang sesuai.
15. Audit startup recovery: queued/downloading/processing saat restart harus menjadi interrupted; completed harus diverifikasi file-nya; file corrupt jangan direcover sebagai completed.
16. Cegah dua proses API aktif menggunakan storage/database yang sama tanpa lock atau mekanisme single-instance. Dokumentasikan single-instance jika memang desainnya demikian.
17. Periksa job map agar tidak tumbuh tanpa batas. Pastikan TTL benar-benar membersihkan job terminal dan record SQLite.
18. Periksa kemungkinan duplicate job atau retry yang membuat file UUID tertinggal.

### E. File storage, download streaming, TTL, dan cleanup

1. Audit `acquireDownloadFile()`, endpoint file, HTTP Range, stream `close/error/aborted`, dan pemanggilan `release()`.
2. Pastikan stream lease dilepas tepat sekali pada semua jalur (finish, close, error, client disconnect, range invalid).
3. Pastikan file tidak bisa dihapus TTL ketika sedang di-stream.
4. Pastikan file yang sedang dihapus tidak dapat dibuka kembali.
5. Pastikan pemeriksaan dan penguncian cleanup/acquire aman terhadap race condition event loop.
6. Path file harus berada di bawah `STORAGE_PATH`; jangan percaya filename dari request/database tanpa validasi. Tolak symlink dan file non-regular.
7. Jangan hanya mengandalkan `startsWith()` untuk containment path; gunakan path boundary yang benar dan `realpath/lstat` secara aman.
8. Audit TTL berdasarkan timestamp yang benar untuk semua status. Failed/cancelled/interrupted/completed perlu kebijakan retention jelas.
9. `cleanupExpiredDownloads()` perlu idempotent, aman dipanggil berulang, dan tidak crash bila satu file tidak ada atau permission error.
10. Periksa apakah `deleteStoredJob()` synchronous atau asynchronous; pastikan operasi persistence benar-benar ditunggu/ditangani.
11. Cleanup jangan pernah menghapus file yang bukan milik UUID job tersebut. Jangan gunakan prefix yang terlalu longgar.
12. File sementara FFmpeg/yt-dlp, `.part`, `.ytdl`, `.processing.mp4`, dan orphan file harus punya mekanisme stale cleanup yang aman berdasarkan pola nama dan umur. Jangan menghapus file aktif.
13. Ketika server start, bersihkan hanya orphan temporary files yang memenuhi kriteria aman; jangan menyapu seluruh storage secara membabi buta.
14. File yang corrupt, melebihi max file size, atau bukan output valid jangan menjadi completed.
15. Periksa file permissions untuk output, logs, database, cookies, dan backups. Terapkan least privilege tanpa mengganggu file milik user lain.
16. Periksa ukuran storage, free disk, inode, dan perilaku saat disk penuh. Berikan error yang jelas (`ENOSPC`) dan pastikan temp file dibersihkan.
17. Periksa Range requests: validasi start/end, suffix range, multi-range (dukungan atau penolakan eksplisit), status `206/416`, Content-Length, Content-Range, Content-Type, Content-Disposition, ETag/Last-Modified jika relevan.
18. Pastikan `HEAD` atau method lain tidak menyebabkan lease bocor bila didukung.

### F. SQLite persistence dan recovery

1. Audit `job-store.js`: schema, WAL, busy timeout, statement reuse, transaksi, serialisasi, migration, close, dan error path.
2. Pastikan hanya data yang diperlukan disimpan. Jangan menyimpan API key, cookies, authorization, atau secret.
3. Tentukan apakah URL lengkap perlu disimpan. Bila tidak perlu, simpan video ID/metadata minimal. Jika perlu, dokumentasikan retention/privacy.
4. Pastikan operasi tulis tidak diam-diam gagal lalu API mengembalikan sukses seolah persistence berhasil.
5. Jika `persistJob()` sengaja best-effort, tentukan bagaimana job state tetap konsisten dan bagaimana error dilaporkan/logged.
6. Pastikan `deleteStoredJob()` selesai sebelum job dianggap sepenuhnya dihapus.
7. Audit recovery dari state interrupted, completed dengan file hilang, file corrupt, file oversize, dan orphan media.
8. Periksa backup database dan WAL/SHM. Jangan menyalin database SQLite secara tidak konsisten ketika aktif; gunakan metode backup yang sesuai.
9. Jangan melakukan migration destruktif atau menghapus database saat audit.
10. Buat test untuk restart/recovery menggunakan database dan storage fixture sementara, bukan storage produksi.

### G. API contract, validation, authentication, dan security

Audit `server.js`, semua routes, middleware, validation, dan error helpers.

1. Health endpoint boleh tetap public, tetapi jangan membocorkan versi internal, path server, secret, detail host, atau informasi sensitif yang tidak diperlukan.
2. Semua endpoint selain health harus membutuhkan API key sesuai kontrak.
3. Periksa dukungan `x-api-key` dan Bearer. Jangan menerima API key dari query string atau body.
4. Pastikan API key tidak muncul di log, error, stack trace, URL, atau response.
5. Pastikan redaction mencakup header yang digunakan, termasuk case-insensitive behavior.
6. Periksa timing-safe comparison yang sesuai, validasi key, dan penanganan key kosong/malformed.
7. Rate limit global `120/min` perlu ditinjau. Endpoint metadata/info/formats dan download lebih mahal daripada health/status. Terapkan rate limit per-route atau per-operation yang proporsional tanpa memblokir penggunaan normal.
8. Periksa apakah rate limiter menggunakan client IP yang dapat dipalsukan melalui `X-Forwarded-For`. Karena API saat ini diakses langsung di port 3100, jangan percaya proxy headers tanpa konfigurasi trusted proxy yang benar.
9. Audit `bodyLimit`, schema, `additionalProperties: false`, URL allowlist, UUID, format ID, max lengths, enum, HTTP methods, content types, dan parameter Range.
10. Pastikan error response tidak membocorkan stack, path filesystem, command line lengkap, cookies, atau detail child process.
11. Audit Fastify `requestTimeout: 30000` terhadap timeout yt-dlp metadata yang diketahui dapat mencapai `60000`. Jangan sampai request timeout dan child-process timeout saling bertentangan. Pilih desain yang konsisten (timeout per operation atau route) tanpa membuat seluruh server rentan slow-client.
12. Audit CORS. Jangan mengaktifkan `*` dengan credential atau membuka origin tanpa kebutuhan.
13. Pastikan JSON parser/schema tidak memungkinkan prototype pollution atau objek tak terduga.
14. Periksa request flooding, concurrent metadata probes, file descriptor exhaustion, disk exhaustion, process exhaustion, dan queue exhaustion.
15. Jangan menambahkan endpoint shell/command execution, arbitrary URL proxy, arbitrary file path, file listing, atau file read.
16. URL allowlist YouTube wajib dipertahankan. Jangan menghapusnya untuk mempermudah download.
17. Cookies file harus tidak pernah dapat diakses melalui HTTP route atau static file server.
18. Jangan mengubah HTTP/TLS, Nginx, DNS, firewall, atau port. Beri catatan risiko HTTP secara jujur saja.

### H. Logging, observability, dan operasional

1. Audit logging Fastify dan service. Log perlu membantu diagnosis tanpa menyimpan API key/cookies/authorization.
2. Jangan log seluruh command argument yang mungkin memuat URL sensitif atau cookie path/secret.
3. Gunakan log level production yang tepat; jangan menyalakan debug berlebihan.
4. Pastikan child process error mencatat nama program, error code, dan pesan aman; batasi stderr yang dipublikasikan.
5. Tambahkan informasi job ID, status, durasi, output, dan error code untuk traceability.
6. Pertimbangkan metric ringan: queue size, active jobs, completed/failed/cancelled, processing duration, free disk, cleanup results. Jangan menambah monitoring stack besar.
7. Pastikan log rotation atau batas ukuran log agar storage tidak penuh. Jangan menghapus log service lain.
8. Graceful shutdown: stop menerima job baru, hentikan/selesaikan job yang sesuai kebijakan, hentikan child process milik service, persist state, close SQLite, clear timer, dan exit dengan bersih.
9. Jangan mengubah `tmux` session yang sedang berjalan selama audit. Jangan kill session/proses aktif sampai pemilik menyetujui deployment.
10. Dokumentasikan fakta operasional: tmux menjaga proses saat SSH disconnect tetapi tidak menjamin auto-restart setelah crash atau reboot.

### I. Server bootstrap dan konfigurasi

1. Audit `config.js` untuk parsing env, default, tipe angka, batas minimum/maksimum, path resolution, existence, executable permissions, cookies readability, dan directory creation.
2. Pastikan nilai seperti port, concurrency, queue limit, TTL, max duration, dan max file size tervalidasi dan tidak menerima `NaN`, `Infinity`, nol yang tidak masuk akal, atau angka negatif.
3. Pastikan config tidak menampilkan nilai API key atau cookie path sensitif saat error/log.
4. Periksa direktori storage/log/backups dibuat dengan permission yang aman.
5. Pastikan server startup gagal dengan pesan actionable bila binary wajib tidak ada/tidak executable, bukan crash tanpa informasi.
6. Pastikan server tidak bind ke alamat atau port yang tidak diharapkan karena default/env mismatch.
7. Health/readiness: bedakan proses hidup dari dependency siap (SQLite, storage, executable). Jangan membuat health public membeberkan detail internal.

### J. Testing dan quality gates

Buat atau tingkatkan test sesuai struktur project yang ada. Jangan menambahkan test framework baru tanpa alasan.

Minimum test yang diharapkan:

- Unit test URL validation: YouTube valid, subdomain yang diizinkan, domain palsu, ID invalid, port, credentials/userinfo, protocol selain HTTP(S), URL playlist, malformed URL.
- Unit test format normalization dan grouping: progressive, video-only, audio-only, H.264, VP9, AV1, AAC, Opus, format ID, data tidak lengkap.
- Unit test build yt-dlp args untuk MP4/MKV/MP3 dan format selector.
- Queue limit: queued saja, active + queued, batas tepat, concurrency.
- Cancellation: sebelum start, saat yt-dlp berjalan, saat FFmpeg berjalan, setelah selesai, race saat proses close/rename.
- FFprobe result: H.264+Opus, H.264+AAC, VP9+Opus, audio-only, no-audio, corrupt file, beberapa audio track.
- FFmpeg conversion: AAC output, H.264 tetap copy, bitrate target, faststart, metadata/chapter, output corrupt/empty, disk full, abort, timeout, executable missing.
- Job state transitions: success, failure, cancelled, interrupted, recovery.
- TTL: expired vs non-expired, active stream, deleting race, temp file, missing file, file tanpa record, DB record tanpa file.
- File streaming: normal, range, invalid range, client disconnect, stream error, release exactly once.
- SQLite persistence/recovery di temporary fixture.
- Security: auth required, health public, invalid key, no key in response/log, input schema rejects extra fields, URL allowlist.

Gunakan temp directory dan fixture untuk test file system. Jangan menggunakan atau menghapus file produksi di `storage/downloads`.

Jika test media memerlukan file fixture, buat file sintetis pendek memakai FFmpeg di temp directory (contoh: H.264/Opus dan H.264/AAC), bukan download video besar dari YouTube. Pastikan encoder yang dibutuhkan tersedia; bila tidak tersedia, tandai test yang tidak dapat dijalankan.

---

## 4. Bug/risiko yang wajib diprioritaskan

Urutan prioritas perbaikan:

### P0 — Correctness, data integrity, dan security

- MP4 harus sesuai kebijakan codec; jangan menganggap MP4 container otomatis berarti codec compatible.
- Verifikasi hasil media sebelum status completed.
- Proses FFmpeg/FFprobe harus cancellation-safe, timeout-bounded, dan temporary files dibersihkan.
- Jangan sampai symlink/path traversal dapat membuat file di luar storage dibaca/dihapus.
- Pastikan auth, URL allowlist, secret redaction, dan input validation tidak regress.
- Pastikan state job tidak menjadi completed sebelum file benar-benar valid.
- Pastikan file yang sedang di-download tidak terhapus oleh TTL.

### P1 — Reliability dan resource management

- Queue capacity dan cancellation/queue lifecycle.
- Timeout mismatch pada request metadata vs yt-dlp child process.
- Queue/rate limit dan proteksi resource.
- SQLite persistence/recovery yang konsisten.
- Orphan temp files, storage/free disk, batas file/durasi.
- Graceful shutdown dan error logging.
- File streaming Range dan lease release.

### P2 — Maintainability dan product improvements

- API documentation/examples dan response schema yang konsisten.
- Format response yang lebih informatif (codec, container, resolution, fps, bitrate, estimated size, compatibility label, audio/video-only).
- Progress/status yang lebih akurat selama processing.
- Better error messages/actionable error codes.
- Test coverage dan runbook operasional.
- Performance improvements yang terukur, bukan optimasi spekulatif.

Jangan menambahkan fitur baru besar seperti user accounts, dashboard, webhook, arbitrary source support, Docker migration, atau database migration besar kecuali diperlukan untuk memperbaiki risiko terkonfirmasi dan disetujui pemilik project.

---

## 5. Peraturan implementasi dan batas keselamatan

**Wajib ditaati:**

1. Sebelum mengedit, jalankan pemeriksaan read-only: `pwd`, `git status --short` (jika Git tersedia), daftar file, `package.json`, dan `node --version`. Jangan tampilkan secrets.
2. Periksa backup yang sudah dibuat: `backups/download-manager.js.before-aac-*`. Jangan menghapus backup tersebut.
3. Buat backup baru sebelum perubahan Codex. Jangan overwrite backup lama.
4. Jangan edit `.env`, `cookies.txt`, database produksi, atau file hasil download nyata.
5. Jangan menjalankan `rm -rf`, `find ... -delete`, `pkill`, `killall`, `sudo`, atau command yang dapat mengganggu service lain.
6. Jangan mengubah Nginx, TLS, DNS, firewall, systemd, Docker, host config, port service lain, atau aplikasi teman/admin.
7. Jangan restart API, kill proses Node yang sedang berjalan, atau mengubah tmux session sebelum pemilik secara eksplisit meminta deployment.
8. Jangan download video sungguhan atau membuat job produksi selama audit otomatis. Gunakan unit test dan file sintetis di temp directory. Manual end-to-end test harus menunggu persetujuan pemilik.
9. Jangan menampilkan API key, cookie, authorization header, isi `.env`, atau file credential dalam output.
10. Jangan commit/push/deploy kecuali diminta.
11. Jangan mengubah API contract secara breaking tanpa dokumentasi migration dan alasan yang kuat.
12. Jangan menyembunyikan perilaku yang ditolak: bila MP4 non-H.264 ditolak, kembalikan error code dan pesan yang actionable.
13. Saat menggunakan child process, selalu gunakan argument array dan `shell: false`; jangan membuat shell command dari input user.
14. Jangan mempercayai nilai dari request client atau database tanpa validasi ulang pada boundary yang tepat.
15. Semua file hasil edit harus memiliki error handling dan cleanup yang dapat diuji.

Jika Codex berjalan di lingkungan lokal/clone, jangan berasumsi ia sedang mengoperasikan VPS. Terapkan perubahan pada workspace yang dibuka saja dan berikan instruksi deploy manual.

---

## 6. Deliverables yang harus dihasilkan Codex

Selesaikan dengan menghasilkan semua hal berikut:

1. **Source code yang diperbaiki**, hanya untuk masalah yang terverifikasi dan improvement yang aman.
2. **Audit report** (misalnya `AUDIT_REPORT.md`) berisi:
   - Ringkasan kondisi awal.
   - Bug terkonfirmasi beserta bukti file/fungsi.
   - Risiko potensial yang belum dapat direproduksi.
   - Perbaikan yang diterapkan.
   - Hal yang sengaja tidak diubah dan alasannya.
   - Risiko residual, terutama HTTP tanpa TLS dan resource constraints.
3. **Test report**: perintah yang dijalankan, hasil, jumlah test pass/fail/skip, serta test yang membutuhkan manual verification.
4. **Patch summary**: file yang berubah dan alasan setiap perubahan.
5. **Deployment runbook** khusus deploy manual via tmux, tanpa menjalankan deployment sekarang:
   - pre-deploy backup;
   - stop/start procedure yang aman dan khusus proses API ini;
   - health check;
   - test auth tanpa mencetak API key;
   - rollback dari backup jika gagal;
   - cara memeriksa log dan status.
6. **Manual acceptance checklist** yang dapat dijalankan pemilik setelah memberi izin untuk restart dan test end-to-end.
7. Bila ada perubahan API response/request schema, sertakan contoh request/response yang tidak mengandung secret.

Jangan membuat terlalu banyak file dokumentasi yang tumpang tindih. Satu audit report, satu test report (boleh digabung), dan dokumentasi API jika memang belum ada sudah cukup.

---

## 7. Acceptance criteria — kapan pekerjaan dianggap selesai

Pekerjaan belum selesai hanya karena `node --check` lolos. Minimal semua hal berikut harus dipenuhi atau diberi label jelas sebagai belum diuji:

### Build dan static checks

- [ ] Semua source JavaScript lolos syntax check.
- [ ] Semua test otomatis yang tersedia dijalankan dan hasil dilaporkan.
- [ ] Tidak ada secret di diff, laporan, atau log baru.
- [ ] Tidak ada perubahan tidak disengaja di `.env`, cookies, database produksi, storage, atau service config.

### Media

- [ ] MP4 H.264 + AAC diterima dan diverifikasi.
- [ ] MP4 H.264 + Opus dikonversi menjadi H.264 + AAC-LC.
- [ ] H.264 video stream di-copy, tidak di-re-encode dalam jalur default.
- [ ] AAC yang sudah ada tidak di-re-encode tanpa alasan.
- [ ] MP4 dengan VP9/AV1 tidak diam-diam diklaim sebagai output H.264 compatible.
- [ ] MKV mempertahankan codec sumber.
- [ ] MP3 menghasilkan codec MP3 dan kualitas target V0.
- [ ] No-audio, multi-audio, corrupt, oversized, dan unsupported input memiliki perilaku yang eksplisit.
- [ ] Hasil MP4 menggunakan faststart bila didukung oleh pipeline.

### Queue dan job lifecycle

- [ ] Queue limit menghitung queued dan active sesuai definisi.
- [ ] Concurrency sesuai konfigurasi.
- [ ] Cancel queued/running/processing tidak meninggalkan job dalam state menggantung.
- [ ] Progress tidak mencapai 100 sebelum file final tervalidasi.
- [ ] Child process timeout, abort, missing binary, dan non-zero exit ditangani.
- [ ] Job hanya completed setelah file dan persistence final berhasil.

### Storage dan persistence

- [ ] File yang aktif di-stream tidak dihapus TTL.
- [ ] Lease dilepas tepat sekali pada semua jalur stream.
- [ ] Symlink/path traversal di luar storage ditolak.
- [ ] Temp/orphan cleanup aman dan tidak menyentuh file non-job.
- [ ] Recovery tidak menandai file corrupt/missing sebagai completed.
- [ ] SQLite failure dan delete semantics ditangani dengan benar.
- [ ] Tidak ada operasi test yang menghapus data produksi.

### Security dan operasional

- [ ] Health public; endpoint lain tetap authenticated.
- [ ] API key/cookies tidak muncul pada log atau response.
- [ ] URL non-YouTube/arbitrary URL tetap ditolak.
- [ ] Rate limit dan timeout memadai untuk endpoint mahal.
- [ ] Tidak ada `shell: true` atau interpolasi shell dengan input user.
- [ ] Graceful shutdown dan tmux runbook terdokumentasi.
- [ ] Tidak ada Nginx/TLS/DNS/firewall/port/service lain yang diubah.
- [ ] API tidak di-restart/deploy tanpa persetujuan pemilik.

---

## 8. Manual test plan setelah pemilik mengizinkan deploy

Berikan perintah yang aman dan jangan jalankan otomatis sebelum ada izin.

1. Backup source dan database dengan metode konsisten.
2. Cek syntax dan test suite.
3. Restart hanya proses API pada tmux session milik project ini; jangan menyentuh sesi/proses lain.
4. Cek `GET /api/v1/health` dan pastikan online.
5. Cek endpoint authenticated memakai API key dari environment lokal tanpa menampilkan nilainya di terminal/log/chat.
6. Request `/api/v1/formats` untuk video uji yang disediakan pemilik, lalu verifikasi label codec dan kompatibilitas format.
7. Download satu format H.264 + audio Opus ke MP4; tunggu selesai; cek dengan FFprobe bahwa output H.264 + AAC.
8. Download satu format H.264 + audio AAC ke MP4; pastikan tidak di-re-encode bila bisa diverifikasi.
9. Coba format VP9/AV1 ke MP4; pastikan ditolak dengan error jelas atau mengikuti mode transcode eksplisit yang sudah didokumentasikan.
10. Download MKV dan MP3, lalu verifikasi codec/container dengan FFprobe.
11. Uji cancel queued dan running job.
12. Uji HTTP Range dan client disconnect; pastikan lease dilepas.
13. TTL test hanya dengan fixture/temp job dan TTL pendek yang terisolasi. Jangan memodifikasi timestamp atau menghapus file download produksi untuk memaksa TTL.
14. Restart terkontrol lalu verifikasi SQLite recovery menggunakan fixture atau job yang memang disiapkan untuk pengujian.
15. Pastikan log tidak berisi API key, cookies, authorization, atau secret.

Contoh inspeksi media (gunakan path file test yang memang dibuat untuk pengujian):

```bash
~/bin/ffprobe -v error \
  -show_entries format=format_name,duration,size:stream=codec_type,codec_name,bit_rate,width,height \
  -of json \
  /path/to/test-output.mp4
```

Jangan menampilkan secret untuk menjalankan curl. Gunakan variabel environment shell yang sudah ada tanpa `echo` atau `set -x`, misalnya:

```bash
curl -fsS \
  -H "x-api-key: ${API_KEY}" \
  "http://127.0.0.1:3100/api/v1/health"
```

Health mungkin tidak membutuhkan API key; contoh di atas hanya ilustrasi penggunaan variabel untuk endpoint authenticated. Jangan menyimpan API key di command history.

---

## 9. Format laporan akhir yang diminta

Akhiri pekerjaan dengan struktur ringkas namun lengkap:

1. **Executive summary** — status dan risiko terpenting.
2. **Confirmed findings** — severity, bukti lokasi file/fungsi, dampak.
3. **Changes implemented** — perubahan beserta alasan.
4. **Tests executed** — command, pass/fail/skip, hasil nyata.
5. **Not tested / residual risks** — hal yang butuh akses atau persetujuan pemilik.
6. **Deployment instructions** — perintah manual, tidak dieksekusi.
7. **Rollback instructions** — langkah yang spesifik dan aman.
8. **Next recommended actions** — hanya hal yang benar-benar bernilai.

Jangan mengakhiri pekerjaan dengan sekadar mengatakan “sudah aman” atau “semua beres”. Gunakan bukti test, output, dan batasan yang jelas.

---

## 10. Instruksi akhir

Mulai dengan audit read-only dan validasi kondisi workspace. Setelah itu susun daftar temuan berdasarkan P0/P1/P2, lalu implementasikan perbaikan yang aman dan terverifikasi. **Jangan restart service, jangan deploy, jangan menjalankan download produksi, dan jangan mengubah infrastruktur.** Berhenti setelah source code, automated tests, audit report, test report, serta deployment/rollback runbook siap ditinjau pemilik.
