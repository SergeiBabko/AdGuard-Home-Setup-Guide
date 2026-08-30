#!/usr/bin/env node
"use strict";
//
// A static server for the project root. No dependencies, no configuration.
//
//   npm run dev:serve            serve on http://localhost:8080
//   npm run dev:serve -- 3000    serve on another port
//
// The page itself works fine opened as a file://, and it is meant to - there is
// deliberately no `npm start`. This exists for the dev harnesses that do NOT work that
// way: dev/contrast.html and dev/kitchen-sink.html read
// document.styleSheets[].cssRules to discover tokens from the real stylesheets, and over
// file:// Chrome treats every stylesheet as cross-origin and makes cssRules throw. The
// harness then renders perfectly while finding zero tokens, which looks like a bug in the
// token file rather than a bug in how you opened it.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const port = Number(process.argv[2]) || 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    // path.join alone would let "../" climb out of ROOT. Resolving and then checking the
    // prefix is what keeps a request for /../../.ssh/id_rsa inside the project.
    const target = path.resolve(ROOT, "." + url);
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end("403 outside project root");
      return;
    }

    let file = target;
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("404 " + url);
      return;
    }

    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("404 " + url);
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        // Editing a stylesheet and hard-reloading should show the edit, always.
        "Cache-Control": "no-store",
      });
      res.end(body);
    });
  })
  .listen(port, () => {
    console.log(`serving ${ROOT}`);
    console.log(`  http://localhost:${port}/`);
    console.log(`  http://localhost:${port}/dev/kitchen-sink.html`);
    console.log(`  http://localhost:${port}/dev/contrast.html`);
    console.log(`  http://localhost:${port}/dev/row-states.html`);
    console.log("\nCtrl+C to stop");
  });
