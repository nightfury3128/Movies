import type { ContentItem } from "@/lib/catalog";

export async function apiGet<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}

export function detailsPath(item: Pick<ContentItem, "id" | "type">) {
  if (item.type === "anime") return `/anime/${item.id}`;
  return item.type === "series" ? `/series/${item.id}` : `/movie/${item.id}`;
}
