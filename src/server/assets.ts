import { file, build } from "bun";

/**
 * Static files.
 *
 * The server keeps a fixed table of public paths. It never joins a path from
 * a request with a directory name, so a request cannot escape to another file.
 */

export interface Asset {
  readonly body: ArrayBuffer;
  readonly type: string;
  readonly etag: string;
  readonly cache: string;
}

const CLIENT_DIR = new URL("../client/", import.meta.url).pathname;
const OUT_DIR = new URL("../../dist/", import.meta.url).pathname;

/** Public path -> file on disk. This table is the complete allow list. */
const SOURCES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["/", `${CLIENT_DIR}index.html`, "text/html; charset=utf-8", "no-cache"],
  ["/styles.css", `${CLIENT_DIR}styles.css`, "text/css; charset=utf-8", "no-cache"],
  ["/favicon.svg", `${CLIENT_DIR}favicon.svg`, "image/svg+xml", "max-age=86400"],
  ["/app.js", `${OUT_DIR}main.js`, "text/javascript; charset=utf-8", "no-cache"],
];

/** Compiles the browser code into dist/main.js. */
export async function buildClient(minify: boolean): Promise<void> {
  const result = await build({
    entrypoints: [`${CLIENT_DIR}main.ts`],
    outdir: OUT_DIR,
    target: "browser",
    format: "esm",
    minify,
    sourcemap: minify ? "none" : "linked",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("client build failed");
  }
}

export async function loadAssets(): Promise<Map<string, Asset>> {
  const assets = new Map<string, Asset>();
  for (const [route, path, type, cache] of SOURCES) {
    const body = await file(path).arrayBuffer();
    assets.set(route, {
      body,
      type,
      etag: `"${Bun.hash(new Uint8Array(body)).toString(16)}"`,
      cache,
    });
  }
  return assets;
}
