#!/usr/bin/env python3
"""Silent comparison of CPU thread counts / optional isolated CUDA runtime.

Use vendor/speech-env/bin/python scripts/benchmark-speech.py --threads 4.
For the isolated CUDA experiment use --gpu after installing its runtime in
vendor/speech-gpu, then prepend that directory to PYTHONPATH. No WAV playback.
"""
import argparse
import json
import time
from pathlib import Path
import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--threads', type=int, choices=range(1, 9), default=4)
parser.add_argument('--gpu', action='store_true')
args = parser.parse_args()
if args.gpu:
    ort.preload_dlls(directory='')
options = ort.SessionOptions()
options.intra_op_num_threads = args.threads
options.inter_op_num_threads = 1
options.log_severity_level = 3
start = time.perf_counter()
session = ort.InferenceSession('vendor/kokoro/onnx/model_quantized.onnx', sess_options=options, providers=['CUDAExecutionProvider', 'CPUExecutionProvider'] if args.gpu else ['CPUExecutionProvider'])
if args.gpu and 'CUDAExecutionProvider' not in session.get_providers():
    raise RuntimeError('GPU request fell back to CPU; do not label this a CUDA benchmark')

class CommunitySession:
    def __getattr__(self, name):
        return getattr(session, name)
    def run(self, outputs, feed):
        feed['speed'] = np.asarray(feed['speed'], dtype=np.float32)
        result = session.run(outputs, feed)
        result[0] = result[0].reshape(-1)
        return result

kokoro = Kokoro.from_session(CommunitySession(), 'vendor/kokoro/voices.npz')
print(json.dumps({'threads': args.threads, 'providers': session.get_providers(), 'load_ms': round((time.perf_counter() - start) * 1000)}), flush=True)
texts = ['Your move.', 'A better option would have been to develop your knight.', 'Your queen is active, but your king needs care. Before moving, look for checks, captures, and threats.']
for text in texts * 2:
    start = time.perf_counter()
    audio, rate = kokoro.create(text, voice='af_heart')
    print(json.dumps({'threads': args.threads, 'gpu': args.gpu, 'text': text, 'wall_ms': round((time.perf_counter() - start) * 1000), 'audio_seconds': round(len(audio) / rate, 2)}), flush=True)
