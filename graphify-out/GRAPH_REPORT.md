# Athera Streaming Engine — Knowledge Graph Report

**Generated:** 2026-06-02  
**Corpus:** 17 files · ~20,700 words (15 code, 2 docs)  
**Graph:** 208 nodes · 345 edges · 13 communities

---

## Outputs

| File | Description |
|------|-------------|
| `graph.html` | Interactive visualization (168 KB) — open in browser |
| `graph.json` | GraphRAG-ready JSON (165 KB) |

---

## God Nodes (highest connectivity)

| Degree | Node | Why it matters |
|--------|------|----------------|
| 32 | **torrent.js** | Orchestrates the entire pipeline: binds WebTorrent, FFmpeg, SessionManager, SeekWorker, and all API routes. Single biggest risk surface. |
| 23 | **SegmentTimelineRegistry** | The authoritative media clock — every component reads or writes through it. Bridging score 0.136. |
| 18 | **log()** | Cross-cuts everything; not a risk but a coupling signal. |
| 18 | **SegmentPlayer (test.html)** | The entire frontend player is one monolithic class — seek, MSE, gap recovery, A/V sync, cleanup agent all inside it. |
| 14 | **SegmentCache** | LRU disk store; bridges server startup, session lifecycle, and destroy. |
| 12 | **TorrentManager / SessionManager** | Lifecycle owners — their failure paths propagate everywhere. |

---

## Bridge Nodes (betweenness centrality — structural bottlenecks)

| Score | Node |
|-------|------|
| 0.280 | **torrent.js** — single point connecting all subsystems |
| 0.154 | **manager.js** — session lifecycle hub |
| 0.137 | **server.js** — startup wiring, registers all routes |
| 0.136 | **SegmentTimelineRegistry** — shared clock |
| 0.089 | **webtorrent.js** — only torrent I/O provider |
| 0.074 | **SegmentCache** — only persistence layer |
| 0.066 | **evicting-store.js** — RAM piece window; if it stalls, FFmpeg starves |

---

## Communities

| Community | Size | Theme |
|-----------|------|-------|
| C0 | 41 | **Core pipeline** — FFmpeg, SeekWorker, Timeline, TorrentManager, routes |
| C1 | 34 | **Frontend player** — SegmentPlayer, MSE, SSE feed, all API clients |
| C2 | 23 | **Server bootstrap** — Fastify, SegmentCache, server.js wiring |
| C3 | 22 | **Timeline internals** — all SegmentTimelineRegistry methods |
| C4 | 19 | **Package manifest** — package.json nodes |
| C5–C12 | 6–12 | Individual module method clusters (codec, seek, provider, fmp4) |

---

## Surprising Connections

- **SegmentPlayer ↔ Prefetch strategy** (INFERRED 0.9): The frontend's contiguous-chain scheduling is implicit inside SegmentPlayer — it's not a separate module, so it has no independent testability.
- **TimelineQueue ↔ Prefetch** (INFERRED 0.85): TimelineQueue drives the prefetch order but is structurally separate from where the prefetch decision is made — a hidden coupling.
- **fMP4 parser ↔ VIDEO_TIMESCALE** (INFERRED 0.8): The timescale is read from `init.mp4` server-side but also hard-coded in the frontend fMP4 parser. These two values must stay in sync; there's no runtime check enforcing it.
- **HLS M3U8 endpoint ↔ /torrent/status** (INFERRED 0.7): Duration resolution chains these two in sequence — if `/status` is slow, M3U8 duration appears wrong.

---

## Suggested Questions for Graph Traversal

1. **"What breaks if SegmentTimelineRegistry throws?"** — 23 dependents, no circuit breaker.
2. **"How does a seek request propagate end-to-end?"** — trace: `SegmentPlayer → POST /seek → SeekWorkerManager → _processSegment → timeline.register → SSE → SegmentPlayer`
3. **"What is the only path from torrent data to the browser?"** — `evicting-store → TorrentManager._startInternalServer → FFmpeg → fmp4.js → hlsPath → /stream/:id`
4. **"Which nodes have no test coverage?"** — everything in C0 (pipeline core); C1 tests are the only ones, and they're manual via test.html.
5. **"If SegmentCache.evict() is slow, what blocks?"** — `_startPipeline` and `_destroy` both call it synchronously on the hot path.

---

## Architecture Risk Summary

- **torrent.js is doing too much** (degree 32, betweenness 0.28) — splitting seek handling and segment processing into their own route files would reduce coupling.
- **SegmentPlayer in test.html is a 2400-line monolith** — seek, MSE buffer management, gap recovery, A/V sync, and cleanup are all entangled. No unit tests possible.
- **Single provider** — webtorrent.js is the only torrent I/O path; betweenness 0.089 means any failure here takes down streaming entirely with no fallback.
- **evicting-store.js is a silent choke point** — when the sliding RAM window falls behind FFmpeg's read cursor, the HTTP range requests stall. No backpressure signal to the pipeline.
