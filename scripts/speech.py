"""Persistent local neural voice worker. JSON lines in/out, silent WAV generation."""
import hashlib, json, os, pathlib, re, sys
from piper import PiperVoice, SynthesisConfig
from piper.config import PiperConfig
import onnxruntime as ort
import time
import numpy as np
import soundfile as sf

options = ort.SessionOptions()
options.intra_op_num_threads = max(1, min(8, int(os.environ.get("CHESS_SPEECH_THREADS", "4"))))
options.inter_op_num_threads = 1
root = pathlib.Path('data/audio'); root.mkdir(parents=True, exist_ok=True)
kokoro = None
piper = None

def load_kokoro():
    global kokoro
    if kokoro is None:
        from kokoro_onnx import Kokoro
        session = ort.InferenceSession(str(pathlib.Path(os.environ.get('KNIGHTLIGHT_RESOURCES', '.')) / 'vendor/kokoro/onnx/model_quantized.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
        # The community export declares float speed; kokoro-onnx 0.4.9 supplies int32.
        class CommunitySession:
            def __getattr__(self, key):
                return getattr(session, key)
            def run(self, outputs, feed):
                feed['speed'] = np.asarray(feed['speed'], dtype=np.float32)
                result = session.run(outputs, feed)
                result[0] = result[0].reshape(-1)
                return result
        kokoro = Kokoro.from_session(CommunitySession(), str(pathlib.Path(os.environ.get('KNIGHTLIGHT_RESOURCES', '.')) / 'vendor/kokoro/voices.npz'))
    return kokoro

def load_piper():
    global piper
    if piper is None:
        model = pathlib.Path(str(pathlib.Path(os.environ.get('KNIGHTLIGHT_RESOURCES', '.')) / 'vendor/voices/en/en_US/lessac/medium/en_US-lessac-medium.onnx'))
        piper = PiperVoice(
            session=ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider']),
            config=PiperConfig.from_dict(json.loads(pathlib.Path(str(model)+'.json').read_text())),
        )
    return piper

def spoken_notation(text):
    text = text.replace('O-O-O', 'castle queenside').replace('O-O', 'castle kingside')
    names = {'K':'king', 'Q':'queen', 'R':'rook', 'B':'bishop', 'N':'knight'}
    def expand(m):
        role, origin, capture, file, rank, promotion, check = m.groups()
        if not role and not origin and not capture and not promotion and not check:
            return file + ' ' + rank
        result = (names.get(role, 'pawn') + ' ')
        if origin:
            result += 'from ' + ' '.join(origin) + ' '
        result += ('takes ' if capture else 'to ') + file + ' ' + rank
        if promotion:
            result += ', promoting to a ' + names[promotion]
        if check:
            result += ', ' + ('checkmate' if check == '#' else 'check')
        return result
    return re.sub(r'(?<!\w)([KQRBN])?([a-h1-8]{0,2})(x?)([a-h])([1-8])(?:=([QRBN]))?([+#]?)(?!\w)', expand, text)

def normalize(text):
    return ' '.join(text.split())

def synthesize(text, selected):
    engine = 'piper' if selected == 'piper' else 'kokoro'
    if engine == 'kokoro' and not pathlib.Path(str(pathlib.Path(os.environ.get('KNIGHTLIGHT_RESOURCES', '.')) / 'vendor/kokoro/onnx/model_quantized.onnx')).exists():
        engine, selected = 'piper', 'piper'
    spoken = spoken_notation(text).replace('—', ', ').replace('…', '. ')
    if engine == 'kokoro':
        samples, rate = load_kokoro().create(spoken, voice=selected, speed=1.0, lang='en-gb' if selected.startswith('b') else 'en-us')
        if not np.isfinite(samples).all() or len(samples) == 0:
            raise ValueError('Voice produced invalid audio')
        return samples, rate, engine, selected
    chunks = list(load_piper().synthesize(spoken, syn_config=SynthesisConfig(length_scale=1.0, noise_scale=0.6, noise_w_scale=0.75)))
    return np.concatenate([chunk.audio_float_array for chunk in chunks]), chunks[0].sample_rate, engine, selected

def cached_clip(text, selected, force_warm=False):
    text = normalize(text)
    if selected not in ('af_heart', 'am_michael', 'bf_emma', 'piper'):
        raise ValueError('Unknown installed voice')
    if selected != 'piper' and not pathlib.Path(str(pathlib.Path(os.environ.get('KNIGHTLIGHT_RESOURCES', '.')) / 'vendor/kokoro/onnx/model_quantized.onnx')).exists():
        selected = 'piper'
    engine = 'piper' if selected == 'piper' else 'kokoro'
    name = hashlib.sha256(('coach-v5:'+selected+':'+text).encode()).hexdigest()+'.wav'
    path = root/name
    started = time.monotonic()
    cached = path.exists() and path.stat().st_size > 44
    if not cached or force_warm:
        samples, rate, engine, selected = synthesize(text, selected)
        if not cached:
            temp = root/(name+'.tmp')
            sf.write(str(temp), samples, rate, format='WAV', subtype='PCM_16')
            temp.replace(path)
            cached_files = sorted(root.glob('*.wav'), key=lambda p: p.stat().st_mtime)
            for old in cached_files[:-448] if len(cached_files) > 512 else []:
                if old != path: old.unlink(missing_ok=True)
    elif path.exists():
        path.touch()
    return {'url':'/audio/'+name, 'engine':engine, 'voice':selected, 'cached':cached, 'synthesis_ms':round((time.monotonic()-started)*1000)}

def main():
    for raw in sys.stdin:
        try:
            request = json.loads(raw)
            selected = request.get('voice', 'af_heart')
            if request.get('warm'):
                result = cached_clip('Your move.', selected, force_warm=True)
            else:
                result = cached_clip(request['text'][:1800], selected)
            print(json.dumps(result), flush=True)
        except Exception as exc:
            print(json.dumps({'error':str(exc)}), flush=True)

if __name__ == '__main__':
    main()
