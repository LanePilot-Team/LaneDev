from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re, sys, webbrowser, urllib.request

ROOT=Path(__file__).resolve().parent/'網站'
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def end_headers(self):
        self.send_header('X-Nanzih-Release', '1')
        super().end_headers()
    def send_head(self):
        path=Path(self.translate_path(self.path)); header=self.headers.get('Range')
        if not header or not path.is_file(): return super().send_head()
        m=re.fullmatch(r'bytes=(\d*)-(\d*)',header.strip()); size=path.stat().st_size
        if not m or not (m[1] or m[2]): self.send_error(416); return None
        start=int(m[1]) if m[1] else max(0,size-int(m[2])); end=min(int(m[2]),size-1) if m[1] and m[2] else size-1
        if start>=size or start>end:
            self.send_response(416);self.send_header('Content-Range',f'bytes */{size}');self.end_headers();return None
        f=path.open('rb');f.seek(start);self._remaining=end-start+1
        self.send_response(206);self.send_header('Content-Type',self.guess_type(str(path)));self.send_header('Accept-Ranges','bytes');self.send_header('Content-Range',f'bytes {start}-{end}/{size}');self.send_header('Content-Length',str(self._remaining));self.end_headers();return f
    def copyfile(self,source,outputfile):
        if not hasattr(self,'_remaining'): return super().copyfile(source,outputfile)
        remaining=self._remaining;del self._remaining
        while remaining:
            data=source.read(min(1024*1024,remaining))
            if not data: break
            try: outputfile.write(data)
            except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError): break
            remaining-=len(data)

if __name__=='__main__':
    url='http://127.0.0.1:18765/'
    try: server=ThreadingHTTPServer(('127.0.0.1',18765),Handler)
    except OSError as error:
        try:
            with urllib.request.urlopen(url + 'routes.json', timeout=2) as response:
                ready = response.headers.get('X-Nanzih-Release') == '1'
        except OSError:
            ready = False
        if ready and '--open' in sys.argv:
            webbrowser.open(url)
            raise SystemExit(0)
        raise SystemExit(f'無法啟動本機網站（18765）。{error}')
    if '--open' in sys.argv: webbrowser.open(url)
    print('本機離線網站：'+url+'，關閉此視窗會停止網站。',flush=True)
    server.serve_forever()
