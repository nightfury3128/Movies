# Athera

Athera is a self-hosted media streaming platform and streaming systems experiment focused on low-latency playback, timeline-aware seeking, adaptive caching, and browser-native media delivery.

It is designed to explore efficient playback of large media assets when data arrives incrementally. The current implementation includes a WebTorrent-backed media provider, but the architecture is not limited to that provider. The core system is built around media-time indexing, fragment generation, reusable segment caches, shared sessions, and Media Source Extensions playback in the browser.

Athera currently focuses on:

- Browser-native playback through Media Source Extensions.
- Timeline-aware seeking driven by media time rather than byte order.
- Adaptive segment generation and seek acceleration.
- Persistent fragment caching across sessions and viewers.
- Shared acquisition and generation pipelines for multiple viewers.
- Provider abstraction for future local, remote, and distributed media sources.

## Why Athera Exists

Large media assets are difficult to stream efficiently when the full file is not immediately available. A system must handle startup latency, partial byte availability, codec compatibility, browser buffering behavior, timeline consistency, and seeks into regions that may not be downloaded, decoded, or indexed yet.

Athera exists to explore those systems problems directly.

The project is concerned with questions such as:

- How can playback begin before an entire asset is available?
- How can seeking work when the target bytes may not be present yet?
- How should generated media fragments be indexed and reused?
- How can multiple viewers share a single acquisition pipeline?
- How can a browser player recover from timeline gaps, append failures, and buffer pressure?
- How can a self-hosted node cache generated artifacts without hiding timing correctness bugs?
- How can media providers be swapped without rewriting playback, timeline, and caching logic?

The current codebase is a working experiment in streaming infrastructure. It combines a provider-backed byte acquisition layer, FFmpeg-based fragment generation, an authoritative timeline registry, a persistent segment cache, and a custom browser playback engine.

## Core Ideas

### 1. Timeline-Authoritative Playback

Athera treats media time as the source of truth.

Playback decisions are based on timeline coverage, not raw byte positions, playlist order, file numbering, or provider download order. Every generated segment is registered with a start time and end time. Seeking, buffering, gap recovery, and segment serving all consult the timeline.

This makes playback behavior independent from how data arrived.

### 2. Media-Time Segment Registry

Generated fragments are indexed by the time ranges they cover.

The `SegmentTimelineRegistry` tracks:

- Segment file name.
- Segment start time.
- Segment end time.
- Segment duration.
- Segment source, such as main pipeline or seek worker.
- Optional byte and cluster metadata.
- Safe decode points discovered during seeking.

The registry is persisted to disk as `timeline.json`, allowing generated media-time knowledge to survive process restarts.

### 3. Adaptive Seek Acceleration

Seeking is implemented by producing timeline coverage near the requested target.

When a target time is already covered, the existing segment is reused. When the main generator is close enough, the player can wait. For larger jumps, a seek worker resolves a safe decode point, prioritizes provider data near that point, starts a parallel FFmpeg process, and promotes generated fragments into the shared cache.

The browser does not directly seek inside a provider-specific file. It asks the backend for timeline coverage.

### 4. Segment-Aware Caching

Athera caches generated HLS/fMP4 artifacts, not just provider bytes.

This allows expensive work to be reused:

- Main pipeline fragments.
- Seek-generated fragments.
- Init segments.
- Timeline metadata.
- Duration hints.
- Safe decode information.

The cache is indexed by content hash and survives server restarts.

### 5. Shared Session Architecture

One content hash maps to one active acquisition and generation pipeline.

Multiple viewers can attach to the same session, share the same provider instance, share the same FFmpeg generator, share timeline state, and reuse generated fragments. Viewers remain independent at the playback layer while the backend avoids duplicating expensive acquisition and transcoding work.

### 6. Browser-Native Streaming

Athera uses browser-native media primitives.

The frontend uses Media Source Extensions to append fMP4 fragments directly into a `SourceBuffer`. This exposes real browser constraints around timestamp offsets, append windows, buffered ranges, quota errors, gap recovery, and A/V synchronization.

## High-Level Architecture

```text
Browser
  |
  v
Playback Engine
  |
  v
Timeline Registry
  |
  v
Segment Generator
  |
  v
Media Provider
```

### Browser

The browser runs the playback dashboard and MSE player. It receives timeline events, fetches fragments, appends them into MSE, handles seeking, and reports diagnostics.

### Playback Engine

The playback engine manages:

- Segment queues.
- MSE initialization.
- Fragment fetching.
- SourceBuffer appends.
- Seek reset.
- Gap recovery.
- Buffer cleanup.
- Timeline scrubber state.
- Diagnostics and trace rendering.

### Timeline Registry

The timeline registry is the authoritative mapping between media time and generated fragments. It is used by route handlers, seek workers, stream serving, and the browser-facing segment feed.

### Segment Generator

The segment generator wraps FFmpeg. It reads from a provider-backed byte stream and writes fMP4 HLS fragments. The main generator produces sequential coverage; seek workers produce accelerated coverage around requested target times.

### Media Provider

The media provider supplies bytes to the segment generator. Providers are intended to be pluggable.

The current implementation includes:

- WebTorrent-backed provider.

Future providers may include:

- Local files.
- NAS storage.
- Object storage.
- Remote media sources.
- Other incremental or distributed acquisition backends.

## Current Provider Implementation

Athera currently includes a WebTorrent-backed provider implementation. In this project, WebTorrent is used as a media provider for testing streaming behavior under partial and incremental data availability.

The provider is responsible for:

- Discovering available files from a source.
- Selecting a media asset.
- Acquiring byte ranges incrementally.
- Tracking verified pieces.
- Prioritizing pieces near playback and seek targets.
- Serving bytes to FFmpeg through an internal HTTP server.
- Reporting availability, speed, and diagnostics.

This provider is intentionally stressful for the rest of the system because data may arrive out of order, seeks may target unavailable regions, and provider byte availability may change over time.

The rest of Athera is designed to remain provider-agnostic:

- The browser consumes generated media fragments.
- The timeline registry indexes media-time coverage.
- The segment cache stores generated artifacts.
- Seek workers operate on safe decode points and provider byte ranges.
- Session management is keyed by content identity rather than provider type.

## Streaming Pipeline

```text
Media Provider
  |
  v
Provider-Backed Chunk Store
  |
  v
Internal HTTP Byte Stream
  |
  v
FFmpeg
  |
  v
Fragment Generation
  |
  v
Timeline Registry
  |
  v
Segment Cache
  |
  v
MSE Playback
```

### 1. Media Provider

The provider exposes the selected media asset as an incrementally available byte source. In the current implementation, the provider is WebTorrent and the media is acquired as verified pieces.

### 2. Provider-Backed Chunk Store

The WebTorrent provider uses a custom evicting memory store. It keeps recent chunks in memory, pins early header chunks, and evicts data behind the FFmpeg read cursor to avoid retaining an entire large asset in RAM.

### 3. Internal HTTP Byte Stream

FFmpeg reads from an internal HTTP server exposed by the provider. This decouples FFmpeg from the provider implementation and lets the provider control range handling, seek-worker start offsets, and piece readiness.

### 4. FFmpeg

FFmpeg probes and converts the source into fMP4 HLS output.

Depending on codec compatibility, Athera can:

- Remux compatible H.264/AAC-style sources without re-encoding.
- Transcode incompatible sources into browser-compatible H.264/AAC output.

### 5. Fragment Generation

The FFmpeg pipeline writes:

- `master.m3u8`
- `init.mp4`
- `seek_init.mp4`
- `segment_00000.m4s`
- `segment_00001.m4s`
- `segment_t<ms>.m4s` for seek-worker output

Main pipeline segments are sequential. Seek-worker segments are named by their actual media timeline start time.

### 6. Timeline Registry

Each generated fragment is parsed for fMP4 timing metadata. Athera reads TFDT and duration data, computes media-time coverage, and registers the fragment in the timeline.

### 7. Segment Cache

Generated artifacts are stored under:

```text
backend/cache/segments/<contentHash>/
```

The cache persists across server restarts and can serve already generated timeline coverage without rerunning the entire pipeline.

### 8. MSE Playback

The browser fetches timeline-known fragments and appends them into a SourceBuffer. The player tracks buffered ranges, current playback position, append state, seek state, and gap recovery decisions.

## Seeking Architecture

Seeking is one of the main engineering problems Athera is designed to study.

Efficient seeking is difficult when data is only partially available because a target time may not map cleanly to bytes that are currently available. Container indexes may be incomplete or unavailable. FFmpeg may attempt random access reads that the provider cannot satisfy yet. A browser MSE buffer may also contain ranges from a previous playback position that are no longer relevant after a seek.

Athera solves seeking as a timeline coverage problem.

### Seek Flow

```text
Browser seek target
  |
  v
POST /torrent/seek
  |
  v
Timeline coverage check
  |
  +--> Existing covering segment
  |
  +--> Wait for main generator
  |
  +--> Start seek worker
          |
          v
      Resolve safe decode point
          |
          v
      Prioritize provider data
          |
          v
      Generate fragments
          |
          v
      Promote covering segments
          |
          v
      Register timeline coverage
          |
          v
      Browser fetches and appends
```

### Timeline Coverage Detection

When the browser requests a seek, the backend first checks whether the timeline already contains a segment where:

```text
segment.startTime <= seekTime < segment.endTime
```

If that segment exists on disk, the backend returns it immediately. The browser can fetch it and set `video.currentTime` once the target time is buffered.

### Safe Decode Point Resolution

FFmpeg cannot always start decoding exactly at the requested media time. It needs a safe decode point, usually a keyframe or container cluster before the target.

Athera resolves safe decode points using several strategies:

- Reuse known clusters from the timeline.
- Parse MKV Cues when available.
- Scan for cluster boundaries near estimated byte positions.
- Fall back to the beginning of the file when no better point is known.

Safe decode points include:

- Requested media time.
- Decode start time.
- Byte offset.
- Cluster offset.
- Source of the discovery, such as timeline, cues, scan, or fallback.

### Provider Data Prioritization

After resolving a safe decode point, the provider prioritizes data near the target byte range. In the current WebTorrent provider, this means marking relevant pieces as critical and waiting for pieces to arrive in the in-memory store.

This avoids starting FFmpeg before the provider can satisfy the initial reads.

### Seek Workers

A seek worker is a parallel FFmpeg generator created for a specific target time.

It:

- Supersedes older seek workers.
- Creates a temporary output directory.
- Starts from a safe decode point.
- Generates short fragments near the target.
- Parses generated fragment timing.
- Discards fragments that only contain preroll before the target.
- Promotes useful fragments into the shared HLS cache.
- Registers promoted fragments in the timeline.
- Emits `segment:ready`.

Seek workers are temporary. They are cleaned up after completion, failure, supersession, or once the main generator has advanced far enough.

### Avoiding Provider-Hostile Random Access

For seek workers with a known safe byte offset, Athera starts FFmpeg against an internal URL containing:

```text
?start=<byte>&seekTime=<ms>
```

The FFmpeg wrapper disables input seekability for that worker, causing FFmpeg to read linearly from the safe point instead of issuing random range requests into unavailable data.

### Segment Promotion

Seek-worker output is generated in a scratch directory first. After Athera parses a fragment and confirms useful media-time coverage, it copies the fragment into the main session cache.

Promoted seek fragments are named by absolute media time:

```text
segment_t118000.m4s
```

This indicates a fragment whose absolute timeline start is approximately 118.000 seconds.

### Covering Segment Discovery

The browser does not assume the exact seek-worker segment name in advance. During a pending seek it long-polls:

```text
GET /torrent/covering?time=<seekTime>
```

The backend waits for timeline coverage and returns the segment that covers the target. SSE `segment:ready` events can also deliver the same discovery.

### Timeline Recovery

Timeline metadata is persisted. If generated fragments survive a process restart, Athera can reload timeline coverage and avoid recomputing known segment mappings.

The system also validates that timeline entries still correspond to files on disk, which prevents stale metadata from being served as valid coverage.

### Playback Ownership

The browser owns MSE state. The backend owns provider acquisition, generation, and timeline registration.

On seek, the browser:

- Increments a playback generation counter.
- Cancels old fetches.
- Clears segment queues.
- Removes unrelated buffered ranges where possible.
- Marks a pending seek target.
- Waits for target coverage.
- Appends the covering segment.
- Sets `video.currentTime` when the target is buffered.

This separation keeps backend seeking focused on producing coverage and frontend seeking focused on buffer state.

### Worker Lifecycle

Seek workers follow this lifecycle:

```text
created
  -> prioritize provider data
  -> wait for pieces
  -> start FFmpeg
  -> watch fragment output
  -> parse timing
  -> promote useful fragments
  -> register timeline entries
  -> emit segment events
  -> complete or retry
  -> cleanup
```

Only a small number of seek workers are allowed per session. A newer seek cancels older seek work because the latest user target is authoritative.

## Session Architecture

```text
One content hash
  |
  v
One acquisition pipeline
  |
  v
One main segment generator
  |
  v
Multiple viewers
```

Athera sessions are keyed by content identity. If multiple viewers request the same source, they join the same active session instead of starting independent provider and FFmpeg pipelines.

Each session owns:

- Session id.
- Content hash.
- Provider instance.
- Main FFmpeg generator.
- Seek worker manager.
- Timeline registry.
- Segment cache path.
- Viewer count.
- Viewer playback positions.
- Event bus for progress, trace, duration, and segment events.

### Session Sharing

Viewers share expensive backend resources:

- Provider acquisition.
- Main segment generation.
- Timeline state.
- Generated fragment cache.
- Seek-discovered safe decode points.

### Viewer Independence

Each viewer still has independent browser state:

- Current playback position.
- SourceBuffer contents.
- Pending seek target.
- Fetch queue.
- Diagnostics view.

The backend can serve different timeline regions to different viewers while avoiding duplicated acquisition and generation work when possible.

## Caching Architecture

Athera uses a segment-aware persistent cache.

### Segment Cache

Generated HLS/fMP4 artifacts are stored under:

```text
backend/cache/segments/<contentHash>/
```

The cache stores generated media output, not just provider bytes. This lets future sessions reuse fragments even if the provider has to reacquire raw data.

### Timeline Persistence

The timeline is persisted as:

```text
backend/cache/segments/<contentHash>/timeline.json
```

It records media-time coverage and discovered decode metadata. This makes the cache useful for seeking and gap recovery, not just static file serving.

### Eviction Strategy

The cache tracks least-recently-used content hashes. When total cache size exceeds the configured limit, older content directories can be evicted.

The cache limit is controlled by:

```text
CACHE_MAX_GB
```

### Seek Artifact Reuse

Seek-worker fragments are promoted into the same cache as main fragments. Future seeks to nearby times can reuse those fragments directly.

Safe decode points discovered during seek work are also stored in the timeline, improving later seek resolution.

### Cache Lifecycle

```text
fragment generated
  -> timing parsed
  -> timeline entry registered
  -> fragment stored on disk
  -> segment event emitted
  -> reused by active viewers
  -> persisted across restart
  -> evicted if cache pressure requires it
```

## Technical Challenges

Athera is intentionally built around hard streaming problems.

### Browser MSE Limitations

Media Source Extensions expose strict append rules:

- Init segments must match media fragments.
- SourceBuffer updates are serialized.
- Timestamp discontinuities can stall playback.
- Quota errors require buffer cleanup.
- Buffered ranges can become fragmented after seeks.
- Browser behavior differs across engines.

The frontend includes explicit queueing, append serialization, buffer pruning, and diagnostic tracing to manage these constraints.

### Timestamp Synchronization

Generated fragments must align with the browser media timeline. Athera parses fMP4 TFDT values and durations so timeline registration reflects actual decode timestamps rather than assumed segment numbers.

Seek-worker output is especially sensitive because fragments may start from a safe decode point before the requested target.

### Fragment Generation

The FFmpeg pipeline must balance:

- Startup latency.
- Remux versus transcode mode.
- Browser compatibility.
- Segment duration.
- Keyframe placement.
- Audio handling.
- Seek-worker timestamp behavior.

### Incremental Availability

When data arrives incrementally, the system must decide what to prioritize. The current provider prioritizes header data, playback-adjacent data, and seek-target data.

The generator must avoid blocking forever on bytes that are not available.

### Safe Seeking

Seeking requires decode-safe starting positions, not just approximate byte offsets. Container metadata, keyframes, cluster timestamps, and provider availability all affect whether a seek can start successfully.

### Audio/Video Synchronization

The frontend and backend both collect timing information about video and audio fragments. Seek behavior can expose A/V drift if timestamps are offset, fragments start at different times, or encoder priming affects audio timing.

### Partial File Access

The provider may not have arbitrary byte ranges available. Athera avoids provider-hostile random access during seek-worker startup by using safe byte starts and linear reads where possible.

### Buffer Recovery

The browser can encounter gaps, stale ranges, quota pressure, or pending seek state. The playback engine includes gap polling, segment discovery, post-seek continuation, and cleanup logic.

### Timeline Consistency

The timeline must remain consistent with files on disk. A stale timeline entry without a matching fragment cannot be treated as playable coverage.

## Athera Network (Future Direction)

The Athera Network is an optional future coordination layer designed to improve performance and availability across self-hosted Athera nodes.

The Athera Network is not required.

The Athera Network is not a media hosting platform.

The Athera Network is not a CDN.

The Athera Network is not responsible for media delivery.

Instead, it is intended to explore:

- Peer discovery.
- Availability awareness.
- Node health reporting.
- Geographic awareness.
- Swarm bootstrap assistance.
- Distributed optimization.
- Network intelligence.

All playback remains local to the user's node. All media acquisition remains local to the user's node. Participation is optional, and Athera should function correctly without the network.

This direction is future work and remains experimental.

## Design Principles

- Self-hosted first.
- User-controlled infrastructure.
- Local ownership of data.
- Optional network participation.
- Provider abstraction.
- Streaming performance.
- Transparent system behavior.
- Timeline-driven correctness.
- Reusable generated artifacts.
- Browser-native delivery.

## Repository Structure

```text
.
|-- README.md
|-- architecture.md
|-- seek-architecture.md
|-- test.html
|-- backend
|   |-- package.json
|   |-- package-lock.json
|   |-- server.js
|   |-- logger.js
|   |-- cache
|   |   |-- segment-cache.js
|   |   `-- segments/
|   |-- core
|   |   `-- timeline.js
|   |-- pipeline
|   |   |-- codec.js
|   |   |-- ffmpeg.js
|   |   |-- fmp4.js
|   |   `-- seek.js
|   |-- provider
|   |   |-- evicting-store.js
|   |   `-- webtorrent.js
|   |-- routes
|   |   |-- stream.js
|   |   `-- torrent.js
|   `-- session
|       `-- manager.js
`-- graphify-out
    |-- GRAPH_REPORT.md
    |-- cost.json
    |-- graph.html
    |-- graph.json
    `-- manifest.json
```

## Implementation Map

### Frontend

- `test.html`: Browser dashboard and playback engine. Includes MSE playback, segment queueing, seek handling, timeline scrubber, diagnostics panels, trace rendering, gap recovery, and buffer cleanup.

### Backend Entry

- `backend/server.js`: Fastify server entry point. Creates the cache, session manager, route plugins, static serving, health route, and graceful shutdown.
- `backend/logger.js`: Namespaced logging helpers and byte formatting.

### Core State

- `backend/core/timeline.js`: Authoritative media-time segment registry. Handles segment registration, timeline persistence, async waiters, range lookup, seek coverage lookup, and safe decode cluster storage.
- `backend/session/manager.js`: Per-content session registry. Tracks active sessions, viewer counts, viewer playback times, idle cleanup, and session resource teardown.

### Cache

- `backend/cache/segment-cache.js`: Persistent segment cache. Stores generated HLS artifacts, tracks LRU state, detects completed cached output, evicts old cache entries, and cleans seek scratch directories.

### Provider

- `backend/provider/webtorrent.js`: Current provider implementation. Handles WebTorrent acquisition, file selection, internal HTTP byte serving, piece prioritization, piece readiness checks, MKV Cues parsing, cluster scanning, provider stats, and trace events.
- `backend/provider/evicting-store.js`: Custom in-memory provider store. Pins header chunks, evicts old chunks, checks byte availability, and reports memory usage.

### Generation Pipeline

- `backend/pipeline/codec.js`: `ffprobe`-based codec detection. Chooses remux or transcode mode and returns browser MIME metadata.
- `backend/pipeline/ffmpeg.js`: FFmpeg HLS generator wrapper. Produces fMP4 HLS fragments, emits progress and segment-open events, supports main and seek-worker generators, and handles pause/resume/stop.
- `backend/pipeline/fmp4.js`: Minimal fMP4 parser. Reads TFDT, durations, track timing, and init-segment timescale.
- `backend/pipeline/seek.js`: Seek worker manager. Resolves worker lifecycle, piece gating, seek FFmpeg startup, segment parsing, preroll discard, promotion, timeline registration, SSE notification, retries, and cleanup.

### Routes

- `backend/routes/torrent.js`: Session lifecycle and control API. Starts pipelines, exposes SSE events, reports status, serves timeline windows, handles covering-segment long-polling, implements seek requests, and manages viewer stop events.
- `backend/routes/stream.js`: HLS file serving API. Serves playlists, init segments, and media fragments. Waits for generated segments and resolves seek artifact names through the timeline.

### Documentation and Generated Analysis

- `architecture.md`: Existing architecture notes.
- `seek-architecture.md`: Existing seek architecture notes.
- `graphify-out/*`: Generated graph analysis artifacts. These are not runtime dependencies.

## Current HTTP API Surface

The route names reflect the current implementation and may change as provider abstraction is formalized.

### Control and Session Routes

Mounted by `backend/routes/torrent.js` under `/torrent`:

- `POST /torrent/start`: Creates or joins a session for a selected source.
- `GET /torrent/events/:sessionId`: Startup SSE stream for progress, trace events, and `stream:ready`.
- `GET /torrent/feed/:sessionId`: Persistent SSE stream for `segment:ready`, `duration:ready`, and trace events.
- `GET /torrent/status`: Session, provider, memory, timeline, viewer, and seek-worker status.
- `GET /torrent/timeline`: Windowed timeline registry query.
- `GET /torrent/covering`: Long-poll for a segment covering a media time or extending a buffered range.
- `POST /torrent/seek`: Requests timeline coverage near a target media time.
- `POST /torrent/stop`: Detaches a viewer and allows idle cleanup.

### Stream Routes

Mounted by `backend/routes/stream.js` under `/stream`:

- `GET /stream/:sessionId`: Redirects to the session playlist.
- `GET /stream/:sessionId/master.m3u8`: Serves the generated HLS playlist.
- `GET /stream/:sessionId/init.mp4`: Serves the main initialization segment.
- `GET /stream/:sessionId/:filename`: Serves playlist, init, or segment files with wait-on-generation behavior.
- `GET /stream/:sessionId/by-id/:segmentId`: Timeline-aware segment serving by segment id.

## Running Athera

### Requirements

- Node.js 18 or newer.
- FFmpeg available on `PATH`.
- ffprobe available on `PATH`.
- Modern Chromium-based browser with Media Source Extensions support.

### Installation

```bash
git clone <repo-url>
cd TOrrent/backend
npm install
```

### Starting the Server

Production-style start:

```bash
npm start
```

Development start with Node watch mode:

```bash
npm run dev
```

Expected startup behavior:

- The backend creates or opens the segment cache directory.
- Fastify starts on the configured host and port.
- No provider pipeline starts until a media source is selected from the browser.

Useful environment variables:

- `PORT`: server port, default `3000`.
- `HOST`: bind host, default `0.0.0.0`.
- `LOG_LEVEL`: `error`, `warn`, `info`, or `debug`.
- `CACHE_MAX_GB`: maximum segment cache size in GB, default `10`.

### Accessing the Application

Open:

```text
http://localhost:3000
```

The browser interface includes:

- Playback dashboard.
- Media source input.
- Session information.
- Provider status.
- Timeline registry view.
- Segment tables.
- Seek diagnostics.
- FFmpeg and provider trace panels.
- Buffer and MSE diagnostics.

## Runtime Flow

1. Start Athera.
2. Open the browser dashboard.
3. Select a media source.
4. A session is created or joined by content hash.
5. The provider begins supplying data.
6. Codec detection determines remux or transcode mode.
7. FFmpeg generates fMP4 fragments.
8. Fragments are parsed and indexed by media time.
9. The browser receives stream readiness and segment events.
10. Playback begins through MSE.
11. Seeking becomes available through timeline coverage and seek workers.
12. Generated artifacts persist in the segment cache.

## Session Lifecycle

```text
Session Creation
  |
  v
Media Discovery
  |
  v
Codec Detection
  |
  v
Fragment Generation
  |
  v
Timeline Registration
  |
  v
Playback
  |
  v
Seeking
  |
  v
Cache Persistence
  |
  v
Cleanup
```

### Session Creation

The backend extracts a content identity and either creates a new session or attaches the viewer to an existing session.

### Media Discovery

The provider identifies a media asset and exposes it through the internal byte stream.

### Codec Detection

`ffprobe` determines codec compatibility and duration metadata when possible.

### Fragment Generation

The main FFmpeg generator writes fMP4 HLS fragments into the cache.

### Timeline Registration

Generated fragments are parsed and registered by media-time coverage.

### Playback

The browser fetches timeline-known fragments and appends them into MSE.

### Seeking

Seek requests use existing timeline coverage, main generator progress, or seek workers.

### Cache Persistence

Generated fragments and timeline metadata remain available after the session ends.

### Cleanup

Idle sessions stop provider acquisition, FFmpeg generators, seek workers, timers, and event listeners. Cache eviction runs separately based on configured storage limits.

## Project Status

Athera is currently an experimental streaming platform focused on:

- Playback architecture.
- Adaptive seeking.
- Browser-native delivery.
- Segment generation.
- Timeline indexing.
- Caching.
- Session sharing.
- Streaming systems research.

The current implementation uses a WebTorrent-backed provider to test streaming behavior under partial and incremental data availability. The provider is part of the current implementation, not the entire purpose of the project.

## Responsible Use

Athera does not include content, catalogs, or hosted media.

Users are responsible for ensuring they have the rights and permissions necessary to access and stream any media used with the platform.

## Long-Term Vision

Athera is an exploration of modern self-hosted media infrastructure.

The long-term goal is to combine:

- Browser-native streaming.
- Timeline-aware playback.
- Adaptive seeking.
- Intelligent caching.
- Session sharing.
- Provider abstraction.
- Optional network coordination.

into a unified self-hosted streaming platform focused on performance, transparency, and user-controlled infrastructure.
