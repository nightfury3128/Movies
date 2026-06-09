import { NextResponse } from "next/server";

const ENGINE_URL = process.env.ATHERA_ENGINE_URL ?? "http://localhost:3000";

export async function POST(request: Request) {
  const body = (await request.json()) as { contentId?: string };
  if (!body.contentId) return NextResponse.json({ error: "contentId is required" }, { status: 400 });

  const response = await fetch(`${ENGINE_URL}/resolver/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentId: body.contentId })
  }).catch(() => null);

  if (!response) {
    return NextResponse.json({
      contentId: body.contentId,
      streamUrl: "",
      status: "ready",
      candidates: ["Optimized", "1080p", "720p"],
      message: "Athera is ready when a playback source is available."
    });
  }

  if (!response.ok) {
    return NextResponse.json({ error: await response.text() }, { status: response.status });
  }

  const playback = (await response.json()) as {
    status: "ready" | "optimizing" | "unavailable";
    streamPath?: string;
    candidates?: string[];
    message?: string;
  };

  return NextResponse.json({
    contentId: body.contentId,
    streamUrl: playback.streamPath ? `${ENGINE_URL}${playback.streamPath}` : "",
    status: playback.status,
    candidates: playback.candidates ?? ["Optimized", "1080p", "720p"],
    message: playback.message ?? "Athera is preparing the best available playback route."
  });
}
