import { notFound } from "next/navigation";
import { ContentDetails } from "@/components/catalog/content-details";
import { getServerContent } from "@/lib/server-catalog";

export const dynamic = "force-dynamic";

export default async function AnimeDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await getServerContent(id);
  if (!item || item.type !== "anime") notFound();
  return <ContentDetails item={item} />;
}
