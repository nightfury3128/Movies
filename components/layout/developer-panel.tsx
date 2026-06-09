import { Card } from "@/components/ui/card";

const diagnostics = [
  "Segment logs",
  "Torrent lifecycle events",
  "Seek worker traces",
  "A/V sync diagnostics",
  "Timeline and cache state"
];

export function DeveloperPanel() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-10">
      <h1 className="text-3xl font-black">Developer Diagnostics</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Internal playback telemetry is isolated here so the production streaming UI stays focused on watching.
      </p>
      <div className="mt-6 grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card className="p-5">
          <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Panels</div>
          <div className="mt-4 grid gap-2">
            {diagnostics.map((item) => (
              <div key={item} className="rounded-md bg-white/5 px-3 py-2 text-sm">
                {item}
              </div>
            ))}
          </div>
        </Card>
        <Card className="min-h-96 p-5 font-mono text-sm text-muted-foreground">
          Connect this panel to internal engine diagnostics when a live playback session is selected. These tools remain hidden from the production watching experience.
        </Card>
      </div>
    </div>
  );
}
