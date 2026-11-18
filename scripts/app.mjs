import { build, context } from 'esbuild';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const entryPoints = { index: 'src/main.ts' };
const target = 'es2022';
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const command = process.argv[2];

if (command === 'build') {
  await buildApp();
} else if (command === 'dev') {
  await serveDevelopmentApp();
} else if (command === 'preview') {
  await serveStaticApp(resolve(projectRoot, 'dist'), 4173);
} else {
  throw new Error('Use "build", "dev", or "preview".');
}

async function buildApp() {
  const outputDirectory = resolve(projectRoot, 'dist');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await copyPublicFiles(outputDirectory);

  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints,
    bundle: true,
    minify: true,
    metafile: true,
    outdir: join(outputDirectory, 'assets'),
    entryNames: 'index-[hash]',
    target,
    logLevel: 'info',
  });
  await writeRenderedIndex(outputDirectory, result.metafile, false);
}

async function serveDevelopmentApp() {
  const outputDirectory = resolve(projectRoot, '.reposend-dev');
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await copyPublicFiles(outputDirectory);

  const reloadClients = new Set();
  const appContext = await context({
    absWorkingDir: projectRoot,
    entryPoints,
    bundle: true,
    outdir: join(outputDirectory, 'assets'),
    entryNames: 'index',
    sourcemap: 'inline',
    target,
    plugins: [{
      name: 'reload-after-rebuild',
      setup(buildContext) {
        buildContext.onEnd((result) => {
          if (result.errors.length === 0) {
            for (const client of reloadClients) client.write('data: reload\n\n');
          }
        });
      },
    }],
  });

  await appContext.rebuild();
  await appContext.watch();
  await writeRenderedIndex(outputDirectory, null, true);
  await writeFile(
    join(outputDirectory, 'dev-reload.js'),
    "new EventSource('./__dev-events').onmessage = ({ data }) => { if (data === 'reload') location.reload(); };\n",
  );
  const server = createStaticServer(outputDirectory, reloadClients);
  await listen(server, process.env.HOST || '127.0.0.1', Number(process.env.PORT) || 5173);
  console.log(`RepoSend dev server running at http://${process.env.HOST || '127.0.0.1'}:${Number(process.env.PORT) || 5173}/`);

  const close = async () => {
    await appContext.dispose();
    server.close();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

async function serveStaticApp(rootDirectory, defaultPort) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT) || defaultPort;
  const server = createStaticServer(rootDirectory);
  await listen(server, host, port);
  console.log(`RepoSend preview server running at http://${host}:${port}/`);
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}

async function writeRenderedIndex(outputDirectory, metafile, isDevelopment) {
  let scriptHref = './assets/index.js';
  let stylesheetHref = './assets/index.css';

  if (metafile) {
    const scriptOutput = Object.entries(metafile.outputs)
      .find(([, output]) => output.entryPoint === 'src/main.ts')?.[0];
    if (!scriptOutput) throw new Error('The app build did not produce its JavaScript entry point.');

    const stylesheetOutput = metafile.outputs[scriptOutput].cssBundle;
    if (!stylesheetOutput) throw new Error('The app build did not produce its stylesheet.');
    scriptHref = relativeAssetHref(outputDirectory, scriptOutput);
    stylesheetHref = relativeAssetHref(outputDirectory, stylesheetOutput);
  }

  let html = await readFile(join(projectRoot, 'index.html'), 'utf8');
  html = html
    .replace('__APP_JS__', scriptHref)
    .replace('__APP_CSS__', stylesheetHref)
    .replace('<!-- DEV_RELOAD -->', isDevelopment ? '<script type="module" src="./dev-reload.js"></script>' : '');

  if (html.includes('__APP_JS__') || html.includes('__APP_CSS__')) {
    throw new Error('The app HTML is missing an asset placeholder.');
  }
  await writeFile(join(outputDirectory, 'index.html'), html);
}

function relativeAssetHref(outputDirectory, outputPath) {
  const path = relative(outputDirectory, resolve(projectRoot, outputPath));
  return `./${path.split(sep).join('/')}`;
}

async function copyPublicFiles(outputDirectory) {
  const publicDirectory = resolve(projectRoot, 'public');
  for (const entry of await readdir(publicDirectory, { withFileTypes: true })) {
    await cp(join(publicDirectory, entry.name), join(outputDirectory, entry.name), { recursive: true });
  }
}

function createStaticServer(rootDirectory, reloadClients = new Set()) {
  const root = resolve(rootDirectory);
  return createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end('Invalid URL');
      return;
    }

    if (pathname === '/__dev-events' && root.endsWith('.reposend-dev')) {
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      });
      response.write('retry: 1000\n\n');
      reloadClients.add(response);
      response.on('close', () => reloadClients.delete(response));
      return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const contents = await readFile(filePath);
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Length': contents.length,
        'Content-Type': mimeTypes.get(extname(filePath)) || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR') {
        response.writeHead(500).end('Could not read the requested file.');
        return;
      }
      response.writeHead(404).end('Not found');
    }
  });
}

function listen(server, host, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
}
