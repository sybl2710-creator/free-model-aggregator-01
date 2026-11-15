#!/usr/bin/env python3
"""Run the read-only kit env directly, export state, and invoke its scorer."""
import argparse, json, os, pathlib, socket, subprocess, tempfile, time

parser = argparse.ArgumentParser()
parser.add_argument('trial', type=int)
parser.add_argument('--kit', required=True)
parser.add_argument('--output')
opts = parser.parse_args()
kit = pathlib.Path(opts.kit).resolve()
root = pathlib.Path(__file__).resolve().parents[1]
trial = kit / 'practice' / f'trial-{opts.trial}'
output = pathlib.Path(opts.output or tempfile.mkdtemp(prefix=f'aggregator-trial-{opts.trial}-')).resolve()
output.mkdir(parents=True, exist_ok=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
env = dict(os.environ, MAKEFUN_ENV_DATA_DIR=str(trial / 'input/env'), MAKEFUN_STATE_DIR=str(output), MAKEFUN_ENV_HOST='127.0.0.1', MAKEFUN_ENV_PORT=str(port))
with open(output / 'env.log', 'w') as log:
    server = subprocess.Popen(['node', str(kit / 'program/env/server.mjs')], env=env, stdout=log, stderr=log)
    try:
        for _ in range(100):
            if (output / 'ready').exists(): break
            if server.poll() is not None: raise RuntimeError('env failed; see env.log')
            time.sleep(.05)
        botenv = dict(os.environ, MAKEFUN_ENV_URL=f'http://127.0.0.1:{port}', MAKEFUN_PROMPT_FILE=str(trial / 'input/prompt.txt'))
        listed = subprocess.run(['node', 'main.ts', '--list'], cwd=root, env=botenv, capture_output=True, text=True, check=True)
        (output / 'catalog.json').write_text(listed.stdout)
        with open(output / 'entry.log', 'w') as botlog:
            subprocess.run(['node', 'main.ts'], cwd=root, env=botenv, stdout=botlog, stderr=botlog, check=True, timeout=170)
    finally:
        server.terminate()
        server.wait(timeout=10)
scoreenv = dict(os.environ, MAKEFUN_OUTPUT_DIR=str(output / 'export'), MAKEFUN_REFERENCE_DIR=str(trial / 'reference'), MAKEFUN_SCORES_DIR=str(output / 'scores'))
subprocess.run(['node', str(kit / 'program/scorer/score.mjs')], env=scoreenv, check=True)
statefile = next((output / 'export').glob('*.json'))
state = json.loads(statefile.read_text())
assert json.loads((output / 'catalog.json').read_text()) == state['catalog'], '--list differs from registration'
print(f'Output: {output}; --list matches registered catalog')
for r in state['requests']:
    if not r['valid']:
        print(r['id'], r['error'], [(c['name'], c['detail']) for c in r['checks'] if not c['pass']])
