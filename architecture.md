# CONTEXT.md

# Athera

## Distributed Self-Hosted Media Streaming Platform

Status: Architecture Vision Document

Version: 1.0

---

# What Is Athera?

Athera is a self-hosted media platform designed to provide a Netflix-like experience using decentralized content acquisition and intelligent streaming infrastructure.

The long-term goal is to create a platform where users can:

* Stream movies
* Stream TV shows
* Stream anime
* Resume playback across devices
* Receive personalized recommendations
* Maintain watch history
* Manage libraries
* Self-host their own instance

without depending on centralized streaming providers.

The user experience should feel indistinguishable from Netflix, Crunchyroll, Jellyfin, Plex, or Disney+, while using decentralized acquisition methods under the hood.

Users should never need to think about:

* torrents
* seeders
* peers
* trackers
* transcoding
* segment generation

They should only interact with:

* play
* pause
* seek
* continue watching
* recommendations
* watchlists

---

# Core Philosophy

## Media Time Is The Source Of Truth

The most important principle in Athera:

Media timeline is authoritative.

Never:

* segment indexes
* filenames
* playlist order
* transcoder counters

Every system should operate using media time.

Example:

Bad:

```javascript
segment = Math.floor(time / 2)
```

Good:

```javascript
timeline.findSegmentForTime(time)
```

---

# Product Vision

Athera should eventually provide:

## User Accounts

Users can:

* create accounts
* manage profiles
* maintain watch history
* sync progress
* create watchlists

Similar to Netflix profiles.

Example:

```text
User
 ├─ Main
 ├─ Kids
 ├─ Anime
 └─ Guest
```

---

## Continue Watching

Athera should remember:

```json
{
  "userId": "...",
  "mediaId": "...",
  "currentTime": 1854.5
}
```

and resume playback automatically.

---

## Recommendations

Future recommendation engine:

Inputs:

* watch history
* completion rates
* genres
* favorites
* ratings
* watchlists

Outputs:

* continue watching
* trending
* recommended
* because you watched
* similar content

Initially simple.

Future:

ML-based recommendation system.

---

## Metadata System

Future metadata providers:

* TMDB
* TVDB
* AniList
* MyAnimeList

Metadata should be cached locally.

Media entities:

```text
Movie
Show
Season
Episode
Anime
OVA
Special
```

---

# Self Hosting First

Athera is designed primarily as a self-hosted platform.

Requirements:

* Docker deployment
* Linux support
* ARM support
* x86 support
* Single-machine operation
* Future clustered deployment

Athera should run on:

* Raspberry Pi
* Home server
* NAS
* VPS
* Dedicated server

---

# Architectural Goals

## Primary

* Fast playback
* Fast seeking
* Torrent-native acquisition
* Persistent caching
* Timeline-native playback
* Low operational cost

## Secondary

* Horizontal scalability
* Browser-assisted acquisition
* Multi-user support
* Cross-device synchronization

---

# Long-Term Architecture

```text
Browser
    │
    ▼
Timeline Player
    │
    ▼
Segment API
    │
    ▼
Timeline Registry
    │
    ▼
Segment Store
    │
    ▼
Transcoding Engine
    │
    ▼
Byte Provider
    │
 ┌──┴──┐
 ▼     ▼
Server Browser
Swarm  Swarm
```

---

# Timeline Registry

The Timeline Registry is the most important system in Athera.

Every segment becomes:

```json
{
  "segmentId": "...",
  "startTime": 0,
  "endTime": 2,
  "duration": 2
}
```

The registry is authoritative.

Responsibilities:

* seek resolution
* gap recovery
* segment lookup
* playback continuity
* timeline persistence

Future requirement:

Timeline Registry must be persisted in a database.

Never memory-only.

---

# Database-First Architecture

Critical state should never live exclusively in memory.

Databases should store:

* users
* sessions
* watch history
* continue watching
* timelines
* segment metadata
* recommendations
* media library
* torrent state
* metrics

Possible choices:

* SQLite (single node)
* PostgreSQL (production)

---

# Torrent Acquisition Layer

Purpose:

Acquire bytes.

Nothing more.

The acquisition layer should know nothing about:

* FFmpeg
* codecs
* playback
* media timelines

Interface:

```typescript
interface ByteProvider {
  getRange(start, end)
  prioritize(start, end)
  availability(start, end)
}
```

---

# Browser-Assisted Acquisition

Future Stage 4 feature.

Browser joins swarm.

Purpose:

* increase peer count
* improve piece availability
* improve seek latency

Browser does NOT:

* transcode
* generate segments
* manage timelines

Browser only assists acquisition.

---

# Piece Coordinator

Future component.

Tracks:

```json
{
  "piece": 123,
  "serverHas": true,
  "browserHas": false,
  "priority": 5
}
```

Purpose:

* swarm diagnostics
* seek optimization
* availability awareness

Initially:

Telemetry only.

Later:

Cooperative acquisition.

---

# Weak Swarm Strategy

Athera must remain functional on poor torrents.

Assume:

```text
1 Seeder
2 Peers
```

not

```text
200 Seeders
```

---

## Strategy 1

Aggressive seek prioritization.

---

## Strategy 2

Server + Browser dual acquisition.

---

## Strategy 3

Adaptive seek windows.

---

## Strategy 4

Torrent health scoring.

Example:

```typescript
enum TorrentHealth {
    Excellent,
    Good,
    Weak,
    Critical
}
```

Inputs:

* peers
* availability
* speed
* latency

---

## Strategy 5

Adaptive quality profiles.

Weak swarm:

```text
720p
```

Strong swarm:

```text
1080p
```

Future:

Multiple transcode ladders.

---

## Strategy 6

Seek snapshots.

Generate frame previews before playback resumes.

---

## Strategy 7

Predictive buffering.

Observe user behavior.

Prefetch likely seek targets.

---

# Transcoding Layer

Must be replaceable.

Never couple architecture directly to FFmpeg.

Interface:

```typescript
interface Transcoder {
    start()
    stop()
    seek()
}
```

Implementations:

* FFmpeg
* GStreamer
* Hardware transcoder
* Future custom pipeline

---

# Scheduler

Athera must include a centralized scheduler.

Purpose:

Prevent uncontrolled worker growth.

Priority levels:

HIGH

* seek generation

MEDIUM

* playback generation

LOW

* cache warming
* metadata refresh

---

# Metrics And Observability

Everything should be measurable.

Every operation must have:

```json
{
  "start",
  "end",
  "duration"
}
```

Track:

* seek latency
* segment generation latency
* promotion latency
* playback resume latency
* acquisition latency

---

# Resource Management

One of the most important systems.

Every resource must be tracked.

Examples:

* FFmpeg
* torrent clients
* timers
* event listeners
* SSE streams
* workers
* temporary files

Future component:

```typescript
class ResourceManager
```

Responsibilities:

* registration
* cleanup
* recovery
* restart handling

---

# Cleanup System

Cleanup is a first-class feature.

Not an afterthought.

---

## Session Cleanup

Destroy:

* torrent managers
* FFmpeg
* workers
* SSE streams

when idle.

---

## Seek Cleanup

Destroy:

* temp directories
* orphan processes
* stale timeline entries

immediately after completion.

---

## Cache Cleanup

LRU-based.

Support:

* size limits
* age limits
* retention policies

---

## Timeline Cleanup

Remove:

* stale seek artifacts
* duplicate entries
* invalid segments

---

## Browser Cleanup

On disconnect:

* leave swarm
* stop acquisition
* clear temporary state

---

# Multi-User System

Future requirement.

Users should be isolated.

Store:

```json
{
  "userId": "...",
  "profileId": "...",
  "watchHistory": [],
  "favorites": [],
  "watchlist": []
}
```

Support:

* households
* profiles
* permissions

---

# Media Library

Future library abstraction.

Media types:

* Movie
* Show
* Season
* Episode
* Anime
* OVA
* Special

Library should exist independently from acquisition method.

---

# Future AI Features

Possible future additions:

* recommendation ranking
* smart continue watching
* scene detection
* intro detection
* credits detection
* semantic search

Example:

```text
show me anime similar to Vinland Saga
```

---

# Design Principles

1. Media time is authoritative.
2. Timeline Registry is authoritative.
3. Critical state must be persisted.
4. FFmpeg is replaceable.
5. Acquisition and playback are separate systems.
6. Browser assists acquisition, not transcoding.
7. Everything must be measurable.
8. Cleanup is mandatory.
9. Components should fail independently.
10. Self-hosting is a first-class requirement.

---

# Ultimate Goal

Athera should provide a streaming experience comparable to commercial streaming platforms while remaining self-hostable, decentralized, resilient, and extensible.

The user should never think about torrents.

The user should only think about watching content.
