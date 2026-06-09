import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/profiles";

export default async function ProfilePage() {
  const { user } = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-10">
      <h1 className="text-3xl font-black">Profile</h1>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <div className="text-sm text-muted-foreground">Signed in as</div>
          <div className="mt-2 text-xl font-bold">{user.user_metadata?.name ?? user.email?.split("@")[0] ?? "Viewer"}</div>
          <div className="text-sm text-muted-foreground">{user.email}</div>
        </Card>
        <Card className="p-5 md:col-span-2">
          <div className="font-semibold">Account</div>
          <p className="mt-2 text-sm text-muted-foreground">Identity and session management are handled by Supabase Auth.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button asChild variant="secondary">
              <Link href="/settings">Settings</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/settings/developer">Developer diagnostics</Link>
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
