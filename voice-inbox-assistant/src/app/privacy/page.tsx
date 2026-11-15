import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

export const metadata: Metadata = { title: "Privacy policy · Voice Inbox Assistant" };

const UPDATED = "November 16, 2026";

/** Public privacy policy (Google's OAuth verification requires one on the app's domain). */
export default async function Privacy() {
  // Rendered per request so CONTACT_EMAIL comes from the server's env, not the Docker build.
  await connection();
  const contact = process.env.CONTACT_EMAIL;
  // Set GEMINI_PAID_TIER=true only once billing is on for the Gemini key's project. On the free
  // tier, Google may use the content sent to Gemini to improve its products, and the page says so.
  const paidGemini = process.env.GEMINI_PAID_TIER === "true";
  const h2 = "mt-8 text-xl font-bold";
  const p = "mt-3 leading-relaxed text-slate-300";
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 [overflow-wrap:anywhere]">
      <Link href="/" className="inline-flex min-h-11 items-center text-sm font-semibold text-indigo-300 underline">
        ← Voice Inbox Assistant
      </Link>
      <h1 className="mt-4 text-3xl font-bold">Privacy policy</h1>
      <p className="mt-2 text-sm text-slate-400">Last updated {UPDATED}</p>

      <h2 className={h2}>What the app does</h2>
      <p className={p}>
        Voice Inbox Assistant reads your newest Gmail messages when you press Scan, writes a short summary of each one, and reads the summaries aloud in a voice you
        choose.
      </p>

      <h2 className={h2}>Google data we access</h2>
      <ul className={`${p} list-disc space-y-2 pl-5`}>
        <li>Your name and email address, to show who is signed in and to keep your saved voices private to you.</li>
        <li>
          Gmail access (<code>gmail.modify</code>). Only when you press Scan, the app reads the sender, subject, date, labels and text of the number of recent inbox
          messages you choose.
        </li>
        <li>
          Only when you click <strong>Delete</strong> on an email, the app moves that one email to Gmail&apos;s Trash (you can restore it there for 30 days). Only when
          you pick a label under <strong>Reorganize</strong>, it files that one email under that label and takes it out of the Inbox. The app never deletes anything
          permanently, never sends email, and never changes an email on its own: not for spam, and not when a summary fails.
        </li>
        <li>
          Sensitive emails (for example banking, medical, government, or password and security-code messages) are recognized from the sender and subject only. Their text
          is never downloaded, summarized or read aloud; the app only says how many it skipped.
        </li>
      </ul>

      <h2 className={h2}>How it is used and who processes it</h2>
      <ul className={`${p} list-disc space-y-2 pl-5`}>
        <li>
          The text of the emails you scan is sent to the Google Gemini API to write the summaries.{" "}
          {paidGemini ? (
            "The app uses Gemini's paid tier, under which Google does not use this content to improve its products."
          ) : (
            <>
              <strong>The app currently uses Gemini&apos;s free tier, under which Google may use the content sent to it to improve Google&apos;s products</strong>{" "}
              (see the{" "}
              <a className="text-indigo-300 underline" href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">
                Gemini API terms
              </a>
              ). Don&apos;t scan an inbox you aren&apos;t comfortable sharing on that basis.
            </>
          )}
        </li>
        <li>The summaries (not the original emails) are sent to ElevenLabs to turn them into speech.</li>
        <li>If you record or upload your voice to create a custom voice, that audio is sent to ElevenLabs to make the voice.</li>
        <li>Your data is used only to provide these features to you. The app does not sell it, use it for advertising, or share it with anyone besides the services above.</li>
      </ul>

      <h2 className={h2}>What is stored</h2>
      <ul className={`${p} list-disc space-y-2 pl-5`}>
        <li>The app has no database and does not store your emails or summaries on its server.</li>
        <li>
          Your Google sign-in tokens are kept in an encrypted, HttpOnly cookie in your browser so you stay signed in. Signing out deletes it.
        </li>
        <li>Generated audio is kept only in your browser tab and is discarded when you scan again or close the tab.</li>
        <li>
          So you can pick up where you left off (for example after switching away from Gmail), your latest scan&apos;s summaries are kept in this browser for up to
          three hours. Signing out or starting a new scan removes them.
        </li>
        <li>Your settings (chosen voice, summary length, reading mode, pause between emails) are saved in your browser.</li>
        <li>
          Custom voices you create are stored in the app&apos;s ElevenLabs account, marked as yours so that no other user can see, play or remove them. You can delete
          them at any time with Remove in the Voice Box.
        </li>
      </ul>

      <h2 className={h2}>Limited Use</h2>
      <p className={p}>
        Voice Inbox Assistant&apos;s use and transfer of information received from Google APIs to any other app will adhere to the{" "}
        <a className="text-indigo-300 underline" href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. The app itself never uses Gmail data for advertising or for anything other than the summaries you ask for.
        {paidGemini ? " Gmail data is not used to train AI models." : " How Google may use content sent to Gemini's free tier is described above."}
      </p>

      <h2 className={h2}>Your choices</h2>
      <p className={p}>
        You can sign out at any time. To remove the app&apos;s access to your Google account completely, visit{" "}
        <a className="text-indigo-300 underline" href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
          myaccount.google.com/permissions
        </a>
        .
      </p>

      {contact && (
        <>
          <h2 className={h2}>Contact</h2>
          <p className={p}>
            Questions or deletion requests: <a className="text-indigo-300 underline" href={`mailto:${contact}`}>{contact}</a>
          </p>
        </>
      )}
    </main>
  );
}
