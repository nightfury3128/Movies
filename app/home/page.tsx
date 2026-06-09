import { ContentRow } from "@/components/catalog/content-row";
import { getServerHomeSections } from "@/lib/server-catalog";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const sections = await getServerHomeSections();

  return (
    <div className="space-y-10 py-10">
      <ContentRow title="Continue Watching" items={sections.continueWatching} emphasis="continue" />
      <ContentRow title="Trending Movies" items={sections.trendingMovies} />
      <ContentRow title="Trending Shows" items={sections.trendingShows} />
      <ContentRow title="Recommended" items={sections.recommended} />
      <ContentRow title="My List" items={sections.myList} />
    </div>
  );
}
