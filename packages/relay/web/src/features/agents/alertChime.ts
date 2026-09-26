import type { AttentionLevel } from './agentAttention';

/**
 * A short two-note chime for an agent that needs a person.
 *
 * Browsers only let a page make sound after the person has interacted with
 * it, so the audio context is created on the first tap or key press after the
 * chime is switched on, and never before. Without Web Audio, or before that
 * first gesture, it stays silent rather than failing.
 */
type AudioContextConstructor = new () => AudioContext;

let context: AudioContext | null = null;

function audioContextClass(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Creates or resumes the audio context; must run inside a user gesture. */
export function unlockAlertChime(): void {
  const AudioContextClass = audioContextClass();
  if (!AudioContextClass) return;
  try {
    context = context ?? new AudioContextClass();
    if (context.state === 'suspended') void context.resume();
  } catch {
    context = null;
  }
}

/** Unlocks audio on the next tap or key press. Returns a remover. */
export function armAlertChime(target: Window = window): () => void {
  const unlock = () => {
    unlockAlertChime();
    remove();
  };
  const remove = () => {
    target.removeEventListener('pointerdown', unlock);
    target.removeEventListener('keydown', unlock);
  };
  target.addEventListener('pointerdown', unlock);
  target.addEventListener('keydown', unlock);
  return remove;
}

/** Falling for "needs you", rising for "finished". */
const NOTES: Record<AttentionLevel, [number, number]> = {
  blocked: [880, 660],
  done: [660, 880],
};

export function playAlertChime(level: AttentionLevel): void {
  if (context?.state !== 'running') return;
  try {
    const start = context.currentTime;
    NOTES[level].forEach((frequency, index) => {
      const oscillator = context!.createOscillator();
      const gain = context!.createGain();
      const at = start + index * 0.11;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.06, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
      oscillator.connect(gain);
      gain.connect(context!.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.1);
    });
  } catch {
    // A chime is a nicety; never let it throw into the status pipeline.
  }
}
