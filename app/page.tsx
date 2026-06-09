import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  return (
    <section className="relative flex min-h-screen items-center justify-center overflow-hidden px-6">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(187,161,73,0.22),transparent_24rem),radial-gradient(circle_at_70%_70%,rgba(208,61,1,0.12),transparent_22rem),linear-gradient(145deg,#111618,#1a211f_55%,#0f1415)]" />
      <div className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/10 opacity-60 motion-safe:animate-pulse" />
      <div className="relative z-10 mx-auto max-w-xl text-center">
        <div className="brand-font text-6xl text-primary sm:text-8xl">ATHERA</div>
        <p className="brand-font mt-8 text-2xl text-foreground sm:text-4xl">The Streaming Network</p>
        <p className="mt-5 text-lg leading-8 text-muted-foreground sm:text-xl">Watch Anything. Continue Anywhere.</p>
        <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" variant="action">
            <Link href="/register">Sign Up</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/login">Login</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
