import { notFound } from "next/navigation";
import { AtheraPlayer } from "@/components/player/athera-player";
import { getServerPlaybackContent } from "@/lib/server-catalog";

export default async function WatchPage({ params }: { params: Promise<{ contentId: string }> }) {
  const { contentId } = await params;
  const item = await getServerPlaybackContent(contentId);
  if (!item) notFound();

  const episode = item.episodes?.find((entry) => entry.id === contentId);
  return <AtheraPlayer content={item} contentId={contentId} title={episode?.title ?? item.title} />;
}
