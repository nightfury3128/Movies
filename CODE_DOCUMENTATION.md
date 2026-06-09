# Athera Code Documentation

This document explains the hand-authored code files in this repository in deliberately high detail. It is written for someone who wants to understand how the project works from the outside in: what each file owns, how data flows between files, what each important class or helper does, and why the code is structured the way it is.

Generated analysis artifacts under `graphify-out/` are not treated as source code here. They are output files produced by a code graph/documentation tool, not the runtime application itself. Existing prose documents such as `README.md`, `architecture.md`, and `seek-architecture.md` are also not "code files", but they describe the same architecture at a higher level.

## Project Shape

The application is a torrent-native video streaming engine. The backend downloads a video file from a torrent, exposes that file to FFmpeg through a private local HTTP server, turns the file into fragmented MP4 HLS segments, and serves those segments to a browser. The browser uses Media Source Extensions (MSE) to append fMP4 segments directly instead of relying only on native HLS playback.

The main runtime flow is:

1. Browser submits a magnet link from `test.html`.
2. `backend/server.js` routes the request to `backend/routes/torrent.js`.
3. `routes/torrent.js` creates or joins a session through `backend/session/manager.js`.
4. The session starts `backend/provider/webtorrent.js`, which downloads the torrent and serves byte ranges to FFmpeg.
5. `backend/pipeline/codec.js` probes the source to decide whether FFmpeg can remux or must transcode.
6. `backend/pipeline/ffmpeg.js` starts FFmpeg to create fMP4 HLS output.
7. `backend/core/timeline.js` records every generated segment by media time.
8. `backend/routes/stream.js` serves `init.mp4`, playlists, and `.m4s` segments to the browser.
9. `backend/pipeline/seek.js` runs temporary FFmpeg workers for large seeks so the browser does not have to wait for the main encoder to reach the seek target.
10. `test.html` consumes server-sent events, fetches segment files, appends them into MSE, and displays extensive diagnostics.

The most important design rule in the backend is: the timeline registry is authoritative. Files on disk and playlist order are useful, but the system decides which segment covers which time by using `SegmentTimelineRegistry`.

## Runtime Dependencies

The backend depends on:

- Node.js 18 or newer, because `backend/package.json` declares `"engines": { "node": ">=18.0.0" }` and the code uses native ES modules plus modern Node APIs.
- FFmpeg and ffprobe installed on the system. The code shells out to `ffprobe` in `pipeline/codec.js` and starts FFmpeg through `fluent-ffmpeg` in `pipeline/ffmpeg.js`.
- WebTorrent, used by `backend/provider/webtorrent.js` to acquire torrent pieces.
- Fastify, used by `backend/server.js` for HTTP routing.

## `backend/package.json`

This file defines the backend package metadata, scripts, runtime module type, and dependencies.

Important fields:

- `"name": "athera-engine"` identifies the package.
- `"version": "2.0.0"` marks the package version.
- `"description"` states the high-level goal: torrent-native HLS with timeline-authoritative seek.
- `"main": "server.js"` points to the backend entry file.
- `"type": "module"` tells Node to treat `.js` files as ES modules. This is why files use `import` and `export` instead of `require()` and `module.exports`.
- `"scripts.start": "node server.js"` starts the backend normally.
- `"scripts.dev": "node --watch server.js"` starts the backend with Node's watch mode so changes restart the process.

Dependencies:

- `fastify`: HTTP server framework.
- `@fastify/cors`: CORS support so the browser can call the backend.
- `@fastify/static`: static file serving.
- `fluent-ffmpeg`: JavaScript wrapper around the FFmpeg command-line binary.
- `webtorrent`: torrent client.
- `pino-pretty`: pretty logging transport for Fastify.
- `memory-chunk-store`: present as a dependency, although the active torrent store implementation is custom in `provider/evicting-store.js`.

## `backend/server.js`

This is the backend entry point. It wires together cache, sessions, routes, static file serving, health checks, startup, and shutdown.

### Imports

- `Fastify` creates the HTTP server.
- `@fastify/cors` allows browser clients to call the server.
- `@fastify/static` serves static files from the backend directory.
- `path` and `fileURLToPath` compute filesystem paths under ES modules.
- `SessionManager` owns active per-torrent sessions.
- `SegmentCache` owns persistent on-disk HLS output.
- `torrentRoutes` registers torrent lifecycle and seek endpoints.
- `streamRoutes` registers HLS file-serving endpoints.

### Top-Level Configuration

`__dirname` is reconstructed from `import.meta.url` because ES modules do not provide CommonJS `__dirname`.

`ENABLE_TFDT_NORMALIZATION` reads `process.env.ENABLE_TFDT_NORMALIZATION` and treats `1`, `true`, `yes`, and `on` as enabled. The flag is printed at startup. The variable is not directly consumed in `server.js`; the seek pipeline has its own copy of the same environment flag. This log is useful because TFDT normalization changes seek-worker fragment behavior.

### Segment Cache Startup

```js
const segmentCache = new SegmentCache();
segmentCache.start();
```

This creates the persistent cache manager and ensures the cache directory exists. It also loads LRU metadata and removes stale seek scratch directories.

### Session Manager Startup

```js
const sessionManager = new SessionManager(segmentCache);
```

The session manager receives the cache because every session needs an HLS output directory derived from its torrent info hash.

### Fastify Instance

Fastify is configured with an `info` logger and `pino-pretty` formatting. The logger ignores process id and hostname fields to keep development logs readable.

CORS is registered with `origin: '*'`, which means any web page can call this server. That is convenient for local testing, but it would need tightening for a production deployment.

### Static Serving

`@fastify/static` serves the backend directory at `/`. This is mainly useful for backend-local assets. The root test page is not in the backend directory, so `server.js` separately serves `../test.html` for `/`.

### Route Registration

`torrentRoutes` is mounted under `/torrent` and receives `sessionManager` and `segmentCache`.

`streamRoutes` is mounted under `/stream` and receives the same two objects.

This is how route modules share application state without importing global singletons.

### Root Route

`GET /` reads `test.html` from the repository root and sends it as `text/html`.

The file is read dynamically for each request. That makes development easy because editing `test.html` does not require restarting the backend.

### Health Route

`GET /health` returns:

- `status: "ok"`
- current server time
- number of active sessions
- cache byte usage
- Node heap usage in MB

This route is a lightweight operational check.

### Startup

The port defaults to `3000`, and the host defaults to `0.0.0.0`. Both can be overridden with `PORT` and `HOST`.

The server exits with code `1` if Fastify cannot listen.

### Graceful Shutdown

`shutdown(sig)` handles `SIGTERM` and `SIGINT`.

It closes Fastify first, then loops over all active sessions and stops:

- FFmpeg generators
- directory watchers
- torrent managers

The shutdown code resumes no paused process except indirectly through session cleanup. It exits the process after best-effort cleanup.

## `backend/logger.js`

This file provides a tiny namespaced logging wrapper.

### Log Levels

`LEVELS` maps:

- `error` to `0`
- `warn` to `1`
- `info` to `2`
- `debug` to `3`

`LOG_LEVEL` from the environment controls the active level. If the environment variable is absent or unrecognized, the level defaults to `info`.

### `ts()`

Returns the current local time as `HH:MM:SS`.

### `fmt(ns, msg, meta)`

Builds a log line:

```text
[12:34:56][torrent] Message {"optional":"metadata"}
```

The `ns` namespace is important because the backend has many concurrent systems: torrent, FFmpeg, seek worker, route, session, and watcher logs. Namespacing makes mixed logs easier to scan.

### Exported Logging Functions

- `log(ns, msg, meta)` writes info-level logs.
- `warn(ns, msg, meta)` writes warning logs.
- `err(ns, msg, meta)` writes error logs.
- `dbg(ns, msg, meta)` writes debug logs.

Each function checks the configured level before writing.

### `fmtBytes(n)`

Formats byte counts as:

- bytes
- KB
- MB
- GB

This helper is used in human-readable torrent logs.

## `backend/cache/segment-cache.js`

This file implements a persistent least-recently-used cache for generated HLS output.

The cache stores one directory per torrent:

```text
backend/cache/segments/<infoHash>/
```

A cached torrent directory can contain:

- `init.mp4`
- `master.m3u8`
- many `.m4s` segments
- `timeline.json`
- possibly `seek_init.mp4`

### Constants

`DEFAULT_CACHE_DIR` points to `backend/cache/segments`.

`DEFAULT_MAX_BYTES` reads `CACHE_MAX_GB`, defaults to `10`, and converts GB to bytes. The comment says the supported range is 10-50 GB, but the code does not clamp the value; it trusts the environment variable.

### `SegmentCache`

The class tracks:

- `cacheDir`: root cache directory.
- `maxBytes`: eviction threshold.
- `_lru`: map from info hash to last access timestamp.

### `start()`

Creates the cache directory, loads the LRU file, and removes orphaned seek directories.

This should run once at server startup.

### `dir(infoHash)`

Returns the absolute HLS directory path for one torrent.

The method does not create the directory. Callers create it when needed.

### `touch(infoHash)`

Updates the info hash's last-used timestamp and writes the LRU metadata to disk.

This is called when a session starts or a viewer joins.

### `isComplete(infoHash)`

Checks whether a cached transcode is complete enough to serve without starting FFmpeg again.

It requires:

- `master.m3u8` exists.
- The playlist includes `#EXT-X-ENDLIST`.
- The playlist contains at least 30 `#EXTINF` entries.

The 30 segment requirement prevents very short or partially generated outputs from being mistaken for complete cache entries.

### `totalBytes()`

Sums the sizes of direct files inside each cache subdirectory.

Important limitation: `_dirSize()` only walks one directory level. It is fine for the current HLS layout, because segments are direct children of the info-hash directory.

### `evict()`

Sorts LRU entries from oldest to newest and removes old directories until total cache size is at or below `maxBytes`.

It deletes both:

- `<infoHash>`
- `<infoHash>_seek`

The `_seek` directory is temporary scratch output for seek workers.

### `_cleanOrphanedSeekDirs()`

Deletes any directory whose name ends with `_seek`. This handles crashes or forced server stops that leave worker scratch directories behind.

### `_lruPath()`, `_loadLru()`, `_saveLru()`

These methods persist the LRU map in `lru.json`.

The code intentionally swallows read/write errors. Cache metadata failure should not crash streaming.

## `backend/session/manager.js`

This file owns the in-memory session registry.

A session represents one active torrent stream. Sessions are keyed internally by `sessionId`, but there is at most one non-error active session per `infoHash`. This lets multiple viewers share the same torrent download and FFmpeg process.

### `extractInfoHash(magnet)`

Extracts the BitTorrent info hash from a magnet URI.

It supports:

- 40-character hex BTIH values.
- 32-character base32 BTIH values.

It returns lowercase text or `null`.

The backend uses this to deduplicate sessions and to name cache directories.

### `SessionManager`

The manager holds:

- `_sessions`: map from session id to session object.
- `segmentCache`: cache instance used to derive HLS paths.

### `getBySessionId(id)`

Returns the exact session object for an id.

### `getByInfoHash(infoHash)`

Scans active sessions and returns one whose `infoHash` matches and whose state is not `error` or `stopped`.

This is why a second viewer starting the same magnet joins the existing stream instead of creating another WebTorrent client and FFmpeg process.

### `all()`

Returns an array copy of active sessions.

Used by health checks and shutdown cleanup.

### `create(magnetUri)`

Allocates a new session object but does not start the torrent or FFmpeg pipeline.

Important session fields:

- `sessionId`: generated from current time plus random bytes.
- `infoHash`: parsed from magnet.
- `magnetUri`: original magnet.
- `hlsPath`: cache directory for this torrent.
- `state`: starts as `initializing`.
- `mode`: later becomes `remux` or `transcode`.
- `codecInfo`: filled after ffprobe.
- `videoFile`: WebTorrent file object chosen as the movie.
- `internalUrl`: local HTTP URL that FFmpeg reads from.
- `videoTimescale`: defaults to 90000, then updates from `init.mp4`.
- `mimeType`: browser MSE type string.
- `torrentManager`: set by pipeline startup.
- `generator`: main FFmpeg HLS generator.
- `seekWorkerMgr`: seek worker manager.
- `timeline`: `SegmentTimelineRegistry` persisted at `hlsPath + "/timeline.json"`.
- `viewers`: active viewer count.
- `viewerTimes`: map from viewer id to playback position.
- `mainLastTime`: main encoder's latest reported position.
- `_seekEpoch`: incremented per seek request.
- `_mainPaused`: true when the main FFmpeg process has been `SIGSTOP`ed to free bandwidth for a large seek.
- `_priorityInterval`: timer for viewer-aware torrent piece prioritization.
- `_idleTimer`: timer used after the last viewer leaves.
- `_stopWatcher`: cleanup function for HLS directory watchers.
- `events`: session-level `EventEmitter`.

The timeline is loaded immediately so cached sessions can recover segment mappings.

### `touch(sessionId)`

Updates `lastAccessed` for the session. Routes call this when a viewer interacts with the stream.

### `addViewer(sessionId)`

Cancels any idle cleanup timer, increments the viewer count, creates a random viewer id, records the viewer at playback time `0`, touches the segment cache, and returns the viewer id.

### `removeViewer(sessionId, viewerId)`

Deletes the viewer's playback time, decrements the viewer count, and starts a two-minute idle timer if no viewers remain.

The actual HLS files are not deleted when a session is destroyed. They stay in the segment cache.

### `updateViewerTime(sessionId, viewerId, currentTime)`

Updates the viewer's current playback position. The torrent prioritization loop uses these positions to prioritize pieces ahead of viewers.

### `_destroy(sessionId)`

Stops and removes a session after it goes idle.

Cleanup order matters:

1. Mark state as `stopped`.
2. Clear piece-priority interval.
3. Stop HLS directory watcher.
4. Kill seek workers.
5. Resume main FFmpeg if it was paused, because a stopped process may not handle SIGTERM until resumed.
6. Stop main FFmpeg.
7. Stop WebTorrent after a small delay.
8. Remove the session from the registry.
9. Trigger cache eviction.

## `backend/core/timeline.js`

This file contains the most important backend data structure: `SegmentTimelineRegistry`.

The registry maps media time to segment files. The rest of the backend uses it to decide:

- which segment covers a seek target
- which segment extends the current buffer
- whether a segment file is ready
- what to replay to clients
- how to recover from cached output

### `SegmentTimelineRegistry`

The class stores:

- `_segments`: sorted array of segment entries.
- `_clusters`: sorted array of MKV cluster entries.
- `_persistPath`: optional JSON file path.
- `_waiters`: async waiters for future segment availability.
- `_persistTimer`: debounce timer for disk writes.

### Segment Entry Shape

A segment entry typically contains:

- `file`: actual filename on disk.
- `segmentId`: id used by clients; defaults to `file`.
- `startTime`: media start time in seconds.
- `endTime`: media end time in seconds.
- `duration`: end minus start.
- `source`: `main`, `seek`, `cache`, or similar.
- `byteOffset`: approximate source file byte offset.
- `clusterOffset`: known MKV cluster offset when available.
- `decodeStartTime`: safe decode start time used by seek workers.
- `createdAt`: wall-clock timestamp.

### `register(...)`

Adds or updates one segment.

If a file already exists with nearly identical timing, the call is idempotent. It only merges metadata and persists.

If a file already exists but timing changed, the entry is updated and the array is re-sorted.

If it is a new file, the method inserts it into `_segments` at the correct sorted position.

After any new or changed timing, `_resolveWaiters()` checks pending `waitForTime`, `waitForNextAfter`, and `waitForFile` promises.

### `_mergeSegmentMetadata(entry, metadata)`

Merges optional byte/cluster/decode metadata into an entry.

If a `clusterOffset` is provided, the method also records that cluster in `_clusters`. This is valuable because future seeks can reuse known cluster locations instead of rescanning the torrent.

### `bulkRegister(entries)`

Registers many entries at once without per-entry sorted insertion. It appends missing files, normalizes them, sorts once, and persists once.

This is used when bootstrapping from a cached playlist.

### `recordCluster(...)`

Records a media-time-to-MKV-cluster mapping.

Clusters are separate from HLS segments. A cluster is a safe decode input boundary in the original file; a segment is output from FFmpeg.

If a cluster already exists within 250 ms, the method merges it and prefers higher-confidence sources:

- `cues`
- `seek`
- `scan`
- other

### Lookup Methods

`findSegmentForTime(time)` performs binary search and returns a segment where:

```text
startTime <= time < endTime
```

`findSeekTargetSegment(time)` currently delegates to `findSegmentForTime`. It exists as a named seam for future seek-specific logic.

`findNextForBuffer(bufferedEnd, maxGapSec)` finds a segment that extends the current buffer. It first looks for overlap/continuation, then for a nearby future segment within a gap tolerance.

`findByFile(file)` returns a segment by filename.

`findNextAfter(startTime)` returns the first segment whose start time is strictly greater than the provided time.

`findNearestSegment(time)` returns the segment with the nearest start time.

`findClusterBefore(time, minPrerollSec)` returns the latest cluster at or before `time - minPrerollSec`.

`findSegmentsInRange(startTime, endTime)` returns all segments overlapping a time range.

`hasTime(time)`, `latestTime()`, `getAll()`, `getClusters()`, `count()`, and `clusterCount()` are convenience reads.

### Async Waiting

`waitForTime(time, timeoutMs)` resolves immediately if a segment already covers `time`; otherwise it waits until registration creates one.

`waitForNextAfter(bufferedEnd, timeoutMs)` waits for a segment that extends a buffer.

`waitForFile(file, timeoutMs)` waits for a specific file to appear in the timeline.

These methods are why the stream route can block segment requests until FFmpeg or a seek worker produces the file.

### Persistence

`load()` reads either the older array format or the newer object format:

```json
{
  "version": 2,
  "segments": [],
  "clusters": []
}
```

`_persist()` debounces writes by one second. The debounce avoids writing the timeline file for every single segment during rapid FFmpeg output.

### `ClusterIndex`

`ClusterIndex` is a smaller in-memory index for media time to MKV cluster byte offset.

It records entries sorted by start time and supports `findBefore()`. The current codebase mainly uses the cluster support inside `SegmentTimelineRegistry`, but `ClusterIndex` documents and provides the same concept as a standalone helper.

### `toSegmentPayload(entry)`

Normalizes an internal timeline entry into the wire format used by SSE and HTTP responses.

It strips the object down to fields the browser needs:

- segment id
- file
- start/end/duration
- byte and cluster offsets
- decode start time

Routes add ownership metadata such as generation and worker id on top of this payload.

## `backend/provider/evicting-store.js`

This file implements a custom WebTorrent chunk store that keeps RAM bounded.

WebTorrent normally stores downloaded pieces in memory using a chunk store. For large videos and multiple viewers, keeping every downloaded piece in RAM is not acceptable. This store keeps a sliding window and evicts old pieces once FFmpeg has consumed them.

### `EvictingMemoryStore`

Constructor fields:

- `chunkLength`: torrent piece size.
- `length`: total byte length.
- `chunks`: map from chunk index to `Buffer`.
- `_evictBefore`: chunk index before which chunks can be evicted.
- `HEADER_PRESERVE_CHUNKS`: number of early chunks to keep forever.

The header preservation matters because FFmpeg and seek workers may need the container header repeatedly, especially for MKV.

### `get(index, cb)`

Returns a stored chunk or errors with `chunk not found`.

The error is intentional. WebTorrent's read path can respond by downloading/retrying missing pieces.

### `put(index, buf, cb)`

Stores a copy of the chunk, runs lazy eviction, and calls back.

Copying through `Buffer.from(buf)` avoids holding onto mutable external buffers.

### `hasByte(byteOffset)`

Returns whether the chunk containing a given byte offset is currently in memory.

Seek piece gates use this because a piece can be verified by WebTorrent but already evicted from the custom store.

### `evictBefore(byteOffset)`

Moves the eviction frontier forward and evicts old chunks.

The byte offset is absolute in torrent-piece coordinates, not necessarily video-file-relative coordinates.

### `_evict()`

Deletes any chunk whose index is lower than `_evictBefore`, except for pinned header chunks.

Eviction is lazy. There is no background timer.

### `ramBytes()`

Sums buffer lengths currently held in the map.

### `close()` and `destroy()`

Clear all stored chunks and call the optional callback.

### `makeStoreClass(onCapture)`

WebTorrent expects a store class constructor, not an already-created instance. This factory creates a subclass that calls `onCapture(this)` in its constructor so `TorrentManager` can keep a reference to the store instance.

## `backend/provider/webtorrent.js`

This file is the torrent acquisition layer. It downloads the selected video file, serves it over a private local HTTP server, prioritizes pieces for playback/seeking, and contains MKV cluster/Cues helpers for safer seeking.

### High-Level Role

The rest of the backend does not read from WebTorrent directly. FFmpeg reads from `TorrentManager`'s internal HTTP server. That server translates HTTP range requests or seek-worker `?start=` URLs into `videoFile.createReadStream()` calls.

This design isolates FFmpeg from torrent-specific APIs.

### Constants

`VIDEO_EXT` defines recognized video extensions:

- `.mkv`
- `.mp4`
- `.avi`
- `.mov`
- `.webm`
- `.m4v`

`EVICTION_SAFETY_BYTES` keeps 40 MB behind the FFmpeg cursor before evicting.

### EBML Helpers

The file includes low-level Matroska/EBML helpers:

- `_readVint(buf, pos)` reads EBML variable-length integers.
- `_ebmlIdLen(b)` returns the length of an EBML element id.
- `_readUintBE(buf, pos, len)` reads a big-endian unsigned integer.

These helpers are used for MKV Cluster and Cues parsing.

### `TorrentManager`

Fields:

- `client`: WebTorrent client.
- `torrent`: active torrent object.
- `videoFile`: selected video file object.
- `store`: captured `EvictingMemoryStore`.
- `internalPort`: random local HTTP port.
- `internalUrl`: URL FFmpeg reads from.
- `_server`: Node HTTP server.
- `_bufferReady`: whether initial pieces are ready.
- `_firstClusterOffset`: cached first MKV cluster offset.
- `_firstClusterOffsetPromise`: in-flight first-cluster scan.
- `_clusterCache`: cache of seek-byte cluster scans.
- `_cuesTable`: cached MKV Cues table, `undefined` before load, `null` if absent.

The class extends `EventEmitter` and emits progress, done, error, and server trace events.

### `start(magnetUri)`

Creates a WebTorrent client entry with the custom store. It resolves once enough pieces are available for FFmpeg startup.

Steps:

1. Create a captured store class.
2. Add the magnet to WebTorrent.
3. Pick the largest video file.
4. Deselect all files, then select only the video file.
5. Pin the first 40 MB worth of chunks in the store.
6. Mark the first 40 MB worth of torrent pieces as critical.
7. Start the private internal HTTP server.
8. Wire torrent progress events.

If no video file is found, the promise rejects.

### `_pickVideoFile(files)`

Filters torrent files by video extension and returns the largest. This is a practical heuristic for torrents that contain samples, extras, subtitles, or multiple files.

### `_startInternalServer(torrent, resolve, reject)`

Creates the local HTTP server that FFmpeg reads from.

It listens on `127.0.0.1` with port `0`, meaning the operating system assigns a free port. This avoids conflicts when multiple sessions are active.

The server supports three major request shapes:

1. Normal full-file request.
2. HTTP `Range` request.
3. Seek-worker `?start=<byte>&seekTime=<ms>` request.

Range requests respond with status `206` and stream the requested byte range.

Seek-worker requests are special. FFmpeg needs a valid container header, but a seek worker should begin near a target byte. For MKV, the server may concatenate:

- the file header from byte `0` to the first cluster
- cluster data starting at the discovered seek cluster

This produces a stream FFmpeg can parse even though it begins media data mid-file.

### `_serveConcat(res, sources, onChunk)`

Writes multiple readable streams into one HTTP response without calling `pipe()` repeatedly into the same response. This avoids "write after end" problems and allows diagnostics while streaming.

### `_waitForBuffer(torrent, resolve)`

Waits until enough pieces are available before resolving `start()`.

The code checks `torrent.pieces` and resolves when the computed pending count meets `MIN_PIECES` or the torrent is done. The variable names are somewhat confusing: `pending` is derived from `torrent.pieces.filter(Boolean).length`, while `verified` is total minus pending. The intent is to avoid handing FFmpeg an empty stream before WebTorrent has started receiving data.

### `_wireProgressEvents(torrent)`

Emits progress every five seconds and clears the interval when the torrent completes or errors.

### `evictBefore(byteOffset)`

Moves the evicting store frontier forward, keeping a 40 MB safety margin.

### `prioritizeRange(startByte, endByte)`

Converts video-file-relative byte offsets to torrent piece indices, then marks those pieces critical in WebTorrent.

This is used for:

- startup/header prioritization
- viewer-ahead rebalancing
- seek target prioritization
- rolling seek-worker prefetch

### `seekGateMs(count, mode)`

Computes an adaptive timeout for waiting on seek pieces.

The timeout considers:

- current download speed
- piece length
- peer count
- whether the mode is `remux` or `transcode`

Remux uses shorter bounds because once pieces arrive the worker can generate output quickly.

### `waitForPiecesAdaptive(seekByte, count, mode)`

Waits until enough pieces near a seek byte are both verified and present in the custom store.

It listens to WebTorrent `download` events for low latency and also runs a 500 ms fallback loop. It has:

- adaptive soft timeout from `seekGateMs`
- hard max of 30 seconds
- diagnostic traces

This avoids launching FFmpeg against a byte range that WebTorrent already verified but evicted from memory.

### `waitForPiecesAt(seekByte, count, timeoutMs)`

Older retry-oriented piece wait helper with a fixed timeout.

### `seekDiagnostics(fileByte, count)`

Reports detailed state around a seek byte:

- file byte and absolute torrent byte
- start/end piece indices
- verified piece count
- in-store piece count
- whether the torrent would pass the gate
- whether the store is actually ready
- mismatch state
- eviction frontier
- RAM MB
- peers and speed
- first few piece statuses

This is central to debugging stalls.

### `prefetchClusterAt(seekByte, expectedTimeMs)`

Starts `_findClusterAt()` and caches the promise. Seek workers call this early so the internal HTTP server can reuse the scan result when FFmpeg connects.

The cache key includes both byte and expected time because time-aware validation changes which cluster candidates are accepted.

### `safeDecodePointForTime(seekTimeSec, options)`

Finds a safe decode point for a requested media time.

Strategy:

1. If an existing timeline cluster is provided, use it.
2. Try MKV Cues. Cues map media time to cluster bytes and are high quality.
3. If duration and file length are known, estimate byte positions for several preroll times and scan for clusters.
4. Fall back to byte `0`.

The returned object includes requested time, actual decode start time, byte offset, cluster offset, and source.

### `seekByteForTime(seekTimeSec, hintByte)`

Returns a best file byte for a seek time.

It first tries Cues, then bitrate interpolation based on cluster timestamps, then falls back to the original hint byte.

### `_loadCues()`

Reads the first 2 MB of the MKV and tries to parse the Cues element.

The result is a sorted array of:

```js
{ timeMs, clusterByte }
```

If no Cues are available or parsing fails, it caches `null`.

### `_findFirstClusterOffset()`

Scans the start of the MKV for the first Cluster element id (`0x1F43B675`).

This identifies where the header/metadata area ends.

### `_findClusterAt(seekByte, expectedTimeMs)`

Scans up to 4 MB forward from a byte estimate for a real MKV Cluster boundary.

It validates candidates by parsing the cluster VINT and looking for a Timecode element. If `expectedTimeMs` is provided, it rejects candidates whose timecode is far outside the expected range. This avoids false positives inside compressed video payload bytes.

### `_readClusterTimestampMs(clusterByte)`

Reads a small range from a known cluster byte and extracts its Timecode element.

### `getStats()`

Returns torrent and store statistics for `/torrent/status`.

### `stop()`

Closes the internal HTTP server and destroys the WebTorrent torrent.

## `backend/pipeline/codec.js`

This file decides whether the source can be remuxed or must be transcoded.

Remux means FFmpeg copies the encoded video/audio streams into fMP4 without decoding and re-encoding. Transcode means FFmpeg decodes and encodes to browser-compatible codecs.

### Codec Sets

`REMUX_VIDEO` contains `h264`.

`REMUX_AUDIO` contains:

- `aac`
- `mp3`

The browser output is fMP4. H.264 video and AAC/MP3 audio can usually be copied. Other codecs require transcoding.

### `detectCodecs(sourceUrl, filename)`

Builds and runs an `ffprobe` command.

The filename extension gives FFmpeg a format hint:

- `mkv` -> `matroska`
- `mp4` -> `mp4`
- `avi` -> `avi`
- `mov` -> `mov`
- `webm` -> `webm`
- `m4v` -> `mp4`

The command asks ffprobe for JSON streams and format data.

If ffprobe fails, the function returns conservative fallback info requiring transcode.

After parsing:

- It finds the first video stream.
- It finds the first audio stream.
- It extracts codec names.
- It checks pixel format. For H.264 in Chrome MSE, the code requires `yuv420p`.
- It marks video transcode if video is not H.264 or not 8-bit 4:2:0.
- It marks audio transcode if audio exists and is not AAC or MP3.
- It sets mode to `remux` only if neither video nor audio needs transcoding.

Duration is read from stream or format metadata. If missing, it estimates duration from `size * 8 / bit_rate`.

The returned `mimeType` is an MSE type string.

### `fallbackCodecInfo()`

Returns a safe transcode-required result with unknown codecs and no duration.

## `backend/pipeline/fmp4.js`

This file is a minimal ISO BMFF/fMP4 parser and editor. It reads timing boxes from `init.mp4` and `.m4s` fragments, and it can rewrite TFDT values in-place.

The backend uses these functions to put generated segments into the correct media-time positions.

### Low-Level Box Helpers

- `ru32(buf, o)`: read unsigned 32-bit big-endian.
- `ru64(buf, o)`: read unsigned 64-bit big-endian as a JavaScript number.
- `wu32(buf, o, value)`: write unsigned 32-bit big-endian.
- `wu64(buf, o, value)`: write unsigned 64-bit big-endian using `BigInt`.
- `rtype(buf, o)`: read a four-character MP4 box type.
- `findBox(buf, type, start, len)`: find first child box of a type.
- `findBoxes(buf, type, start, len)`: find all child boxes of a type.

The parser is intentionally small and only understands boxes needed by this project.

### `readTfdt(buf)`

Walks:

```text
moof -> traf -> tfdt
```

It returns `baseMediaDecodeTime` in raw timescale ticks.

TFDT is the key value used to determine when a media fragment starts.

### `rewriteTrackTfdt(filePath, opts)`

Rewrites one track's TFDT in a media fragment.

Inputs:

- `trackId`
- `tfdtRaw`

It scans every `moof`, then every `traf`, finds `tfhd` to identify the track id, finds `tfdt`, and writes the new base media decode time.

It supports version 0 and version 1 TFDT boxes. Version 0 can only store 32-bit values, so the function rejects overflow.

The return object explains whether the rewrite succeeded and includes old/new values.

Seek-worker TFDT normalization uses this to correct audio drift when enabled.

### `parseTrunInfo(payload)`

Parses a `trun` box payload and computes:

- sample count
- total sample duration
- whether per-sample durations were present

It respects optional fields indicated by TRUN flags.

### `readTrunDuration(buf)`

Walks:

```text
moof -> traf -> trun
```

It returns the total video sample duration in raw ticks.

### `readVideoTimescale(buf)`

Walks an init segment:

```text
moov -> trak -> mdia -> hdlr/mdhd
```

It finds the track whose handler is `vide`, then returns the `mdhd` timescale.

The default timescale assumption is 90000, but this function lets the backend use the real value.

### `readSegmentTiming(filePath, timescale)`

Reads only the first 8192 bytes of a media segment, extracts:

- TFDT
- start time
- TRUN duration
- duration in seconds
- end time

It avoids reading full segment files because the timing boxes live near the start, before the large `mdat` payload.

If TRUN duration is missing, it defaults to 2 seconds.

### `readFragmentTracks(filePath, opts)`

Reads video and audio timing from a media fragment.

It parses:

- track id from `tfhd`
- TFDT from `tfdt`
- default sample duration from `tfhd`
- sample count and per-sample fields from `trun`
- first/last PTS using composition time offsets

It assumes track 1 is video and track 2 is audio when the track id is present. If ids are absent, it assigns the first track to video and the next to audio.

It converts raw ticks using:

- video timescale, default 90000
- audio timescale, default 48000

It returns:

- `video` timing object or null
- `audio` timing object or null
- `deltaMs`, audio start minus video start

This is heavily used by seek diagnostics and TFDT normalization.

### `readAudioTimescale(buf)`

Similar to `readVideoTimescale`, but finds handler `soun`.

### `readInitTimescale(filePath)`

Reads `init.mp4` and returns the video timescale.

### `readInitTracksTimescale(filePath)`

Reads both video and audio timescales from an init segment.

### `readInitTrackInfo(filePath)`

Returns video/audio track ids, timescales, and sample-entry codec names from an init segment.

Seek diagnostics use this to verify track ids and timescale assumptions.

## `backend/pipeline/ffmpeg.js`

This file wraps FFmpeg process creation through `fluent-ffmpeg`.

It is used for:

- the main sequential HLS pipeline
- temporary seek-worker HLS pipelines

### Constants

`HLS_TIME` is 2 seconds. This is the default target duration for HLS segments.

`cpuThreads` uses half the logical CPU cores, capped at 4 and floored at 2.

### `HlsGenerator`

The class extends `EventEmitter`.

Fields:

- `label`: human-readable process label, such as the session id or seek job id.
- `process`: fluent-ffmpeg command object.
- `running`: whether the process is active.
- `_lastTime`: latest parsed FFmpeg progress time in seconds.

### `start(...)`

Starts FFmpeg and resolves when FFmpeg exits cleanly. It rejects on unexpected errors.

Parameters:

- `sourceUrl`: internal torrent HTTP URL.
- `videoName`: original filename for format hinting.
- `outputDir`: HLS output directory.
- `codecInfo`: result from `detectCodecs()`.
- `seekOffset`: non-zero for seek workers.
- `isSeekWorker`: changes init filename and input behavior.
- `seekByte`: byte offset for seek-worker `?start=`.
- `hlsTime`: target segment duration.
- `diagMode`: optional diagnostic timestamp mode.

### Input Options

The command enables reconnect behavior and sets `rw_timeout`.

Seek workers get shorter analyze/probe settings because they need to produce output quickly from a small mid-file stream.

For seek workers with a byte offset, the code adds `-seekable 0` and appends `?start=<byte>&seekTime=<ms>` to the URL. This prevents FFmpeg from doing its own MKV binary seeking through Range requests, which would stall on unavailable torrent pieces.

For normal startup, the input is also marked non-seekable so FFmpeg reads forward.

### Video Codec Choice

If video does not need transcoding, the command uses:

```text
-c:v copy
```

Otherwise it uses:

- `libx264`
- `veryfast` preset, or `ultrafast` for diagnostic forced-transcode mode
- CRF 23
- `yuv420p`
- no B-frames
- forced keyframes every HLS segment
- scene-cut threshold disabled

These settings aim for browser compatibility and predictable segment boundaries.

### Audio Codec Choice

If there is no audio, FFmpeg disables audio.

If audio can be copied, it uses copy mode.

Otherwise it transcodes to AAC:

- 48 kHz
- stereo
- 192 kbps

### Seek Timestamp Handling

For seek workers that transcode video, the command resets timestamps with `setpts=PTS-STARTPTS`, optionally does the same for audio, then uses `-output_ts_offset <seekOffset>`.

For remux seek workers, the code avoids `setpts` and avoids `-output_ts_offset`, because source timestamps are already near the keyframe's real media time. Adding the offset again would double-shift the timeline.

### HLS Output Options

The command outputs:

- format `hls`
- all segments retained in playlist (`-hls_list_size 0`)
- independent segment flags
- fMP4 segment type
- `init.mp4` for main pipeline
- `seek_init.mp4` for seek workers
- `segment_%05d.m4s` files
- `master.m3u8`

### Events Emitted

- `start`: FFmpeg command line.
- `stderr`: every stderr line.
- `ffmpeg-time`: parsed progress time.
- `segment-open`: when FFmpeg logs that it is opening a segment file.
- `end`: clean completion.
- `error`: unexpected failure.

The segment-open event is important because FFmpeg opens segment N immediately after segment N-1 closes. Watchers use that event to process the previous segment promptly.

### `stop()`, `pause()`, `resume()`

`stop()` sends `SIGTERM`.

`pause()` sends `SIGSTOP`.

`resume()` sends `SIGCONT`.

Large seeks pause the main encoder so torrent bandwidth can focus on the seek worker.

## `backend/pipeline/seek.js`

This is the most complex backend file. It manages temporary FFmpeg workers that generate segments near a seek target before the main encoder reaches that point.

### Why Seek Workers Exist

The main FFmpeg process reads the torrent sequentially. If a viewer jumps from 2 minutes to 90 minutes, waiting for the main process to encode the whole gap would be too slow.

A seek worker starts a separate FFmpeg process at a safe decode point near the target and writes temporary HLS output. Completed seek segments are renamed by their actual media time, copied into the main HLS directory, registered in the timeline, and emitted to clients.

### Constants

- `WORKER_WINDOW_SEC = 60`: workers expire after the main encoder passes their target by this much.
- `MAX_SEEK_WORKERS = 2`: declared as max worker count, although current `startWorker()` kills existing workers before starting a new one, so only one active generation normally remains.
- `POLL_MS = 100`: fallback directory poll interval.
- `MAX_RETRIES = 2`: total attempts are 3 because the loop runs from 0 to 2.
- `RETRY_DELAY_MS = 3000`.
- `MAX_SEEK_PREROLL_SECONDS = 120`: rejects decode points too far before the target.
- `ENABLE_TFDT_NORMALIZATION`: environment-controlled audio TFDT correction.
- `TFDT_NORMALIZATION_THRESHOLD_MS = 500`: drift threshold before normalization applies.

### `SeekWorkerManager`

Fields:

- `session`: the owning session.
- `_workers`: map from job id to worker state.
- `_jobCounter`: incrementing id suffix.
- `_seekGeneration`: incremented on every new seek.

The generation is essential. It prevents an older worker from promoting stale segments after a newer seek supersedes it.

### `startWorker(seekTime, decodePoint, diagnostics)`

Starts a new seek worker.

Major steps:

1. Increment generation before awaits.
2. Kill all existing workers.
3. If a newer seek arrived during cleanup, return without starting.
4. Create a job id and seek scratch directory.
5. Normalize the decode point into `safePoint`.
6. Reject dangerous starts at byte 0 for far seeks.
7. Store session `_activeSeek`.
8. Record known cluster metadata in the timeline.
9. Prioritize torrent pieces around the seek byte.
10. Create an `HlsGenerator`.
11. Create a worker state object with many diagnostic fields.
12. Start watching the seek directory.
13. Run `_runWorker(worker)` in the background.
14. Return approximate first segment range to the route.

### Worker State

The worker object stores:

- identity: job id, generation, seek epoch
- target: requested seek time
- input: seek byte, seek offset, safe decode point
- output: seek directory, generated segment count
- process: `HlsGenerator`
- state: running/done/error/stopped
- cleanup handles
- counters for seen/parsed/promoted/timeline-inserted segments
- root-cause diagnostic state
- A/V drift diagnostics
- command audit
- stderr tail
- milestone timestamps

Much of the file is diagnostic instrumentation, because seek bugs are usually timing, muxing, or race-condition bugs.

### `_runWorker(worker)`

Owns the background lifecycle.

Flow:

1. Start cluster prefetch.
2. Wait for pieces near the seek byte.
3. Start FFmpeg.
4. Listen to stderr, progress, segment-open, start, and end.
5. If no segments are promoted, treat it as a failure.
6. Retry after cleaning the seek directory.
7. On success, mark done and clean up.
8. On final failure, mark error and clean up.

During progress events, it advances the torrent eviction frontier and prioritizes pieces ahead of the seek worker's current position.

### `killWorker(jobId)`

Marks the worker stopped, stops polling, terminates FFmpeg, cleans up the worker directory, and emits diagnostics.

### `cleanupExpired(mainTime)`

Called from the main FFmpeg progress handler. If the main encoder has passed a worker's seek time by more than `WORKER_WINDOW_SEC`, the worker is no longer needed and is killed.

### `getWorkerStats()`

Returns small status objects for `/torrent/status`.

### `_watchDir(worker)`

Watches a worker's temporary HLS directory.

It uses three mechanisms:

1. Initial scan for existing complete files.
2. FFmpeg `segment-open` events to know when the previous segment closed.
3. 100 ms polling fallback for missed events.

It deliberately avoids processing the currently open segment because FFmpeg may still be writing it.

### `_processSegment(worker, segPath, timescale)`

Processes one completed seek-worker segment.

This is the core promotion path:

1. Read seek init track timescales and track info once.
2. Retry reading segment TFDT timing because the file may still be settling.
3. Parse video/audio fragment timing.
4. Optionally normalize audio TFDT drift.
5. Resolve whether fragment timestamps are relative or already absolute.
6. Compute absolute media start/end.
7. Reject invalid timing.
8. Decide whether the segment is preroll, target-covering, or after-target.
9. Reject segments too far before the target.
10. Build destination name as `segment_t<absoluteStartMs>.m4s`.
11. Copy `seek_init.mp4` to the main HLS directory if needed.
12. Copy the media segment to the main HLS directory and remove the temp file.
13. Register the segment in the timeline.
14. Record generation ownership.
15. Emit `segment:ready` to the session event bus.
16. Emit extensive diagnostics.

The destination name is based on actual parsed timing, not the original worker segment counter. This lets the browser request by media time and lets the timeline remain correct even if FFmpeg starts slightly earlier or later than predicted.

### `_maybeNormalizeTfdt(...)`

Detects large video/audio TFDT drift and optionally rewrites the audio track TFDT to align with video.

It skips normalization when:

- disabled by environment
- segment is `segment_00000.m4s`
- either track is missing
- timescales are invalid
- drift is below threshold

When it applies, it rewrites the audio track's TFDT box, reparses the fragment, records metrics, and emits validation traces.

### A/V Diagnostic Methods

The file contains many helpers for diagnosing seek audio/video drift:

- `_recordTfdtNormalizationMetric`
- `_recordFirstFiveDriftDiagnostics`
- `_emitFirstFiveFinalReport`
- `_recordSeekAvRootCauseSegment`
- `_maybeEmitSeekAvRootCauseReport`
- `_runSegment0Ffprobe`
- `_probeSegmentStreams`
- `_probeSegment`
- `_remuxToTs`
- `_traceAvDurationInternal`
- `_probeAvDuration`
- `_runAvDurationFfprobe`
- `_runDiagProbes`

These methods compare internal parser output, ffprobe output, fMP4 timing, MPEG-TS remux timing, sample durations, boundary gaps, and track starts. The goal is to classify whether drift comes from FFmpeg generation, fMP4 muxing, timeline rebasing, parser assumptions, or segment continuity.

### `_cleanupWorker(jobId)`

Removes a worker from the map, resumes the main encoder if this was the last naturally finished worker and the main was paused, clears active seek state, and removes the temporary seek directory.

### `_resolveSeekFragmentClock(worker, timing)`

Determines whether a fragment's TFDT clock is relative to the worker start or already absolute in the movie timeline.

It computes both interpretations:

- relative: `absolute = seekOffset + fragmentTime`
- absolute: `absolute = fragmentTime`

It chooses the interpretation that covers the requested target when only one does. Otherwise it uses heuristics to avoid double-adding seek offset when FFmpeg preserved source timestamps.

### `_fragmentTimeToTimeline(clock, fragmentTime)`

Applies the chosen clock basis.

### `_buildFfmpegCommandAudit(...)`

Builds a structured summary of the FFmpeg command and codec choices for diagnostics.

### `_buildTrackTimelineDiagnostics(...)`

Builds raw and absolute timing diagnostics for video/audio tracks.

### `_overlapsTarget(timing, targetTime)`

Returns true when a segment covers the target:

```text
startTime <= targetTime < endTime
```

## `backend/routes/stream.js`

This route module serves HLS files and media segments to the browser.

It is intentionally timeline-aware. A request for a segment may wait until FFmpeg or a seek worker produces that segment.

### Constants

`SEGMENT_RE` accepts:

- `segment_00000.m4s` style main segments
- `segment_t118000.m4s` style seek segments
- `segment_t118000_1.m4s` style variants, if used

`SEG_WAIT_MS` is 120 seconds.

### Routes

#### `GET /stream/:sessionId/by-id/:segmentId`

Serves a segment by id.

It rejects path traversal and invalid segment names, gets the session, touches it, then calls `_serveSegment()`.

This is the primary segment endpoint used by `test.html`.

#### `GET /stream/:sessionId/:filename`

Serves either:

- segment files, through `_serveSegment()`
- static HLS files such as `init.mp4` and `master.m3u8`, through `_serveStatic()`

It rejects path traversal and absolute paths.

#### `GET /stream/:sessionId`

Redirects to the session playlist.

### `_serveSegment(reply, session, segmentId)`

Segment serving strategy:

1. If the requested file exists directly, send it.
2. If it is a seek artifact, try resolving it to a nearby actual timeline file.
3. If it is a seek artifact with predicted time, wait for any segment covering that time.
4. Otherwise wait for the exact file to be registered.
5. If a timeline entry appears but the file is not on disk yet, wait briefly for disk.
6. Return 404 on timeout.

This makes segment requests naturally block while the backend catches up.

### `_serveStatic(reply, filePath, filename)`

Waits up to 60 seconds for `init.mp4` and 30 seconds for other static files, then sends them.

### `_sendFile(reply, filePath, filename)`

Sets content type, content length, no-cache, CORS, and streams the file.

### `_resolveSegmentId(session, segmentId)`

Maps a requested segment id to an actual file.

For main segments, it checks by file.

For seek artifact names like `segment_t118000.m4s`, it parses time `118.0`, finds a covering or nearest segment, and accepts it if the start time is within 2 seconds.

### `_waitForFileDisk(filePath, timeoutMs)`

Polls disk every 200 ms until the file exists or the timeout passes.

It always resolves; callers check existence afterward.

## `backend/routes/torrent.js`

This file owns the public torrent lifecycle API, the main pipeline startup, seek routing, SSE event feeds, status polling, and helper logic that glues sessions to torrent/FFmpeg/timeline components.

### Route-Level Constants

- `MIN_SEGMENTS = 1`: first segment threshold before stream readiness.
- `FIRST_SEG_TIMEOUT_MS = 120000`: wait for first segment.
- `SEEK_PROMOTE_THRESHOLD_S = 30`: pause main encoder when seeking far ahead.
- `DebugLevel`: off, normal, verbose.
- `SSE_BATCH_MS = 500`: batch trace events every 500 ms.
- `MAX_TRACE_QUEUE = 5000`: prevents unbounded verbose queue growth.

### SSE Helpers

`_debugLevelFromReq(req)` parses `debugLevel`.

`_traceLevel(phase)` decides which traces are normal vs verbose. Errors and important lifecycle events are normal; noisy progress and filesystem updates are verbose.

`_createSseWriter(reply, debugLevel)` creates:

- `sendRaw(event, data)` for immediate event writes.
- `sendBatched(event, data)` for trace batching.
- `close()` to flush and clear timers.

Batched SSE events reduce browser event overhead during verbose diagnostics.

### Ownership Helpers

`_segmentOwner(session, entryOrFile)` combines timeline data and session `_generationOwnership` to identify:

- generation
- worker id
- seek epoch
- source
- creation time

`_ownedSegmentPayload(session, entry)` wraps `toSegmentPayload()` and adds ownership fields.

This is important because seek workers can be superseded. The frontend uses ownership metadata to reject stale segments.

### `POST /torrent/start`

Validates the magnet, extracts info hash, and either joins an existing session or creates a new one.

If a session already exists for the info hash:

- returns `status: "joining"`
- returns the existing session id
- returns an events URL

If not:

- creates a new session
- starts `_startPipeline()` asynchronously
- returns `status: "starting"`

Pipeline errors put the session into `error` and emit an SSE error.

### `GET /torrent/events/:sessionId`

Startup SSE endpoint.

If the session is already streaming, it immediately adds the viewer and sends `stream:ready`.

If the session failed, it sends `error`.

Otherwise it forwards:

- progress events
- server trace events
- stream-ready event
- error event

When `stream:ready` fires, it adds a viewer and includes the viewer id.

### `GET /torrent/feed/:sessionId`

Persistent playback SSE endpoint.

On connect, it replays only the first 60 seconds of segments to avoid flooding the browser. The browser uses `/torrent/timeline` and `/torrent/covering` for everything else.

It also sends duration immediately if known.

Then it forwards:

- `segment:ready`
- `duration:ready`
- batched server traces

### `GET /torrent/status`

Returns session and torrent stats:

- state and mode
- downloaded bytes, total, speed, peer count, progress
- HLS segment count on disk
- memory usage
- duration
- main FFmpeg position
- timeline count
- cluster count
- seek worker stats
- piece stats
- custom store RAM bytes
- viewer count

If `viewerId` and `currentTime` are provided, it updates the viewer playback position for piece prioritization.

### `GET /torrent/timeline`

Returns timeline entries in a time window.

Query parameters:

- `sessionId`
- `after`, default 0
- `window`, default 120

It includes a 2-second overlap before `after` so the client does not miss a segment that starts just before the requested position.

### `GET /torrent/covering`

Long-poll endpoint for segment discovery.

It can wait for:

- a segment covering a specific `time`
- a segment extending after a `bufferedEnd` value

If a time request misses and no active worker is serving that target, it may respawn a seek worker after a cooldown.

This endpoint is the browser's fallback when SSE or timeline bootstrap does not yet contain the needed segment.

### `POST /torrent/seek`

Handles seek requests from the browser.

Input:

- `sessionId`
- `seekTime`
- `currentPlaybackTime`
- optional client seek epoch

Flow:

1. Validate request.
2. Increment session seek epoch.
3. If the timeline already has an on-disk segment covering the target, return `action: "cached"`.
4. If the main encoder is close enough and running, return `action: "waiting"`.
5. Resolve a safe decode point.
6. For large seeks, pause the main encoder to prioritize seek bandwidth.
7. Start a seek worker.
8. Return `action: "started"` with approximate start/end.

If no decode point is found, the route returns a waiting response with a code rather than throwing.

### `POST /torrent/stop`

Removes a viewer and returns the remaining viewer count.

When the last viewer leaves, `SessionManager` eventually destroys the session after its idle timeout.

### `_startPipeline(session, segmentCache)`

Starts the full backend pipeline.

Detailed flow:

1. Create `TorrentManager`.
2. Forward torrent trace and progress events into the session event bus.
3. Start WebTorrent and get `internalUrl` plus `videoFile`.
4. Probe codecs with ffprobe.
5. Create HLS output directory.
6. Touch and evict cache.
7. If cache is complete, bootstrap timeline from cache, create seek manager, start prioritization, mark stream ready, and stop.
8. Create main `HlsGenerator`.
9. On FFmpeg progress, update `mainLastTime`, estimate duration if missing, update torrent eviction frontier, and clean expired workers.
10. Start FFmpeg in the background.
11. Wait for `init.mp4`.
12. Start the main HLS directory watcher.
13. Create seek manager and piece-priority interval.
14. Start download-rate trace timer.
15. Wait for first segment and read init timescale.
16. Re-register early segments if the timescale was not 90000.
17. Mark session as streaming and emit `stream:ready`.

### `_watchMainHlsDir(session)`

Tracks main FFmpeg segment completion.

It processes already-existing files, then uses FFmpeg `segment-open` events to process the previous segment when the next segment opens.

### `_processMainSegment(session, filePath, filename)`

Reads segment timing, registers the segment as `source: "main"`, records generation ownership as generation 0, emits `segment:ready`, and traces promotion.

### `_resolveSafeDecodePoint(session, seekTime)`

Chooses the best safe decode point for a seek:

1. Use a known timeline cluster if it is not too far behind.
2. Ask `TorrentManager.safeDecodePointForTime()`.
3. Estimate byte from duration/file length as fallback.
4. For early seeks, use byte 0.
5. Otherwise return null.

### `_bootstrapFromCache(session)`

Reconstructs session timeline from cached `master.m3u8`.

It reads the video timescale from `init.mp4`, parses optional custom `#EXT-X-TORRENT-DURATION`, walks playlist `#EXTINF` entries, and bulk-registers segments.

This avoids reading thousands of `.m4s` files during cache startup.

### `_rebalancePiecePriority(session)`

Runs every 5 seconds.

If there is an active pending seek, it prioritizes a 100 MB window at the seek byte.

Otherwise it prioritizes 30 seconds ahead of each viewer's current playback position.

### `_writeDurationToPlaylist(playlistPath, duration)`

Injects or updates a custom playlist tag:

```text
#EXT-X-TORRENT-DURATION:<seconds>
```

This lets cached sessions recover duration without rerunning ffprobe.

## `test.html`

This is a standalone browser UI, MSE player, and diagnostic console. It is served as the root page by `backend/server.js`.

The file contains HTML, CSS, and JavaScript in one document. It is not just a demo page; it implements the client-side streaming logic used to exercise the backend.

### HTML Structure

The page includes:

- magnet input
- diagnostics level selector
- start and stop buttons
- video element
- custom timeline scrubber
- status panel
- general log panel
- seek log panel
- timeline registry table
- segment tracker tables
- seek worker status area
- many diagnostic panels for seek latency, A/V sync, root-cause analysis, bandwidth, segment ownership, and generation checks

The UI is intentionally dense because the page is primarily a debugging harness.

### CSS

The CSS creates a dark, monospace-heavy dashboard layout.

It defines:

- base cards
- buttons
- video sizing
- status/log panels
- seek analysis panels
- tables
- warning/ok/error colors
- scrollable diagnostics regions
- responsive layout for player and trace stacks

The CSS is presentation-only. It does not affect backend behavior, but it makes the extensive telemetry readable.

### Global Constants

Important JavaScript constants include:

- `MIN_BUFFER_AHEAD`: target buffered seconds before playback is considered healthy.
- `SEEK_WINDOW_SEC`: range around a seek target to fetch/queue seek segments.
- `MAX_SEEK_PREROLL_SECONDS`: client-side counterpart to backend preroll safety.
- `MAX_MSE_BUFFER_SPAN`: how much media to keep in SourceBuffer.
- `AV_TIMELINE_WARN_MS`: drift threshold for warnings.
- `AV_TIMELINE_SEEK_SEGMENTS`: number of first seek segments always logged.

### Global State

The page tracks:

- active startup `EventSource`
- active feed `EventSource`
- active session id
- active viewer id
- polling timer
- current `SegmentPlayer`
- current video timescale
- diagnostics settings

### `SegmentTracker`

Tracks segment lifecycle in the UI.

It records states such as:

- discovered
- fetching
- fetched
- appended
- displayed
- failed

There are separate video and audio trackers. They help show whether a segment was merely announced, actually fetched, appended to MSE, or visible at playback time.

### Duration Helpers

`resolveMovieDuration(sessionId, streamUrl, hint)` tries to determine full movie duration. It prefers server hints, but can fall back to other available metadata.

`formatTime(sec)` renders seconds as readable time.

### fMP4 Parsing Helpers in the Browser

The frontend includes lightweight parsing helpers similar in purpose to `backend/pipeline/fmp4.js`.

`parseFragmentTracks(data)` parses track timing from a fetched segment buffer.

`readFirstVideoTfdt(data)` extracts the first video TFDT.

These are used only for client-side diagnostics and queue correction. The backend remains the authoritative source for timeline registration.

### Trace and Diagnostics Functions

The file contains many functions that route trace events into different diagnostic panels.

Examples:

- `logServerTrace(data, { feed })`
- `dispatchTraceTelemetry(phase, data)`
- `appendSeekAvAnalysisEvent(...)`
- `appendSeekRootCauseEvent(...)`
- `appendSeekWorkerSpawnEvent(...)`
- `appendFfmpegTimestampAuditEvent(...)`
- `appendTrackTimelineDiagnosticEvent(...)`
- `appendTfdtNormalizationEvent(...)`
- `appendBwSeekServerEvent(...)`

These functions do not control playback directly. They classify and render telemetry from the backend and from MSE operations.

### `TimelineQueue`

Client-side sorted queue of segment metadata.

It supports operations such as:

- insert a segment while preserving media-time order
- clear queue
- find a segment covering a time
- find a segment extending the current buffer
- find the next segment after buffered end
- build a contiguous chain of segments
- remove old/unwanted entries

This is the frontend counterpart to the backend timeline, but it is a local working set rather than the source of truth.

### `SegmentPlayer`

This is the main client-side playback engine.

Constructor inputs:

- video element
- init segment URL
- session id
- MSE MIME type
- duration
- timeline scrubber element

Important internal state:

- `MediaSource` instance
- `SourceBuffer`
- queue of timeline segments
- fetched segment buffers
- currently fetching segment ids
- appended segment ids
- generation counter
- pending seek time
- seek bootstrap segment
- cleanup timers
- abort controllers
- diagnostics state

### `SegmentPlayer.init()`

Initializes MSE playback.

Flow:

1. Wire video and timeline events.
2. Create `MediaSource`.
3. Wait for `sourceopen`.
4. Set duration if known.
5. Add `SourceBuffer`.
6. Fetch and append `init.mp4`.
7. Mark player ready.
8. Start duration lock and cleanup agent.
9. Add `timeupdate`, `waiting`, and `durationchange` handlers.

### `SegmentPlayer.loadTimeline()`

Fetches `/torrent/timeline` around the current playback time and inserts non-seek segments into the queue.

This is used at startup and after seeks so the browser has a local window of segment metadata without relying only on SSE replay.

### `SegmentPlayer.onSegmentReady(data)`

Receives `segment:ready` SSE payloads from the backend.

It normalizes the segment, logs metadata, records generation information, tracks it in the UI, and enqueues it.

### `SegmentPlayer._pump()`

The central client loop.

It:

1. Finds fetch candidates.
2. Starts segment fetches.
3. Chooses the next segment to append.
4. Checks SourceBuffer readiness.
5. Appends buffered segment data.
6. Handles generation mismatches.
7. Handles quota errors by purging old ranges and retrying.
8. Updates appended state and continues pumping.

This method is called after timeline updates, fetch completions, appends, time updates, waiting events, and seeks.

### `SegmentPlayer._fetchSegment(seg, gen)`

Fetches a media segment from:

```text
/stream/<sessionId>/by-id/<segmentId>
```

It stores the array buffer in the local cache only if the generation still matches. It parses fragment timing for diagnostics and queue correction.

Generation checks prevent old seek responses from polluting the current playback state.

### `SegmentPlayer._nextToAppend()`

Decides which queued segment should append next.

Normal playback:

- start with segment covering time 0
- then append segments that extend buffered end
- reject large gaps unless in post-seek tolerance

During seek:

- prefer the bootstrap segment that covers the target
- allow larger gaps temporarily
- wait for covering segments if needed

### `SegmentPlayer.seek(toTime, source)`

Handles user or video-control seeks.

Major actions:

1. Increment generation.
2. Abort old fetches.
3. Clear buffers/fetching/queue state.
4. Create seek diagnostics state.
5. Remove old SourceBuffer ranges.
6. POST `/torrent/seek`.
7. If backend returns cached segment, fetch it.
8. If backend starts or waits for worker, start covering poll.
9. Pump the queue.

The generation number is the client-side defense against races from previous seeks.

### `SegmentPlayer._startSeekCoveringPoll(gen, toTime)`

Long-polls `/torrent/covering` until a segment covering the target appears.

When a covering segment appears, it becomes the seek bootstrap segment, is enqueued, fetched, and pumped.

### `SegmentPlayer._ensureGapRecoveryPoll()`

Starts a poll that asks `/torrent/covering?after=<bufferedEnd>` for the next segment when the local queue has a hole.

This keeps playback moving when SSE ordering, cache bootstrap, or FFmpeg timing creates a temporary gap.

### `SegmentPlayer._ensureInitForSegment(isSeekSeg)`

Switches between `init.mp4` and `seek_init.mp4` when appending main vs seek-worker segments.

MSE needs an initialization segment matching the media fragments being appended. Seek workers write `seek_init.mp4` to avoid overwriting the main init segment.

### `SegmentPlayer.destroy()`

Stops timers, aborts fetches, closes MSE if possible, clears video source, and clears in-memory queues.

This is called when the user presses Stop or when cleanup resets the page state.

### Startup Button Handler

The start button:

1. Validates the magnet input.
2. POSTs `/torrent/start`.
3. Opens startup SSE at `/torrent/events/:sessionId`.
4. Handles progress, trace batches, errors, and `stream:ready`.
5. On stream readiness, starts the MSE player and status polling.

### `launchMsePlayer(payload)`

Uses the stream-ready payload to start playback.

If MSE is not supported, it falls back to native HLS by assigning the playlist URL to the video element.

If MSE is supported, it resolves duration, creates `SegmentPlayer`, initializes it, loads initial timeline, and opens the segment feed.

### `openFeed(feedUrl)`

Opens persistent playback SSE.

It listens for:

- `segment:ready`
- `duration:ready`
- `server:trace`
- `event_batch`

### Stop Button Handler

The stop button:

1. Cleans up local playback.
2. POSTs `/torrent/stop` with session and viewer ids.
3. Resets UI state.

### Video Seeking Handler

If the user seeks to a time that is not already buffered, the handler calls `segPlayer.seek(t, "video_controls")`.

If the target is already buffered, native video seeking is allowed to complete without backend intervention.

### Status Polling

`startPolling(sessionId)` polls `/torrent/status` every 5 seconds and updates:

- download state
- speed
- peers
- pieces
- segment counts
- FFmpeg position
- RAM
- viewer count
- seek workers

It also refreshes the timeline registry panel every 10 seconds, skipping refresh during healthy playback unless verbose diagnostics are enabled.

### `cleanup()`

Closes SSE connections, destroys the segment player, clears timers, resets timescale, clears diagnostics, resets the video element, and resets UI controls.

## Cross-File Data Flow

### Startup Flow

1. `test.html` posts to `/torrent/start`.
2. `routes/torrent.js` creates a session in `session/manager.js`.
3. `_startPipeline()` creates `TorrentManager`.
4. `TorrentManager.start()` starts WebTorrent and internal HTTP.
5. `detectCodecs()` probes the internal HTTP source.
6. `HlsGenerator.start()` starts main FFmpeg.
7. `_watchMainHlsDir()` notices completed segments.
8. `_processMainSegment()` parses timing with `fmp4.js`.
9. `SegmentTimelineRegistry.register()` records the segment.
10. Session emits `segment:ready`.
11. Once first segment exists, session emits `stream:ready`.
12. Browser receives `stream:ready`, creates `SegmentPlayer`, fetches init, loads timeline, opens feed.

### Segment Request Flow

1. Browser decides it needs a segment.
2. Browser requests `/stream/:sessionId/by-id/:segmentId`.
3. `routes/stream.js` validates the id.
4. `_serveSegment()` checks disk and timeline.
5. If missing, it waits through `timeline.waitForFile()` or `timeline.waitForTime()`.
6. Once available, it streams the file.
7. Browser appends it to MSE.

### Large Seek Flow

1. Browser calls `SegmentPlayer.seek()`.
2. Browser POSTs `/torrent/seek`.
3. Route checks cached segment and main encoder proximity.
4. Route resolves safe decode point using timeline clusters or `TorrentManager`.
5. Route may pause main FFmpeg.
6. `SeekWorkerManager.startWorker()` starts a worker generation.
7. Torrent pieces near seek byte are prioritized.
8. Worker waits for pieces.
9. Worker FFmpeg writes temp segments.
10. Worker watcher parses TFDT and promotes segments to main HLS dir.
11. Timeline registers promoted segments.
12. SSE feed emits `segment:ready`.
13. Browser covering poll or SSE receives the segment.
14. Browser fetches and appends the target-covering segment.
15. Playback resumes at the seek target.

## Important Runtime Invariants

- One non-error active session per info hash.
- HLS cache directories persist beyond session lifetime.
- Timeline entries are sorted by media start time.
- Segment readiness should be communicated through the timeline, not raw directory listing.
- Main segments belong to generation `0`.
- Seek-worker segments belong to the current seek generation.
- Client and server both use generation/epoch metadata to avoid stale seek artifacts.
- FFmpeg seek workers write to scratch directories first; only parsed, validated segments are promoted.
- `seek_init.mp4` is separate from `init.mp4` because seek-worker fragments may need a matching init segment.
- The custom torrent store can evict old pieces, so piece gates must check in-store availability, not just WebTorrent verification.

## Environment Variables

- `PORT`: backend port, default `3000`.
- `HOST`: backend listen host, default `0.0.0.0`.
- `CACHE_MAX_GB`: segment cache size, default `10`.
- `LOG_LEVEL`: `error`, `warn`, `info`, or `debug`.
- `ENABLE_TFDT_NORMALIZATION`: enables seek-worker audio TFDT correction when truthy.
- `AVSYNC_DIAG_MODE`: optional diagnostic mode consumed by seek/FFmpeg code.

## Files Not Documented as Runtime Source

- `backend/package-lock.json`: npm lockfile. It records exact dependency versions and integrity hashes. It is important for reproducible installs but does not contain application logic.
- `.gitignore` and `backend/.gitignore`: ignore rules, not runtime code.
- `README.md`, `architecture.md`, `seek-architecture.md`: prose documentation already present in the repo.
- `graphify-out/*`: generated graph/report/cache artifacts.

