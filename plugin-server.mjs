// Static file server for the built MetaExtension bundle.
//
// Only Rancher's plugin controller reads from here, over the docker network, and it then
// re-serves the files to browsers from its own origin under /v1/uiplugins. Nothing about
// this needs to be reachable from a browser.
import http from 'http';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const port = Number(process.env.PLUGIN_SERVER_PORT || 4500);

const types = {
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain'
};

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, rel);

  console.log(new Date().toISOString(), req.method, rel);

  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);

    return res.end('not found');
  }

  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`plugin server on ${ port }, root ${ root }`));
