import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ProfileSelection } from "@/components/layout/profile-selection";
import { getUserProfiles } from "@/lib/profiles";

export default async function ProfilesPage() {
  const { user, profiles } = await getUserProfiles();
  if (!user) redirect("/");

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-4xl text-center">
        <div className="brand-font text-4xl text-primary">ATHERA</div>
        <h1 className="brand-font mt-10 text-4xl">Choose your space</h1>
        <p className="mt-3 text-muted-foreground">Athera opens into your personal network, not a generic catalog.</p>
        <ProfileSelection profiles={profiles} />
        <Button asChild variant="ghost" className="mt-8">
          <Link href="/settings">Settings</Link>
        </Button>
      </div>
    </div>
  );
}
