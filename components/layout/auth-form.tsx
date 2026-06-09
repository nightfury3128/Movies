"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isRegister = mode === "register";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();
    let supabase: ReturnType<typeof createClient>;

    try {
      supabase = createClient();
    } catch {
      setError("Supabase env is missing from the browser bundle. Restart dev server, or rebuild before npm start.");
      return;
    }

    const result = isRegister
      ? await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { name: name || email.split("@")[0] || "Viewer" },
            emailRedirectTo: `${window.location.origin}/auth/callback`
          }
        })
      : await supabase.auth.signInWithPassword({ email, password });

    if (result.error) {
      setError(result.error.message);
      return;
    }

    router.push("/profiles");
  }

  async function sendMagicLink() {
    setError("");
    setNotice("");
    const input = document.querySelector<HTMLInputElement>('input[name="email"]');
    const email = input?.value;
    if (!email) {
      setError("Enter your email first.");
      return;
    }

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` }
      });
      if (error) setError(error.message);
      else setNotice("Magic link sent. Check your email.");
    } catch {
      setError("Supabase env is missing from the browser bundle. Restart dev server, or rebuild before npm start.");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="athera-surface w-full max-w-md p-6">
        <Link href="/" className="brand-font text-2xl text-primary">
          ATHERA
        </Link>
        <h1 className="brand-font mt-8 text-3xl">{isRegister ? "Create your network" : "Welcome back"}</h1>
        <form onSubmit={submit} className="mt-6 space-y-4">
          {isRegister && <Input name="name" placeholder="Name" autoComplete="name" />}
          <Input name="email" type="email" placeholder="Email" autoComplete="email" required />
          <Input name="password" type="password" placeholder="Password" autoComplete={isRegister ? "new-password" : "current-password"} required />
          {error && <p className="text-sm text-destructive">{error}</p>}
          {notice && <p className="text-sm text-primary">{notice}</p>}
          <Button className="w-full rounded-full" size="lg" variant="action">
            {isRegister ? "Register" : "Login"}
          </Button>
        </form>
        {!isRegister && (
          <Button type="button" variant="ghost" className="mt-3 w-full rounded-full" onClick={sendMagicLink}>
            Send Magic Link
          </Button>
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          {isRegister ? "Already have an account?" : "New to Athera?"}{" "}
          <Link href={isRegister ? "/login" : "/register"} className="text-foreground underline underline-offset-4">
            {isRegister ? "Login" : "Register"}
          </Link>
        </p>
      </Card>
    </div>
  );
}
