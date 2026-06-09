"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Library, Search, UserRound } from "lucide-react";
import { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/movies", label: "Movies" },
  { href: "/shows", label: "TV Shows" },
  { href: "/my-list", label: "My List" }
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isWatch = pathname.startsWith("/watch");
  const isEntry = pathname === "/" || pathname === "/login" || pathname === "/register" || pathname === "/profiles";

  return (
    <div className="min-h-screen">
      {!isWatch && !isEntry && (
        <header className="fixed inset-x-0 top-0 z-50 border-b border-primary/10 bg-background/82 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-5 px-4 sm:px-6">
            <Link href="/home" className="brand-font text-xl text-primary">
              ATHERA
            </Link>
            <Button asChild variant="secondary" className="hidden min-w-72 justify-start rounded-full bg-card/70 text-muted-foreground hover:text-foreground lg:inline-flex">
              <Link href="/search">
                <Search className="h-4 w-4" />
                Search your network
              </Link>
            </Button>
            <nav className="hidden items-center gap-1 md:flex">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-full px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-card hover:text-foreground",
                    pathname === item.href && "bg-card text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <Button asChild variant="ghost" size="icon" aria-label="My List">
                <Link href="/my-list">
                  <Library className="h-5 w-5" />
                </Link>
              </Button>
              <Button asChild variant="ghost" size="icon" aria-label="Search">
                <Link href="/search">
                  <Search className="h-5 w-5" />
                </Link>
              </Button>
              <Button asChild variant="ghost" size="icon" aria-label="Profile">
                <Link href="/profile">
                  <UserRound className="h-5 w-5" />
                </Link>
              </Button>
            </div>
          </div>
        </header>
      )}
      <main className={cn(!isWatch && !isEntry && "pt-16")}>{children}</main>
    </div>
  );
}
