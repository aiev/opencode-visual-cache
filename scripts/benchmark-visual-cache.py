#!/usr/bin/env python3
"""Linux real-TUI synthetic A/B fixture; no prompts or global config changes.

Requires a built checkout, an unmodified 1.7.5 V2 bundle, and an existing idle
session. Only the fixture is loaded through process-local CLI configuration.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def drain(master):
    # Do not retain or print real rendered session history. Answer probes only.
    while select.select([master], [], [], 0)[0]:
        try:
            data = os.read(master, 1048576)
        except (BlockingIOError, OSError):
            return
        if not data:
            return
        for probe, response in [
            (b'\x1b[6n', b'\x1b[1;1R'),
            (b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b[0c', b'\x1b[?1;2c'),
            (b'\x1b[>c', b'\x1b[>0;276;0c'), (b'\x1b[>0c', b'\x1b[>0;276;0c'),
        ]:
            if probe in data:
                os.write(master, response)
        for code, color in [(10, b'rgb:eeee/eeee/eeee'), (11, b'rgb:1111/1111/1111')]:
            if f'\x1b]{code};?'.encode() in data:
                os.write(master, f'\x1b]{code};'.encode() + color + b'\x1b\\')


def run(args, fixture, bundle, report, mode):
    env = {**os.environ, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
           'OPENCODE_CLI_CONFIG_CONTENT': json.dumps({'plugins': ['-opencode-visual-cache', str(fixture)], 'tabs': {'mode': 'off'}}),
           'VISUAL_CACHE_FIXTURE_BUNDLE': str(bundle), 'VISUAL_CACHE_FIXTURE_REPORT': str(report),
           'VISUAL_CACHE_FIXTURE_MODE': mode}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 52, 180, 0, 0))
    os.set_blocking(master, False)
    process = subprocess.Popen(['opencode', '--session', args.session], cwd=args.directory, env=env,
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    started = time.monotonic()
    profile_started = None
    logs = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'opencode/log'
    try:
        while time.monotonic() - started < 30:
            if process.poll() is not None:
                raise RuntimeError(f'{mode} TUI exited: {process.returncode}')
            drain(master)
            if profile_started is None and time.monotonic() - started >= 1:
                profile_started = time.time()
                os.kill(process.pid, signal.SIGPROF)
            profiles = [p for p in logs.glob(f'cpu-{process.pid}-*.cpuprofile')
                        if profile_started is not None and p.stat().st_mtime >= profile_started - 1]
            if report.exists() and profiles:
                try:
                    result = json.loads(report.read_text())
                    profile = json.loads(max(profiles, key=lambda p: p.stat().st_mtime).read_text())
                except (OSError, ValueError):
                    time.sleep(.02)
                    continue
                if result.get('complete'):
                    if not result.get('success'):
                        raise RuntimeError(result)
                    urls = [node['callFrame'].get('url', '') for node in profile['nodes']]
                    assert any(bundle.as_uri() in url for url in urls), 'Expected test bundle absent from profile'
                    result['bundleProfileVerified'] = True
                    return result
            time.sleep(.02)
        raise RuntimeError(f'{mode} fixture or profile timed out')
    finally:
        # Terminate only the temporary client, never the service or other TUIs.
        if process.poll() is None:
            os.write(master, b'\x03')
            deadline = time.monotonic() + 5
            while process.poll() is None and time.monotonic() < deadline:
                drain(master); time.sleep(.02)
            if process.poll() is None:
                process.terminate(); process.wait(timeout=5)
        os.close(master)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', required=True, help='Existing idle session; verified before startup')
    parser.add_argument('--directory', required=True, type=Path, help='Directory associated with that session')
    parser.add_argument('--baseline', required=True, type=Path, help='Unmodified 1.7.5 dist/v2.js')
    parser.add_argument('--output', required=True, type=Path, help='New evidence directory, preferably under /tmp/opencode')
    parser.add_argument('--rounds', type=int, default=3)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    proposed = root / 'dist/v2.js'
    if args.rounds < 1 or args.output.exists() or not args.baseline.is_file() or not proposed.is_file():
        parser.error('Build first, provide an existing baseline, positive rounds and a new output directory')
    checked = subprocess.run(['opencode', 'api', 'get', f'/api/session/{args.session}'], cwd=args.directory,
                             capture_output=True, text=True, timeout=30)
    if checked.returncode or json.loads(checked.stdout).get('data', {}).get('id') != args.session:
        raise SystemExit('Existing session verification failed; no TUI started')
    config = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'opencode/cli.json'
    config_before = config.read_bytes() if config.exists() else None
    baseline_hash, proposed_hash = digest(args.baseline), digest(proposed)
    args.output = args.output.resolve()
    args.output.mkdir(parents=True)
    fixture = args.output / 'fixture'
    fixture.mkdir()
    (fixture / 'package.json').write_text(json.dumps({'name': 'fixture-visual-cache-comparison', 'type': 'module', 'exports': {'./tui': './tui.js'}}))
    (fixture / 'tui.js').write_bytes((root / 'scripts/fixtures/visual-cache.mjs').read_bytes())
    bundles = {}
    for mode, original in [('baseline', args.baseline), ('optimized', proposed)]:
        bundle = args.output / f'{mode}.mjs'
        bundle.write_bytes(original.read_bytes() + b'\n// Test-only exports; original bundle above is unchanged.\nexport { TokenCachePanel, createPanelApi, createPanelSignals, mapTheme };\n')
        bundles[mode] = bundle
    evidence = {'method': {'opencodeVersion': subprocess.check_output(['opencode', '--version'], text=True).strip(),
                          'baselineBundleSHA256': baseline_hash, 'proposedBundleSHA256': proposed_hash,
                          'roundsPerVariant': args.rounds, 'promptsSent': 0, 'terminalColumns': 180, 'terminalRows': 52,
                          'onlyFixtureLoaded': True, 'storage': 'host memory', 'balancePollingMounted': False}, 'runs': []}
    for index in range(args.rounds):
        order = ['baseline', 'optimized'] if index % 2 == 0 else ['optimized', 'baseline']
        for mode in order:
            result = run(args, fixture, bundles[mode], args.output / f'{index + 1}-{mode}.json', mode)
            evidence['runs'].append({'round': index + 1, 'mode': mode, 'fixture': result})
            (args.output / 'result.json').write_text(json.dumps(evidence, indent=2) + '\n')
            print(json.dumps({'round': index + 1, 'mode': mode, 'success': True}), flush=True)
    assert (config.read_bytes() if config.exists() else None) == config_before, 'Global CLI config changed'
    assert digest(args.baseline) == baseline_hash and digest(proposed) == proposed_hash, 'A bundle changed'
    print(f'RESULT_FILE {args.output / "result.json"}')


if __name__ == '__main__':
    main()
