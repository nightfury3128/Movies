# Graph Report - .  (2026-06-07)

## Corpus Check
- Corpus is ~44,993 words - fits in a single context window. You may not need a graph.

## Summary
- 261 nodes · 472 edges · 13 communities (8 shown, 5 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 13 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Timeline Core & Logging|Timeline Core & Logging]]
- [[_COMMUNITY_Codec & Fragment Pipeline|Codec & Fragment Pipeline]]
- [[_COMMUNITY_Architecture & Design Docs|Architecture & Design Docs]]
- [[_COMMUNITY_WebTorrent Data Provider|WebTorrent Data Provider]]
- [[_COMMUNITY_Segment Timeline Registry|Segment Timeline Registry]]
- [[_COMMUNITY_Server & Segment Cache|Server & Segment Cache]]
- [[_COMMUNITY_NPM Dependencies|NPM Dependencies]]
- [[_COMMUNITY_Seek Worker Engine|Seek Worker Engine]]
- [[_COMMUNITY_Evicting Memory Store|Evicting Memory Store]]
- [[_COMMUNITY_HLS Stream Routes|HLS Stream Routes]]
- [[_COMMUNITY_Cluster Index|Cluster Index]]
- [[_COMMUNITY_Claude Settings|Claude Settings]]
- [[_COMMUNITY_Athera Root Node|Athera Root Node]]

## God Nodes (most connected - your core abstractions)
1. `TorrentManager` - 29 edges
2. `SegmentTimelineRegistry` - 29 edges
3. `log()` - 26 edges
4. `SegmentCache` - 15 edges
5. `Torrent Routes (lifecycle API)` - 15 edges
6. `warn()` - 13 edges
7. `SeekWorkerManager` - 13 edges
8. `SessionManager` - 12 edges
9. `_startPipeline()` - 12 edges
10. `SeekWorkerManager` - 12 edges

## Surprising Connections (you probably didn't know these)
- `parseFragmentTracks (client-side fMP4 parser)` --semantically_similar_to--> `readFragmentTracks`  [INFERRED] [semantically similar]
  test.html → backend/pipeline/fmp4.js
- `SegmentTimelineRegistry` --implements--> `Timeline Registry (Architecture Concept)`  [INFERRED]
  backend/core/timeline.js → architecture.md
- `SegmentTimelineRegistry` --implements--> `Media Time Is Authoritative (Design Principle)`  [INFERRED]
  backend/core/timeline.js → architecture.md
- `TorrentManager (ByteProvider)` --implements--> `ByteProvider Interface`  [INFERRED]
  backend/provider/webtorrent.js → architecture.md
- `Browser-Assisted Acquisition (Future)` --conceptually_related_to--> `TorrentManager (ByteProvider)`  [INFERRED]
  architecture.md → backend/provider/webtorrent.js

## Hyperedges (group relationships)
- **Seek Pipeline: TorrentManager + SeekWorkerManager + SegmentTimelineRegistry** — webtorrent_torrentmanager, seek_seekworkermanager, timeline_segmenttimelineregistry, ffmpeg_hlsgenerator [EXTRACTED 0.95]
- **Main Streaming Pipeline: WebTorrent to FFmpeg to Timeline to SSE Feed** — webtorrent_torrentmanager, ffmpeg_hlsgenerator, timeline_segmenttimelineregistry, routes_torrent, routes_stream [INFERRED 0.90]
- **fMP4 Segment Timing Extraction: TFDT + trun + timescale** — fmp4_readtfdt, fmp4_readtrunduration, fmp4_readvideotimescale, fmp4_readsegmenttiming [EXTRACTED 0.92]

## Communities (13 total, 5 thin omitted)

### Community 0 - "Timeline Core & Logging"
Cohesion: 0.09
Nodes (18): dbg(), err(), fmt(), fmtBytes(), LEVELS, log(), ts(), warn() (+10 more)

### Community 1 - "Codec & Fragment Pipeline"
Cohesion: 0.10
Nodes (28): detectCodecs(), execP, fallbackCodecInfo(), REMUX_AUDIO, REMUX_VIDEO, findBox(), parseTrunDuration(), readInitTimescale() (+20 more)

### Community 2 - "Architecture & Design Docs"
Cohesion: 0.09
Nodes (38): Browser-Assisted Acquisition (Future), ByteProvider Interface, Media Time Is Authoritative (Design Principle), Timeline Registry (Architecture Concept), Transcoder Interface, Weak Swarm Strategy, SegmentCache (Persistent LRU), detectCodecs (ffprobe) (+30 more)

### Community 3 - "WebTorrent Data Provider"
Cohesion: 0.12
Nodes (4): _ebmlIdLen(), _readUintBE(), _readVint(), TorrentManager

### Community 5 - "Server & Segment Cache"
Cohesion: 0.12
Nodes (9): __dirname, fastify, PORT, segmentCache, sessionManager, TEST_HTML, DEFAULT_CACHE_DIR, __dirname (+1 more)

### Community 6 - "NPM Dependencies"
Cohesion: 0.11
Nodes (18): dependencies, fastify, @fastify/cors, @fastify/static, fluent-ffmpeg, memory-chunk-store, pino-pretty, webtorrent (+10 more)

### Community 9 - "HLS Stream Routes"
Cohesion: 0.47
Nodes (7): _isSeekArtifact(), _parseSeekTime(), _resolveSegmentId(), _sendFile(), _serveSegment(), _serveStatic(), _waitForFileDisk()

### Community 11 - "Claude Settings"
Cohesion: 0.50
Nodes (3): permissions, allow, deny

## Knowledge Gaps
- **47 isolated node(s):** `allow`, `deny`, `LEVELS`, `__dirname`, `segmentCache` (+42 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SegmentTimelineRegistry` connect `Segment Timeline Registry` to `Timeline Core & Logging`?**
  _High betweenness centrality (0.147) - this node is a cross-community bridge._
- **Why does `TorrentManager` connect `WebTorrent Data Provider` to `Timeline Core & Logging`, `Codec & Fragment Pipeline`?**
  _High betweenness centrality (0.110) - this node is a cross-community bridge._
- **Why does `log()` connect `Timeline Core & Logging` to `Codec & Fragment Pipeline`, `WebTorrent Data Provider`, `Seek Worker Engine`?**
  _High betweenness centrality (0.095) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Torrent Routes (lifecycle API)` (e.g. with `SegmentPlayer (MSE timeline-driven, test.html)` and `Gap Recovery Poll (_ensureGapRecoveryPoll)`) actually correct?**
  _`Torrent Routes (lifecycle API)` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `allow`, `deny`, `LEVELS` to the rest of the system?**
  _47 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Timeline Core & Logging` be split into smaller, more focused modules?**
  _Cohesion score 0.08943089430894309 - nodes in this community are weakly interconnected._
- **Should `Codec & Fragment Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.10241820768136557 - nodes in this community are weakly interconnected._