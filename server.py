# Local server for "Okinawa Memory Palace"
# - Serves this folder like `python -m http.server`
# - POST /open-chrome {"url": "..."} opens an allowed URL in Google Chrome
import json
import os
import subprocess
import sys
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

    def do_POST(self):
        if self.path != '/open-chrome':
            return self.send_error(404)
        origin = self.headers.get('Origin', '')
        if origin not in (f'http://localhost:{PORT}', f'http://127.0.0.1:{PORT}'):
            return self.send_error(403)
        try:
            length = min(int(self.headers.get('Content-Length', 0)), 4096)
            url = json.loads(self.rfile.read(length) or b'{}').get('url', '')
        except (ValueError, AttributeError):
            return self.send_error(400)
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
