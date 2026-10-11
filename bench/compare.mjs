// Compare two proj4 bundles for identical output and speed.
// node bench/compare.mjs <base.js> <head.js> [--browser]
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
const browser = args.includes('--browser');
const perfArg = args.find(a => a.startsWith('--perf='));
const [basePath, headPath] = args.filter(a => !a.startsWith('--')).map(p => resolve(p));
if (!basePath || !headPath) {
  console.error('usage: node bench/compare.mjs <base.js> <head.js> [--browser]');
  process.exit(1);
}

// Runs in Node and in the browser page, so it must stay self-contained.
// Without `only`, checks output for all pairs; with `only`, times that one pair.
// Timing each pair in a fresh process or page keeps call sites as monomorphic
// as in an app that uses a single pair.
function suite(libs, mode, only) {
  var DEFS = {
    UTM33N: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs',
    UTM33S: '+proj=utm +zone=33 +south +datum=WGS84 +units=m +no_defs',
    ED50_UTM31: '+proj=utm +zone=31 +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +units=m +no_defs',
    RD: '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
    LAEA: '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
    MERC: '+proj=merc +datum=WGS84',
    ROBIN: '+proj=robin +datum=WGS84',
    PARIS: '+proj=longlat +ellps=WGS84 +pm=paris',
    GEOCENT: '+proj=geocent +datum=WGS84'
  };
  // [from, to, lon/lat box the source points are generated in]
  var PAIRS = [
    ['UTM33N', 'WGS84', [12, 0, 18, 84]],
    ['WGS84', 'UTM33N', [12, 0, 18, 84]],
    ['UTM33S', 'WGS84', [12, -80, 18, 0]],
    ['ED50_UTM31', 'WGS84', [0, 36, 6, 70]],
    ['RD', 'WGS84', [3.3, 50.7, 7.3, 53.6]],
    ['RD', 'EPSG:3857', [3.3, 50.7, 7.3, 53.6]],
    ['LAEA', 'WGS84', [-10, 35, 30, 70]],
    ['WGS84', 'EPSG:3857', [-180, -85, 180, 85]],
    ['EPSG:3857', 'WGS84', [-180, -85, 180, 85]],
    ['UTM33N', 'MERC', [12, 0, 18, 84]],
    ['WGS84', 'ROBIN', [-180, -85, 180, 85]],
    ['WGS84', 'PARIS', [-180, -85, 180, 85]],
    ['WGS84', 'GEOCENT', [-180, -85, 180, 85]]
  ];
  var SHAPES = [
    ['[x,y]', function (x, y) { return [x, y]; }],
    ['[x,y,z]', function (x, y) { return [x, y, 5]; }],
    ['[x,y,z,m]', function (x, y) { return [x, y, 5, 7]; }],
    ['{x,y}', function (x, y) { return { x: x, y: y }; }],
    ['{x,y,z}', function (x, y) { return { x: x, y: y, z: 5 }; }],
    ['{x,y,m}', function (x, y) { return { x: x, y: y, m: 7 }; }],
    ['{x,y,z:undefined}', function (x, y) { return { x: x, y: y, z: undefined }; }],
    ['{x,y,foo}', function (x, y) { return { x: x, y: y, foo: 1 }; }]
  ];
  var N = 10000;
  libs.forEach(function (p) {
    for (var k in DEFS) {
      p.defs(k, DEFS[k]);
    }
  });
  var base = libs[0], head = libs[1];

  function sourcePoints(pair) {
    var box = pair[2], side = Math.sqrt(N), pts = [];
    var toSrc = base('WGS84', pair[0]);
    for (var i = 0; i < side; i++) {
      for (var j = 0; j < side; j++) {
        var ll = [box[0] + (box[2] - box[0]) * (i + 0.5) / side, box[1] + (box[3] - box[1]) * (j + 0.5) / side];
        pts.push(pair[0] === 'WGS84' ? ll : toSrc.forward(ll));
      }
    }
    return pts;
  }
  function shape(r) {
    return Array.isArray(r)
      ? 'array:' + r.length
      : Object.keys(r).sort().map(function (k) {
          return k + ':' + (r[k] === undefined ? 'undefined' : typeof r[k]);
        }).join(',');
  }
  function diff(a, b) {
    return typeof a === 'number' && a !== b ? Math.abs(a - b) : 0;
  }

  var correctness = (only === undefined ? PAIRS : []).map(function (pair) {
    var pts = sourcePoints(pair);
    var cb = base(pair[0], pair[1]), ch = head(pair[0], pair[1]);
    var pb = [base.Proj(pair[0]), base.Proj(pair[1])], ph = [head.Proj(pair[0]), head.Proj(pair[1])];
    var calls = 0, shapeDiffs = 0, maxXY = 0, maxZ = 0, first = '';
    var apis = [
      ['forward', function (c, p, pt) { return c.forward(pt); }],
      ['transform', function (c, p, pt) { return (c === cb ? base : head).transform(p[0], p[1], pt); }]
    ];
    for (var s = 0; s < SHAPES.length; s++) {
      for (var a = 0; a < apis.length; a++) {
        if (apis[a][0] === 'transform' && SHAPES[s][0].charAt(0) === '[') {
          continue;
        }
        for (var i = 0; i < pts.length; i += 7) {
          var rb = apis[a][1](cb, pb, SHAPES[s][1](pts[i][0], pts[i][1]));
          var rh = apis[a][1](ch, ph, SHAPES[s][1](pts[i][0], pts[i][1]));
          calls++;
          if (shape(rb) !== shape(rh)) {
            shapeDiffs++;
            first = first || apis[a][0] + ' ' + SHAPES[s][0] + ': ' + shape(rb) + ' vs ' + shape(rh);
            continue;
          }
          var arr = Array.isArray(rb);
          maxXY = Math.max(maxXY, diff(arr ? rb[0] : rb.x, arr ? rh[0] : rh.x), diff(arr ? rb[1] : rb.y, arr ? rh[1] : rh.y));
          maxZ = Math.max(maxZ, diff(arr ? rb[2] : rb.z, arr ? rh[2] : rh.z));
        }
      }
    }
    return { pair: pair[0] + ' -> ' + pair[1], calls: calls, shapeDiffs: shapeDiffs, maxXY: maxXY, maxZ: maxZ, unit: /WGS84|PARIS/.test(pair[1]) ? '°' : ' m', first: first };
  });

  var sink = 0;
  function loop(conv, pts) {
    return function () {
      for (var i = 0; i < pts.length; i++) {
        sink += conv.forward(pts[i])[0];
      }
    };
  }
  var performance_ = (only === undefined ? [] : [PAIRS[only]]).map(function (pair) {
    var pts = sourcePoints(pair);
    var fns = [loop(base(pair[0], pair[1]), pts), loop(head(pair[0], pair[1]), pts)];
    var samples = [[], []];
    for (var w = 0; w < 10; w++) {
      fns[0]();
      fns[1]();
    }
    // Alternate base and head so drift affects both equally
    for (var r = 0; r < 31; r++) {
      for (var f = 0; f < 2; f++) {
        var t0 = performance.now();
        fns[f]();
        samples[f].push(performance.now() - t0);
      }
    }
    var med = samples.map(function (s) {
      s.sort(function (a, b) {
        return a - b;
      });
      return s[15];
    });
    return { pair: pair[0] + ' -> ' + pair[1], base: med[0], head: med[1] };
  });
  return { mode: mode, pairs: PAIRS.length, correctness: correctness, performance: performance_, sink: sink };
}

function report(r) {
  if (r.correctness.length) {
    console.log('\n### Output: base vs head (' + r.mode + ')\n');
    console.log('| pair | calls | shape diffs | max abs diff x/y | max abs diff z |');
    console.log('|---|---:|---:|---:|---:|');
    var fmt = function (d, unit) {
      return d === 0 ? '0' : d.toExponential(1) + unit;
    };
    r.correctness.forEach(function (c) {
      console.log('| ' + c.pair + ' | ' + c.calls + ' | ' + c.shapeDiffs + ' | ' + fmt(c.maxXY, c.unit) + ' | ' + fmt(c.maxZ, ' m') + ' |');
      if (c.first) {
        console.log('|  ↳ ' + c.first + ' | | | | |');
      }
    });
  }
  if (!r.performance.length) {
    return;
  }
  console.log('\n### Speed: 10k points via converter.forward, median of 31, each pair in a fresh ' + (r.mode.startsWith('Node') ? 'process' : 'page') + ' (' + r.mode + ')\n');
  console.log('| pair | base ms | head ms | speedup |');
  console.log('|---|---:|---:|---:|');
  r.performance.forEach(function (p) {
    console.log('| ' + p.pair + ' | ' + p.base.toFixed(2) + ' | ' + p.head.toFixed(2) + ' | ' + (p.base / p.head).toFixed(2) + '× |');
  });
}

const require = createRequire(import.meta.url);
const libs = () => [require(basePath), require(headPath)];
const nodeMode = 'Node ' + process.version;
if (perfArg) {
  process.stdout.write(JSON.stringify(suite(libs(), nodeMode, +perfArg.slice(7))));
  process.exit(0);
}

const checked = suite(libs(), nodeMode);
report(checked);
const perPair = (run) => {
  const out = [];
  for (let i = 0; i < checked.pairs; i++) {
    out.push(run(i));
  }
  return out;
};
const merge = results => Promise.all(results).then(rs => ({
  mode: rs[0].mode, correctness: [], performance: rs.flatMap(r => r.performance)
}));

report(await merge(perPair(i => JSON.parse(execFileSync(process.execPath, [import.meta.filename, basePath, headPath, '--perf=' + i], { encoding: 'utf8' })))));

if (browser) {
  const { chromium } = await import('playwright');
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const runPage = async (i) => {
    const context = await b.newContext();
    const page = await context.newPage();
    for (const [file, name] of [[basePath, 'proj4Base'], [headPath, 'proj4Head']]) {
      await page.addScriptTag({ content: readFileSync(file, 'utf8') + '\nwindow.' + name + ' = proj4;' });
    }
    const r = await page.evaluate('(' + suite.toString() + ')([proj4Base, proj4Head], "Chromium " + navigator.userAgent.match(/Chrome\\/([\\d.]+)/)[1], ' + i + ')');
    await context.close();
    return r;
  };
  const results = [];
  for (let i = 0; i < checked.pairs; i++) {
    results.push(await runPage(i));
  }
  report(await merge(results));
  await b.close();
}
