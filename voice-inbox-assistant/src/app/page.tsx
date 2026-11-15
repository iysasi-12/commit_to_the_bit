import Link from "next/link";
import { auth } from "@/auth";
import { signInWithGoogle } from "@/app/actions";
import { Dashboard } from "@/components/Dashboard";
import { SignInWatcher } from "@/components/SignInWatcher";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-16">
        <h1 className="text-4xl font-bold tracking-tight">Voice Inbox Assistant</h1>
        <p className="mt-4 text-lg text-slate-300">
          Sign in with Google and hear your newest emails summarized one at a time: Work and School first, then Personal, then Transactions. Spam is skipped.
        </p>
        <form action={signInWithGoogle} className="mt-8">
          <button type="submit" className="w-full rounded-xl bg-white px-6 py-4 text-lg font-semibold text-slate-900 hover:bg-slate-200">
            Sign in with Google
          </button>
        </form>
        <p className="mt-4 rounded-lg bg-slate-800 px-4 py-3 text-sm text-slate-300">
          In the Gmail side panel? Google won&apos;t show its sign-in page inside a panel.{" "}
          <a href="/" target="_blank" rel="noreferrer" className="font-semibold text-indigo-300 underline">
            Sign in in a new tab
          </a>
          , then come back here. This panel updates by itself once you&apos;re signed in.
        </p>
        <SignInWatcher />
        <p className="mt-6 text-sm text-slate-400">
          Reads your Gmail, and only moves an email to Trash or files it under a label when you click Delete or Reorganize. Email text is sent to Google Gemini to write
          the summaries, and summary text is sent to ElevenLabs to speak them. Nothing is stored on the server.{" "}
          <Link href="/privacy" className="font-semibold text-indigo-300 underline">
            Privacy policy
          </Link>
        </p>
      </main>
    );
  }

  return (
    <Dashboard
      name={session.user.name ?? ""}
      email={session.user.email ?? ""}
      sessionExpired={session.error === "RefreshTokenError"}
      canModify={session.canModify === true}
    />
  );
}
