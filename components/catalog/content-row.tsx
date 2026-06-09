import type { ContentItem } from "@/lib/catalog";
import { ContentCard } from "@/components/catalog/content-card";

export function ContentRow({ title, items, emphasis = "default" }: { title: string; items: ContentItem[]; emphasis?: "default" | "continue" }) {
  if (!items.length) return null;

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between px-4 sm:px-6 lg:px-10">
        <h2 className="brand-font text-2xl">{title}</h2>
      </div>
      <div className="scrollbar-none flex gap-4 overflow-x-auto px-4 pb-3 sm:px-6 lg:px-10">
        {items.map((item) => (
          <div key={item.id} className="w-72 flex-none sm:w-80">
            <ContentCard item={item} emphasis={emphasis} />
          </div>
        ))}
      </div>
    </section>
  );
}
