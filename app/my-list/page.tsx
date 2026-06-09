import { ContentRow } from "@/components/catalog/content-row";
import { catalogSections } from "@/lib/catalog";

export default function MyListPage() {
  const sections = catalogSections();
  return (
    <div className="space-y-8 py-10">
      <div className="px-4 sm:px-6 lg:px-10">
        <h1 className="brand-font text-4xl">My List</h1>
        <p className="mt-2 text-muted-foreground">Your saved network, ready when you are.</p>
      </div>
      <ContentRow title="Saved for Later" items={sections.recentlyAdded} />
    </div>
  );
}
