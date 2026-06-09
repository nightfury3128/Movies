import { notFound } from "next/navigation";
import { ContentDetails } from "@/components/catalog/content-details";
import { getServerContent } from "@/lib/server-catalog";

export const dynamic = "force-dynamic";

export default async function MovieDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await getServerContent(id);
  if (!item || item.type !== "movie") notFound();
  return <ContentDetails item={item} />;
}
