# Local server for "Okinawa Memory Palace"
# - Serves this folder like `python -m http.server`
# - POST /open-chrome {"url": "..."} opens an allowed URL in Google Chrome
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
HOST = '127.0.0.1'  # this PC only
ROOT = os.path.dirname(os.path.abspath(__file__))

# Only these sites may be opened (so other web pages can't misuse this)
ALLOWED_PREFIXES = ('https://claude.ai/',)

CHROME_PATHS = [
    os.path.expandvars(r'%ProgramFiles%\Google\Chrome\Application\chrome.exe'),
    os.path.expandvars(r'%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe'),
    os.path.expandvars(r'%LocalAppData%\Google\Chrome\Application\chrome.exe'),
]


def find_claude():
    # Claude Code CLI (uses the user's Claude plan, no extra charge)
    home = os.path.expanduser('~')
    cands = [os.path.join(home, '.local', 'bin', 'claude.exe')]
    cands += sorted(glob.glob(os.path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-*',
                                           'resources', 'native-binary', 'claude.exe')), reverse=True)
    for c in cands:
        if os.path.isfile(c):
            return c
    return shutil.which('claude')


DRAW_LOCK = threading.Lock()
DRAW_TIMEOUT = 240  # seconds


def draw_prompt(scene, label, note='', base=''):
    text_rule = (f'「{label}」という文字を、大きく読みやすく絵の中に入れる' if label
                 else '場面を表す短い言葉を、大きく読みやすく絵の中に入れる')
    if base:
        head = ['下の SVG のイラストを、注文どおりに直してください。注文にないところは、なるべくそのまま残してください。',
                '直した SVG のコードだけを出力してください。説明や前置き、コードブロックの記号は書かず、<svg から </svg> までだけを書いてください。',
                '', f'場面：{scene}', f'注文：{note or "もっと印象に残るように"}', '', '直す前の SVG：', base]
    else:
        head = ['次の場面を、記憶に残るステッカー風のイラストにして、SVG のコードだけを出力してください。',
                '説明や前置き、コードブロックの記号は書かず、<svg から </svg> までだけを書いてください。',
                '', f'場面：{scene}'] + ([f'注文（いちばん優先する）：{note}'] if note else [])
    return '\n'.join(head + [
        '',
        '条件：',
        '- viewBox="0 0 512 512"、xmlns を付ける',
        '- 背景は透明（背景の四角は描かない）',
        '- 太い輪郭線、鮮やかな色、大げさで動きのある印象的な表現',
        f'- {text_rule}',
        '- 外部の画像・フォント・スクリプトは使わない（文字は普通のフォントでよい）',
    ])


def draw_with_claude(scene, label, note='', base=''):
    exe = find_claude()
    if not exe:
        return None, 'Claude Code が見つかりません'
    if not DRAW_LOCK.acquire(blocking=False):
        return None, 'いま別の絵を描いています。終わってからもう一度押してください'
    try:
        r = subprocess.run(
            [exe, '-p', '--model', 'sonnet', '--tools', ''],
            input=draw_prompt(scene, label, note, base).encode('utf-8'),
            capture_output=True, timeout=DRAW_TIMEOUT, cwd=tempfile.gettempdir(),
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        out = r.stdout.decode('utf-8', errors='replace')
        m = re.search(r'<svg[\s\S]*</svg>', out, re.I)
        if not m:
            err = (r.stderr.decode('utf-8', errors='replace') or out).strip()[:200]
            return None, '絵を受け取れませんでした' + (f'（{err}）' if err else '')
        return m.group(0), None
    except subprocess.TimeoutExpired:
        return None, '時間がかかりすぎたので止めました。もう一度押してください'
    finally:
        DRAW_LOCK.release()


def open_in_chrome(url):
    for path in CHROME_PATHS:
        if os.path.isfile(path):
            subprocess.Popen([path, url])
            return True
    webbrowser.open(url)  # Chrome not found: default browser
    return False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Always check for new files (so design/code updates show up right away)
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in ('/open-chrome', '/draw'):
            return self.send_error(404)
        origin = self.headers.get('Origin', '')
        if origin not in (f'http://localhost:{PORT}', f'http://127.0.0.1:{PORT}'):
            return self.send_error(403)
        try:
            length = min(int(self.headers.get('Content-Length', 0)), 262144)  # 256 KB (the SVG to fix fits)
            data = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, AttributeError):
            return self.send_error(400)
        if not isinstance(data, dict):
            return self.send_error(400)

        if self.path == '/draw':
            # Ask Claude Code to draw the scene as SVG
            scene, label = data.get('scene', ''), data.get('label', '')
            note, base = data.get('note', ''), data.get('base', '')
            if not all(isinstance(v, str) for v in (scene, label, note, base)) or not scene.strip():
                return self.send_error(400)
            if base and not re.match(r'\s*<svg[\s\S]*</svg>\s*$', base, re.I):
                return self.send_error(400)
            svg, err = draw_with_claude(scene.strip()[:1000], label.strip()[:100],
                                        note.strip()[:1000], base.strip()[:200000])
            return self.send_json({'svg': svg} if svg else {'error': err})

        url = data.get('url', '')
        if not isinstance(url, str) or not url.startswith(ALLOWED_PREFIXES):
            return self.send_error(400)
        chrome = open_in_chrome(url)
        body = json.dumps({'ok': True, 'chrome': chrome}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    print(f'Serving http://localhost:{PORT}/')
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
