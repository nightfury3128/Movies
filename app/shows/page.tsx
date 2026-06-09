import { ContentRow } from "@/components/catalog/content-row";
import { getServerTrending } from "@/lib/server-catalog";

export const dynamic = "force-dynamic";

export default async function ShowsPage() {
  const shows = await getServerTrending("series");
  return (
    <div className="space-y-8 px-0 py-10">
      <div className="px-4 sm:px-6 lg:px-10">
        <h1 className="brand-font text-4xl">TV Shows</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">Season-based stories with continuity across episodes and devices.</p>
      </div>
      <ContentRow title="All Shows" items={shows} />
    </div>
  );
}
