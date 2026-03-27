const SOUNDS = {
  pieceMove: '/sounds/piece-move.ogg',
  pieceCapture: '/sounds/piece-capture.ogg',
  check: '/sounds/check.ogg',
  spyglassSuccess: '/sounds/spyglass-success.ogg',
  spyglassFail: '/sounds/spyglass-fail.ogg',
} as const;

type SoundName = keyof typeof SOUNDS;

const audioCache: Partial<Record<SoundName, HTMLAudioElement>> = {};

let soundEnabled = localStorage.getItem('specter-sound') !== 'false';

export function isSoundEnabled(): boolean {
  return soundEnabled;
}

export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled;
  localStorage.setItem('specter-sound', String(enabled));
}

function getAudio(name: SoundName): HTMLAudioElement {
  if (!audioCache[name]) {
    audioCache[name] = new Audio(SOUNDS[name]);
  }
  return audioCache[name]!;
}

export function playSound(name: SoundName, delayMs = 0): void {
  if (!soundEnabled) return;
  const play = () => {
    const audio = getAudio(name);
    audio.currentTime = 0;
    audio.play().catch(() => {});
  };
  if (delayMs > 0) setTimeout(play, delayMs);
  else play();
}
