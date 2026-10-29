// voice.js — the agent-facing voice tool (§11 "Voice input", v0.55.0):
// voice_transcribe sends a WAV to the configured KEYLESS STT endpoint.
//
// House wiring, deliberate:
//   - .wav-ONLY: any other extension is a teaching refusal — this tool
//     transcribes speech audio; the parser speaks RIFF/PCM natively and
//     refuses to hand compressed bytes to a stranger.
//   - risky:true: the call PUTS FILE BYTES ON THE NETWORK — the same gate
//     class as cloud deploy. The why contract applies.
//   - The config is re-read fresh on every call (settings can change between
//     turns); keyless is enforced there (an auth key in voice.* is a refusal,
//     never a credential in play).
//   - The receipt is bounded and honest: audio shape, dialect, host, chars,
//     a sanitized preview. The full transcript rides the observation ONCE —
//     it is the tool's product — capped at 2000 chars; longer transcripts
//     point at the CLI (`buddy voice transcribe`) for the full text.
import path from 'node:path';
import { BuddyError } from '../util.js';
import { loadSettingsView } from '../settings.js';
import { readVoiceConfig, transcribeWav, transcribeReceiptText } from '../voice.js';

const PREVIEW_CAP = 2000;

export function createVoiceTools({ scope }) {
  return [
    {
      name: 'voice_transcribe',
      description: 'Transcribe a .wav audio file to text through the user-configured KEYLESS STT endpoint (voice.stt.endpoint in .buddy/settings.json — a local whisper.cpp/OpenAI-compatible server). Risky: the audio bytes leave the machine. Only RIFF WAV (PCM/float) is accepted — compressed audio must be converted first. Broken files are refused, never uploaded.',
      args: '{"path":"meeting.wav"}',
      risky: true,
      render: (a) => `voice_transcribe ${a?.path}`,
      run: async ({ path: p } = {}) => {
        try {
          if (!p || typeof p !== 'string') throw new BuddyError('voice_transcribe: path required', { code: 'UNSAFE_PATH' });
          scope._guard(p);
          if (!p.toLowerCase().endsWith('.wav')) {
            throw new BuddyError(`voice_transcribe: "${p}" is not a .wav — this tool parses RIFF WAV natively (PCM or float); compressed audio must be converted first (hint: ffmpeg -i in.mp3 out.wav)`, { code: 'NOT_WAV_PATH' });
          }
          const abs = scope.resolveSafe(p);
          let stat;
          try {
            stat = await import('node:fs').then((fs) => fs.statSync(abs));
          } catch {
            throw new BuddyError(`voice_transcribe: cannot stat "${p}"`, { code: 'VOICE_READ' });
          }
          if (stat.isDirectory()) throw new BuddyError(`voice_transcribe: "${p}" is a directory`, { code: 'VOICE_READ' });
          const { cfg, problems } = readVoiceConfig(loadSettingsView(scope.root));
          if (problems.length) {
            return `ERROR: voice config has problems — ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`;
          }
          const r = await transcribeWav({ abs, cfg, eventsRoot: scope.root });
          if (r.text.length <= PREVIEW_CAP) return transcribeReceiptText(r);
          // over the tool preview cap: honest truncation with the way out
          const head = transcribeReceiptText({ ...r, text: '' }).split('\n')[0];
          return [
            head,
            '',
            `transcript (${r.text.length} chars — showing the first ${PREVIEW_CAP}):`,
            `${r.text.slice(0, PREVIEW_CAP)}…`,
            `WARNING: transcript truncated — for the full text run: buddy voice transcribe -f ${p}`,
          ].join('\n');
        } catch (e) {
          return `ERROR: ${e?.message || e}`;
        }
      },
    },
  ];
}
