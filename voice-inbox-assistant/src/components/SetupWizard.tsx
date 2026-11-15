"use client";

import { useEffect, useRef, useState } from "react";
import { readError, type ActiveVoice, type VoiceOption } from "@/components/types";
import type { ReadingMode } from "@/lib/playback";
import type { SummaryLength } from "@/lib/system-prompt";

export interface SetupChoice {
  mode: ReadingMode;
  length: SummaryLength;
  voice: ActiveVoice;
}

const MODES: Array<[ReadingMode, string, string]> = [
  ["one", "One at a time", "I read one email, then wait while you choose Delete, Next or Reorganize."],
  ["all", "All at once", "I read every email back to back, with a short pause between them."],
];
const LENGTHS: Array<[SummaryLength, string, string]> = [
  ["short", "Short", "One sentence per email."],
  ["medium", "Medium", "Two to three sentences."],
  ["long", "Long", "Every detail, four to six sentences."],
];
const STEP_TITLES = ["How should I read them?", "How long should each summary be?", "Which voice should read?", "Ready?"];

const option = (selected: boolean) =>
  `flex w-full min-h-11 items-start gap-3 rounded-xl border px-4 py-3 text-left ${selected ? "border-indigo-400 bg-indigo-500/15" : "border-slate-600 hover:bg-slate-800"}`;
const btn = "inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-2.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The guided flow behind the Gmail "AI Summary" button: reading mode → length → voice → Start.
 * Every step can go Back; nothing is scanned until Start.
 */
export function SetupWizard({ initial, onStart, onCancel }: { initial: SetupChoice; onStart: (c: SetupChoice) => void; onCancel: () => void }) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<ReadingMode>(initial.mode);
  const [length, setLength] = useState<SummaryLength>(initial.length);
  const [voice, setVoice] = useState<ActiveVoice>(initial.voice);
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const sample = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("/api/voices")
      .then(async (res) => {
        if (!res.ok) throw new Error((await readError(res)).message);
        return (await res.json()) as { custom: VoiceOption[]; presets: VoiceOption[] };
      })
      .then((j) => alive && setVoices([...j.custom, ...j.presets]))
      .catch((e: unknown) => alive && setVoiceError(e instanceof Error ? e.message : "Couldn't load voices."));
    return () => {
      alive = false;
      sample.current?.pause();
    };
  }, []);

  // Move focus to each step's heading so keyboard and screen-reader users follow along.
  useEffect(() => heading.current?.focus(), [step]);

  const voiceName = voice.label || "no voice picked";
  const canContinue = step !== 2 || Boolean(voice.id);

  function playSample(url: string) {
    sample.current?.pause();
    sample.current = new Audio(url);
    void sample.current.play().catch(() => {});
  }

  return (
    <section role="dialog" aria-modal="false" aria-labelledby="setup-h" className="rounded-2xl border border-indigo-400/60 bg-slate-900 p-5 shadow-xl">
      <p className="text-sm font-semibold text-indigo-300">
        Step {step + 1} of 4
      </p>
      <h2 id="setup-h" ref={heading} tabIndex={-1} className="mt-1 text-xl font-bold outline-none">
        {STEP_TITLES[step]}
      </h2>

      <div className="mt-4 space-y-2">
        {step === 0 &&
          MODES.map(([id, label, help]) => (
            <button key={id} type="button" className={option(mode === id)} aria-pressed={mode === id} onClick={() => setMode(id)}>
              <span aria-hidden className="mt-0.5">{mode === id ? "●" : "○"}</span>
              <span>
                <span className="block font-semibold">{label}</span>
                <span className="block text-sm text-slate-400">{help}</span>
              </span>
            </button>
          ))}

        {step === 1 &&
          LENGTHS.map(([id, label, help]) => (
            <button key={id} type="button" className={option(length === id)} aria-pressed={length === id} onClick={() => setLength(id)}>
              <span aria-hidden className="mt-0.5">{length === id ? "●" : "○"}</span>
              <span>
                <span className="block font-semibold">{label}</span>
                <span className="block text-sm text-slate-400">{help}</span>
              </span>
            </button>
          ))}

        {step === 2 && (
          <>
            {!voices && !voiceError && <p className="text-slate-400">Loading voices…</p>}
            {voiceError && (
              <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300" role="alert">
                {voiceError}
              </p>
            )}
            {voices && (
              <ul className="max-h-[50vh] space-y-2 overflow-y-auto pr-1" aria-label="Voices">
                {voices.map((v) => {
                  const selected = voice.id === v.voice_id;
                  return (
                    <li key={v.voice_id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <button type="button" className={`${option(selected)} sm:flex-1`} aria-pressed={selected} onClick={() => setVoice({ id: v.voice_id, label: v.name })}>
                        <span aria-hidden className="mt-0.5">{selected ? "●" : "○"}</span>
                        <span className="min-w-0">
                          <span className="block font-semibold [overflow-wrap:anywhere]" title={v.name}>
                            {v.name}
                          </span>
                          {v.description && <span className="line-clamp-2 block text-sm text-slate-400">{v.description}</span>}
                        </span>
                      </button>
                      {v.preview_url && (
                        <button type="button" className={`${btn} shrink-0 border border-slate-600 text-sm hover:bg-slate-800`} onClick={() => playSample(v.preview_url!)} aria-label={`Hear a sample of ${v.name}`}>
                          ▶ Sample
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {step === 3 && (
          <dl className="space-y-2 rounded-xl border border-slate-700 p-4">
            <div>
              <dt className="text-sm text-slate-400">Reading</dt>
              <dd className="font-semibold">{MODES.find(([id]) => id === mode)![1]}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-400">Summary length</dt>
              <dd className="font-semibold">{LENGTHS.find(([id]) => id === length)![1]}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-400">Voice</dt>
              <dd className="font-semibold [overflow-wrap:anywhere]" title={voiceName}>
                {voiceName}
              </dd>
            </div>
          </dl>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        {step > 0 ? (
          <button type="button" className={`${btn} border border-slate-600 hover:bg-slate-800`} onClick={() => setStep(step - 1)}>
            ← Back
          </button>
        ) : (
          <button type="button" className={`${btn} border border-slate-600 hover:bg-slate-800`} onClick={onCancel}>
            Cancel
          </button>
        )}
        {step < 3 ? (
          <button type="button" className={`${btn} bg-indigo-500 text-white hover:bg-indigo-400`} onClick={() => setStep(step + 1)} disabled={!canContinue}>
            Next →
          </button>
        ) : (
          <button type="button" className={`${btn} bg-indigo-500 text-white hover:bg-indigo-400`} onClick={() => onStart({ mode, length, voice })} disabled={!voice.id}>
            ▶ Start summarizing
          </button>
        )}
      </div>
    </section>
  );
}
