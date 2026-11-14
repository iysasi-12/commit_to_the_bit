# Inbox Voice: demo script (about 4 minutes)

**The pitch in one line:** your inbox, read to you by a voice you choose. That can even be your own voice.

## Before you present

1. Run the app from the `commit_to_the_bit` folder:

   ```bash
   npm run dev
   ```

   Then open http://localhost:3000.
2. Check the terminal's startup lines:
   - `Voice : live` means ElevenLabs is connected. Needed for real voices.
   - `Summaries/AI : live` means Gemini or Claude is connected. Without it, summaries are a plain demo list instead of real AI writing.
3. Sign in with **Try the demo inbox**. It's safest on stage, since it shows no personal email. Agree to the privacy screen once ahead of time.
4. **Create your own voice ahead of time** (Voice → Create my voice, read the script for 1 to 2 minutes, approve). Creating it live takes a couple of minutes and needs a quiet room.
5. Tap **AI Summary** once before you present, so the first playback on stage is instant. Replays come from a saved copy and cost nothing.
6. Mute notifications, turn the volume up, and keep the browser zoom at about 110%.

## The demo

| Time | Show | Say |
|---|---|---|
| 0:00 | **Inbox** tab | "This is my inbox. Fourteen emails: school, work, bills, family. I don't have time to read them all." |
| 0:20 | Tap **AI Summary** | "One tap. AI reads my latest emails and writes a short briefing: what needs a reply, what's due, what can wait." Let it play about 15 seconds. Tap **Show text** to show the transcript. |
| 0:50 | **Read by** menu → pick another voice → **AI Summary** again | "I can choose who reads it. ElevenLabs has dozens of voices…" |
| 1:10 | **Read by** → **your own voice** → **AI Summary** | "…or my own. I recorded about a minute of my voice once, and now my inbox reads to me in it." (This gets the reaction.) |
| 1:40 | **Voice** tab | "Here's how you add a voice: agree, read a short script, preview, approve. You can delete it any time, and that deletes it at ElevenLabs too." Point at the ready-made voices and the Voice Library search. |
| 2:20 | **Filter** tab → **School** → **AI Summary of School** | "AI sorts mail into categories I control. If I only care about school right now, I hear just that." Show **Edit categories** briefly. |
| 2:50 | **Gmail view** tab | "And this is where it's going: right inside your mail app, as a side panel." Click an email → **AI Summary of this email** in the side panel. Switch the voice in the panel. |
| 3:30 | **Settings** → Privacy | "Gmail access is read-only. We show exactly what's sent to the AI and the voice service, summaries auto-delete after 72 hours, and one button deletes everything." |
| 3:50 | Close | "Inbox Voice: your email, in a voice you trust." |

## What to say if someone asks

- **"Is the Gmail view really inside Gmail?"** Not yet; it's a concept screen built into our app. The buttons are real: same inbox, same voices, same summaries. The real version would be a Gmail add-on, which Google supports.
- **"Can it read my texts or iMessages?"** No. Apple and Google don't let third-party apps read those. This works with Gmail through Google's official API.
- **"Can someone clone my voice?"** Only you can create your voice, and you must confirm it's yours. Nobody else can select it, and deleting it removes it at ElevenLabs.
- **"Does it work in the car?"** It plays like any audio over Bluetooth. It isn't a CarPlay app.

## If something goes wrong on stage

- **"Usage limit reached" (Gemini free tier)**: tap the same summary again. It's already saved, so it replays without calling the AI.
- **Voice error**: pick a ready-made voice from **Read by** and tap AI Summary again.
- **No internet**: use **Show text** to read the saved summary aloud, or play one you generated before the talk.
