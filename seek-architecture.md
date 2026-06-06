# Timeline-Backed Safe Seek Architecture

## Architecture Diagram

```text
User seeks to T
  |
  v
/torrent/seek resolves a SafeDecodePoint
  |
  +-- timeline cluster hit before T --------------------+
  |                                                     |
  +-- no hit: Cues lookup / cluster scan / header safe --+
  |
  v
Persist cluster metadata in timeline.json
  |
  v
SeekWorker starts FFmpeg at SafeDecodePoint.clusterOffset
  |
  v
FFmpeg decodes preroll and writes fMP4 segments
  |
  v
Watcher parses TFDT timing
  |
  +-- segment ends before requested T: discard
  |
  +-- segment overlaps/extends T: promote to HLS dir,
      register timeline metadata, emit segment:ready
```

## Index Schema

`timeline.json` now migrates from the old segment array into:

```json
{
  "version": 2,
  "segments": [
    {
      "segmentId": "segment_t838000.m4s",
      "file": "segment_t838000.m4s",
      "startTime": 838,
      "endTime": 840,
      "duration": 2,
      "byteOffset": 123400000,
      "clusterOffset": 123456789,
      "decodeStartTime": 832,
      "source": "seek"
    }
  ],
  "clusters": [
    {
      "startTime": 832,
      "endTime": null,
      "byteOffset": 123456789,
      "clusterOffset": 123456789,
      "source": "cues"
    }
  ]
}
```

Old array-only timelines still load and are rewritten as version 2 on the next update.

## Seek Worker Flow

1. Route checks for an already promoted segment covering `seekTime`.
2. If missing, it resolves a `SafeDecodePoint`.
3. The worker prioritizes pieces at `clusterOffset`.
4. The worker starts FFmpeg from `clusterOffset` and uses `startTime` as the output clock anchor.
5. Generated preroll segments are discarded until a segment overlaps the requested timestamp.
6. Promoted segments are registered with segment timing plus decode-point metadata.

## Cluster Discovery Strategy

Resolution order:

1. Use a persisted timeline cluster before the target when it is not more than 120 seconds behind.
2. Use MKV Cues, selecting the nearest cue at or before the target.
3. Scan from conservative preroll byte hints and validate the cluster timestamp.
4. If no safe cluster can be validated, fall back to byte `0`, which is slow but decode-safe.

Scans and Cues hits are recorded in the timeline so repeat seeks avoid the scan path.

## Preroll Discard

The worker keeps decoding from the safe point, but `_processSegment` discards any generated segment whose `endTime` is before `seekTime - 0.5`.

## Segment Promotion

The first segment that overlaps the target timestamp is copied into the main HLS directory, registered in the timeline, and emitted over SSE. Later generated segments are promoted normally. The player still seeks to the requested media time, not to the decode start.

## Failure Handling

If the worker produces no segments, it retries with the same safe decode point. If discovery cannot validate a cluster, the system falls back to the file header instead of using an unsafe estimated byte. `/torrent/covering` respawns workers through the same decode-point resolver.

## Migration Plan

1. Load legacy `timeline.json` arrays as segment entries.
2. Persist new updates as `{ version, segments, clusters }`.
3. Main encoder segments gain estimated `byteOffset` metadata.
4. Seek-worker segments gain exact `clusterOffset` and `decodeStartTime`.
5. Future seeks prefer the persisted cluster index before doing Cues or scan work.
