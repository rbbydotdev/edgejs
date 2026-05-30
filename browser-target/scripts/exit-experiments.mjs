#!/usr/bin/env node
// exit-experiments — small standalone probes to test which exit mechanism
// actually works in our wasm env.
//
// For each experiment: launch wasm via Vite+Playwright, run the inline
// script, observe stdout for OBSERVATION_WINDOW_MS, report the timeline
// + sentinel + exit code if any.
//
// Unlike node-corpus-runner.mjs, this:
//   - does NOT inject any process.exit deferral
//   - does NOT wrap in try/catch around a require()
//   - just runs the experiment script raw via -e
//   - observes for a fixed window regardless of completion
//
// Use this to answer questions like:
//   - Does the loop naturally drain when there's no pending work?
//   - Does process.on('beforeExit') fire?
//   - Does setTimeout fire reliably?
//   - What does process._getActiveHandles() show at different times?

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VITE_PORT,
  startVite,
  launchChromium,
  killProc,
} from "./_runner-common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
void repoRoot;

// How long to watch each experiment's stdout before reporting and moving
// on.  Longer than any reasonable wasm exit; if the loop has truly
// drained, _start will exit well within this window.
const OBSERVATION_WINDOW_MS = 8_000;

const EXPERIMENTS = [
  {
    name: "01-noop-sync",
    description: "Empty-ish sync script, no async. Does _start exit?",
    script: `
      console.log('[exp] start');
      console.log('[exp] end');
    `,
  },
  {
    name: "02-noop-sync-with-explicit-exit",
    description: "Sync + process.exit(0) — control: should always exit",
    script: `
      console.log('[exp] start');
      console.log('[exp] end');
      process.exit(0);
    `,
  },
  {
    name: "03-setTimeout-50ms-natural",
    description: "Set a 50ms timer, no exit. Loop should drain after timer.",
    script: `
      console.log('[exp] start @' + Date.now());
      setTimeout(() => console.log('[exp] timer fired @' + Date.now()), 50);
      console.log('[exp] sync done @' + Date.now());
    `,
  },
  {
    name: "04-beforeExit-listener-only",
    description: "Just register beforeExit, no exit. Does beforeExit fire?",
    script: `
      console.log('[exp] start @' + Date.now());
      process.on('beforeExit', (code) => {
        console.log('[exp] beforeExit fired with code=' + code + ' @' + Date.now());
      });
      console.log('[exp] sync done @' + Date.now());
    `,
  },
  {
    name: "05-beforeExit-then-exit",
    description: "beforeExit handler calls process.exit. Does it work?",
    script: `
      console.log('[exp] start @' + Date.now());
      process.on('beforeExit', (code) => {
        console.log('[exp] beforeExit fired @' + Date.now() + ', calling process.exit');
        process.exit(0);
      });
      console.log('[exp] sync done @' + Date.now());
    `,
  },
  {
    name: "06-activeHandles-snapshot",
    description: "What does _getActiveHandles return at various points?",
    script: `
      console.log('[exp] start @' + Date.now());
      function snap(label) {
        const h = process._getActiveHandles ? process._getActiveHandles().length : 'undefined';
        const r = process._getActiveRequests ? process._getActiveRequests().length : 'undefined';
        console.log('[exp] ' + label + ' handles=' + h + ' requests=' + r + ' @' + Date.now());
      }
      snap('initial');
      const t1 = setTimeout(() => { snap('inside-50ms-timer'); }, 50);
      snap('after-setTimeout');
      process.on('beforeExit', () => { snap('beforeExit'); });
      console.log('[exp] sync done @' + Date.now());
    `,
  },
  {
    name: "07-setTimeout-chain",
    description: "Chained setTimeouts — does each fire?",
    script: `
      console.log('[exp] start @' + Date.now());
      setTimeout(() => {
        console.log('[exp] tick 1 @' + Date.now());
        setTimeout(() => {
          console.log('[exp] tick 2 @' + Date.now());
          setTimeout(() => {
            console.log('[exp] tick 3 @' + Date.now());
          }, 10);
        }, 10);
      }, 10);
      console.log('[exp] sync done @' + Date.now());
    `,
  },
  {
    name: "08-nextTick-only",
    description: "Just process.nextTick — does it run after sync?",
    script: `
      console.log('[exp] start @' + Date.now());
      process.nextTick(() => console.log('[exp] nextTick fired @' + Date.now()));
      Promise.resolve().then(() => console.log('[exp] microtask fired @' + Date.now()));
      console.log('[exp] sync done @' + Date.now());
    `,
  },
  {
    name: "09-async-promise-chain",
    description: "Async function with .then chain. Does it complete?",
    script: `
      console.log('[exp] start @' + Date.now());
      (async () => {
        console.log('[exp] async body @' + Date.now());
        await new Promise(r => setTimeout(r, 20));
        console.log('[exp] after await @' + Date.now());
        await new Promise(r => setTimeout(r, 20));
        console.log('[exp] after await 2 @' + Date.now());
      })();
      console.log('[exp] sync done @' + Date.now());
    `,
  },
  {
    name: "11-unref-watchdog",
    description: "setTimeout(5s).unref(). Should NOT keep loop alive.",
    script: `
      console.log('[exp] start @' + Date.now());
      var t = setTimeout(() => console.log('[exp] WATCHDOG fired @' + Date.now()), 5000);
      console.log('[exp] setTimeout typeof:', typeof t);
      console.log('[exp] setTimeout has unref?', typeof (t && t.unref));
      if (t && t.unref) { t.unref(); console.log('[exp] unref called @' + Date.now()); }
      else { console.log('[exp] NO UNREF AVAILABLE'); }
      console.log('[exp] sync done @' + Date.now());
    `,
  },
  {
    name: "12-driver-shape-no-test",
    description: "Mimic corpus driver setup (uncaught/unhandled + exitCode + unref'd watchdog). No actual test require.",
    script: `
      console.log('[exp] start @' + Date.now());
      process.on('uncaughtException', (e) => console.log('[exp] uncaught', e.message));
      process.on('unhandledRejection', (r) => console.log('[exp] unhandled', String(r)));
      try {
        console.log('[exp] body would run here @' + Date.now());
        process.exitCode = 0;
        var wd = setTimeout(() => process.exit(process.exitCode | 0), 5000);
        if (wd && wd.unref) wd.unref();
        console.log('[exp] watchdog armed @' + Date.now());
      } catch (e) { console.log('[exp] caught:', e.message); process.exitCode = 1; }
      console.log('[exp] sync done @' + Date.now());
    `,
  },
  {
    name: "13-driver-with-require-test",
    description: "Full driver shape + require an actual test file (test-buffer-bigint64).",
    script: `
      console.log('[exp] start @' + Date.now());
      process.on('uncaughtException', (e) => console.log('[exp] uncaught', e.message));
      process.on('unhandledRejection', (r) => console.log('[exp] unhandled', String(r)));
      try {
        console.log('[exp] requiring test @' + Date.now());
        require('/test/parallel/test-buffer-bigint64.js');
        console.log('[exp] require returned @' + Date.now());
        process.exitCode = 0;
        var wd = setTimeout(() => process.exit(process.exitCode | 0), 5000);
        if (wd && wd.unref) wd.unref();
        console.log('[exp] watchdog armed @' + Date.now());
      } catch (e) { console.log('[exp] caught:', e.message); process.exitCode = 1; }
      console.log('[exp] sync done @' + Date.now());
    `,
  },
  {
    name: "14-exact-corpus-driver",
    description: "Verbatim corpus driver shape with require + log markers.",
    script: `
      function isExitSignal(e) {
        return e && typeof e === 'object' && e.__edgeExitSignal === true;
      }
      var exitArmed = false;
      function deferredExit(code) {
        if (exitArmed) return;
        exitArmed = true;
        process.exitCode = code | 0;
        var watchdog = setTimeout(function() { process.exit(process.exitCode | 0); }, 5000);
        if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
      }
      process.on('uncaughtException', (e) => {
        if (isExitSignal(e)) return;
        console.log('[CORPUS-RESULT] FAIL uncaught: ' + (e && e.stack || String(e)).split('\\n')[0]);
        deferredExit(1);
      });
      process.on('unhandledRejection', (r) => {
        console.log('[CORPUS-RESULT] FAIL unhandled: ' + (r && r.stack || String(r)).split('\\n')[0]);
        deferredExit(1);
      });
      console.log('[exp] start @' + Date.now());
      try {
        require('/test/parallel/test-buffer-bigint64.js');
        console.log('[CORPUS-RESULT] PASS-PROVISIONAL');
        console.log('[exp] require complete @' + Date.now());
        deferredExit(0);
      } catch (e) {
        if (isExitSignal(e)) {
          var code = (e.code | 0);
          if (code === 0) {
            console.log('[CORPUS-RESULT] PASS');
            process.exit(0);
          }
          console.log('[CORPUS-RESULT] FAIL exit=' + code);
          process.exit(code);
        }
        console.log('[CORPUS-RESULT] FAIL sync: ' + (e && e.stack || String(e)).split('\\n')[0]);
        deferredExit(1);
      }
      console.log('[exp] after-try @' + Date.now());
    `,
  },
  {
    name: "10-stream-close-event",
    description: "Real stream test pattern — does 'close' fire?",
    script: `
      const stream = require('stream');
      console.log('[exp] start @' + Date.now());
      const r = new stream.Readable({
        autoDestroy: true,
        read() { this.push('hi'); this.push(null); }
      });
      r.on('end', () => console.log('[exp] end @' + Date.now()));
      r.on('close', () => console.log('[exp] close @' + Date.now()));
      r.resume();
      console.log('[exp] sync done @' + Date.now());
    `,
  },
];

async function runExperiment(browser, exp) {
  const url = `http://localhost:${VITE_PORT}/?script=${encodeURIComponent(exp.script)}`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const startedAt = Date.now();
  let sentinelTime = null;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    // Watch for OBSERVATION_WINDOW_MS, then capture all output.
    const deadline = Date.now() + OBSERVATION_WINDOW_MS;
    while (Date.now() < deadline) {
      const seen = await page.evaluate(() => {
        const log = document.getElementById("log");
        if (!log) return null;
        const m = log.innerText.match(/_start ran (\d+) ms \((exit=(-?\d+)|THREW|returned)\)/);
        return m ? { sentinel: m[0] } : null;
      });
      if (seen && !sentinelTime) {
        sentinelTime = Date.now() - startedAt;
        // Give a tiny bit more time for tail output, then break
        await new Promise(r => setTimeout(r, 300));
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    const out = await page.evaluate(() => {
      const log = document.getElementById("log");
      if (!log) return { stdout: "", sentinel: "no sentinel" };
      const outs = Array.from(log.querySelectorAll(".lvl-out")).map(e => e.innerText).join("");
      const m = log.innerText.match(/_start ran (\d+) ms \((exit=(-?\d+)|THREW|returned)\)/);
      return { stdout: outs, sentinel: m ? m[0] : "NO SENTINEL (loop never exited)" };
    });
    return {
      name: exp.name,
      sentinelAt: sentinelTime ? `${sentinelTime}ms` : "never",
      sentinel: out.sentinel,
      stdout: out.stdout,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  console.log(`exit-experiments: ${EXPERIMENTS.length} probe(s); observation window = ${OBSERVATION_WINDOW_MS}ms`);
  let viteProc = null;
  let browser = null;
  try {
    viteProc = await startVite();
    browser = await launchChromium();
    for (const exp of EXPERIMENTS) {
      console.log(`\n=========================================`);
      console.log(`EXPERIMENT: ${exp.name}`);
      console.log(`PURPOSE:    ${exp.description}`);
      console.log(`=========================================`);
      const result = await runExperiment(browser, exp);
      console.log(`SENTINEL:   ${result.sentinel}  (at ${result.sentinelAt})`);
      console.log(`STDOUT:`);
      const lines = result.stdout.split("\n").filter(l => l.includes("[exp]"));
      for (const line of lines) console.log(`  ${line}`);
      if (lines.length === 0) console.log("  (no [exp] output captured)");
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteProc) killProc(viteProc);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
