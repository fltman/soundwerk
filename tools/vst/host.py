# Runs VST3 and Audio Unit plugins for Soundwerk. A plugin is native code, so it lives out here in a
# process of its own: when one crashes it takes this down, and the rack plays on without it.
#
# The server starts one of these per open page and talks over stdin and stdout, in frames: four
# bytes of length, then a byte for the kind. 0 is JSON, 1 a block of audio, 2 JSON and a whole file.
#
# Only this thread may open a plugin's window, and a window keeps it until it closes, so everything
# that isn't audio queues up here and audio has the reader thread to itself. Pedalboard is GPLv3, so
# this file is too; the rest of Soundwerk only talks to it through a pipe.
import base64
import json
import os
import queue
import signal
import struct
import sys
import threading

import numpy as np
import pedalboard

JSON, BLOCK, FILE = 0, 1, 2
HEAD = struct.Struct('<BxHHxxI')   # kind, frames, events, plugin: 12 bytes, so the samples are aligned
EVENT = struct.Struct('<HBBB')     # frame in this block, then the MIDI bytes
LENGTH = struct.Struct('<I')

ROOTS = [os.path.abspath(r) for r in sys.argv[1:]]
STAND_INS = {'builtin:Reverb': pedalboard.Reverb, 'builtin:Delay': pedalboard.Delay, 'builtin:Distortion': pedalboard.Distortion}   # no plugin file needed: the tests use these

plugins = {}
jobs = queue.Queue()
writing = threading.Lock()
window = None   # the Event that closes the open plugin window


def send(kind, *parts):
    size = 1 + sum(len(p) for p in parts)
    with writing:
        out = sys.stdout.buffer
        out.write(LENGTH.pack(size))
        out.write(bytes([kind]))
        for p in parts:
            out.write(p)
        out.flush()


def answer(ref, **fields):
    send(JSON, json.dumps({'ref': ref, **fields}).encode())


def allowed(path):
    return path in STAND_INS and os.environ.get('SOUNDWERK_VST_STAND_INS') or any(os.path.abspath(path).startswith(root + os.sep) for root in ROOTS)


def load(path):
    if not allowed(path):
        raise ValueError(f'{path} is not in a plugin folder')
    if path in STAND_INS:
        return STAND_INS[path]()
    try:
        return pedalboard.load_plugin(path)
    except RuntimeError:   # a bundle with several plugins in it asks which one
        kind = pedalboard.VST3Plugin if path.endswith('.vst3') else pedalboard.AudioUnitPlugin
        return pedalboard.load_plugin(path, plugin_name=kind.get_plugin_names_for_file(path)[0])


def has(plugin, attribute):
    return getattr(plugin, attribute, False)


def restore(plugin, state):
    if state and hasattr(plugin, 'raw_state'):
        plugin.raw_state = base64.b64decode(state)


def state_of(plugin):
    return base64.b64encode(plugin.raw_state).decode() if hasattr(plugin, 'raw_state') else None


def describe(plugin, path):
    return {
        'name': getattr(plugin, 'name', None) or path.rsplit('/', 1)[-1].rsplit('.', 1)[0],
        'instrument': bool(has(plugin, 'is_instrument')),
        'latency': int(has(plugin, 'reported_latency_samples') or 0),
        'window': hasattr(plugin, 'show_editor'),
    }


def open_plugin(job):
    plugin = load(job['path'])
    restore(plugin, job.get('state'))
    plugins[job['id']] = {'plugin': plugin, 'sr': job['sr'], 'instrument': bool(has(plugin, 'is_instrument'))}
    return describe(plugin, job['path'])


def show_window(job):
    global window
    entry = plugins[job['id']]
    window = threading.Event()
    entry['plugin'].show_editor(window)
    window = None
    return {'state': state_of(entry['plugin'])}


# A whole file through a fresh copy of the plugin. What comes out is as long as what went in and
# lines up with it, so a sample's beat stays on its grid; a tail longer than that is cut.
def print_file(job, samples):
    plugin = load(job['path'])
    restore(plugin, job.get('state'))
    if has(plugin, 'is_instrument'):
        raise ValueError('that is an instrument: only an effect can print a file')
    frames = len(samples) // 2
    room = int(has(plugin, 'reported_latency_samples') or 0)
    audio = np.zeros((2, frames + room), dtype=np.float32)
    audio[0, :frames] = samples[:frames]
    audio[1, :frames] = samples[frames:]
    out = plugin.process(audio, job['sr'], reset=True)
    got = np.zeros((2, frames), dtype=np.float32)
    usable = out[:, :frames]
    got[:, :usable.shape[1]] = usable
    return got


def run(job, samples=None):
    ref = job.get('ref')
    try:
        if job['op'] == 'open':
            answer(ref, **open_plugin(job))
        elif job['op'] == 'close':
            plugins.pop(job['id'], None)
            answer(ref)
        elif job['op'] == 'window':
            answer(ref, **show_window(job))
        elif job['op'] == 'state':
            answer(ref, state=state_of(plugins[job['id']]['plugin']))
        elif job['op'] == 'crash' and os.environ.get('SOUNDWERK_VST_STAND_INS'):
            os.kill(os.getpid(), signal.SIGKILL)   # what a plugin going wrong looks like from outside
        elif job['op'] == 'print':
            head = json.dumps({'ref': ref}).encode()
            send(FILE, LENGTH.pack(len(head)), head, print_file(job, samples).tobytes())
    except Exception as e:   # one that won't load must not end the others
        answer(ref, error=str(e)[:300])


# In a block of audio: an instrument takes the notes, an effect the samples. Either has its
# own idea of how much to hand back while it fills up, so short answers get padded in front.
def process(body):
    _, frames, count, which = HEAD.unpack_from(body)
    entry = plugins.get(which)
    samples = np.frombuffer(body, np.float32, frames * 2, HEAD.size).reshape(2, frames)
    if entry is None:
        return bytes(body)
    sr, plugin = entry['sr'], entry['plugin']
    if entry['instrument']:
        at = HEAD.size + frames * 8
        notes = [EVENT.unpack_from(body, at + k * EVENT.size) for k in range(count)]
        out = plugin.process([(bytes(n[1:]), n[0] / sr) for n in notes], frames / sr, sr, num_channels=2, buffer_size=frames, reset=False)
    else:
        out = plugin.process(samples, sr, buffer_size=frames, reset=False)
    if out.shape[1] < frames:
        out = np.concatenate([np.zeros((2, frames - out.shape[1]), dtype=np.float32), out], axis=1)
    return body[:HEAD.size] + out[:, :frames].astype(np.float32).tobytes() + body[HEAD.size + frames * 8:]


def read_all(size):
    chunks = []
    while size:
        chunk = os.read(0, min(size, 1 << 20))
        if not chunk:
            os._exit(0)   # the server went away, and the page with it
        chunks.append(chunk)
        size -= len(chunk)
    return b''.join(chunks)


def reader():
    global window
    while True:
        body = read_all(LENGTH.unpack(read_all(4))[0])
        if body[0] == BLOCK:
            try:
                send(BLOCK, process(body)[1:])
            except Exception as e:
                send(JSON, json.dumps({'problem': str(e)[:300]}).encode())
                send(BLOCK, body[1:])
            continue
        if window:   # a window would hold up whatever was just asked for
            window.set()
        if body[0] == JSON:
            jobs.put((json.loads(body[1:]), None))
        else:
            size = LENGTH.unpack_from(body, 1)[0]
            jobs.put((json.loads(body[5:5 + size]), np.frombuffer(body[5 + size:], np.float32)))


threading.Thread(target=reader, daemon=True).start()
send(JSON, json.dumps({'ready': True}).encode())
while True:
    run(*jobs.get())
