/*! Binnacle v0.1.0 | vanilla, no deps, classic script (works from file://). Global: Binnacle.
    A draggable, voice-reactive orb drawn on a 2D canvas. Load binnacle.css with it. Canvas 2D rather than WebGL, because WebGL is often
    blocked or software-rendered on locked-down workstations.

      var orb = Binnacle.mount({ id: 'assistant', look: 'ring', theme: 'aurora', size: 260 });
      Binnacle.voice.set('speaking', 0.3, 'Turnover is ready.');   state, level 0..1 (linear RMS), optional caption
      Binnacle.voice.fromAudio(audioElement);                      or take state and level from real playback

    Voice contract "fleet.voice/1": any page can drive every orb without importing this file:
      window.dispatchEvent(new CustomEvent('fleet:voice',
        { detail: { schema: 'fleet.voice/1', state: 'speaking', level: 0.3, text: 'optional caption' } }));
    See README.md for the full API. */
(function () {
  'use strict';
  if (window.Binnacle) return;

  var VERSION = '0.1.0';
  var SCHEMA = 'fleet.voice/1';
  var TAU = Math.PI * 2;

  /* What each state does. Every look reads these numbers, so a state means the same thing in all of them.
     rot: spin, rad/s. flow: ripple speed. amp: ripple height. glow: brightness.
     sonar, sweep, ring: strength of the shared overlays. talk: how far the audio level moves the orb. */
  var STATES = {
    idle:      { label: 'Standing by',         rot: 0.14, flow: 0.55, amp: 0.030, glow: 0.62, sonar: 0, sweep: 0, ring: 0, talk: 0 },
    listening: { label: 'Listening',           rot: 0.20, flow: 0.90, amp: 0.045, glow: 0.85, sonar: 1, sweep: 0, ring: 0, talk: 0.45 },
    thinking:  { label: 'Thinking',            rot: 0.95, flow: 1.70, amp: 0.040, glow: 0.78, sonar: 0, sweep: 1, ring: 0, talk: 0 },
    speaking:  { label: 'Speaking',            rot: 0.22, flow: 1.25, amp: 0.040, glow: 0.92, sonar: 0, sweep: 0, ring: 0, talk: 1 },
    approval:  { label: 'Needs your approval', rot: 0.04, flow: 0.25, amp: 0.018, glow: 0.70, sonar: 0, sweep: 0, ring: 1, talk: 0 }
  };
  var ALIASES = { working: 'thinking' };
  var PARAMS = ['rot', 'flow', 'amp', 'glow', 'sonar', 'sweep', 'ring', 'talk'];

  var THEMES = {
    aurora: {
      label: 'Aurora', backdrop: [5, 6, 15], accent: '#ffd27a', tint: '#2a3f8f',
      ring: ['#58cdff', '#5b63f0', '#8a3fd1', '#e0327f', '#ff4a3d', '#ffbe4d'],
      mesh: ['#19c8ff', '#2a4dff', '#7a2cff', '#ff2be0'],
      core: '#ffffff', arc: '#a9c8ff', haze: '#4a3cff', rim: '#6fb8ff', glass: '#7a3fe0'
    },
    brass: {
      label: 'Navy brass', backdrop: [6, 15, 36], accent: '#d9a84a', tint: '#243a6a',
      ring: ['#f2ead6', '#e6c98a', '#d9a84a', '#c0913a', '#d9a84a', '#f2ead6'],
      mesh: ['#f2ead6', '#d9a84a', '#8fa3c7', '#d9a84a'],
      core: '#fff6e0', arc: '#f0d08a', haze: '#b8862f', rim: '#d9a84a', glass: '#243a6a'
    },
    ember: {
      label: 'Ember', backdrop: [14, 6, 4], accent: '#ffd27a', tint: '#5a1f12',
      ring: ['#ffe29a', '#ffb23e', '#ff7a2f', '#e8391f', '#b3182e', '#ffb23e'],
      mesh: ['#ffd24d', '#ff7a2f', '#e8391f', '#ff3d7f'],
      core: '#fff3d6', arc: '#ffb56b', haze: '#d9381e', rim: '#ff8a3d', glass: '#7a1f14'
    },
    glacier: {
      label: 'Glacier', backdrop: [4, 12, 20], accent: '#e6f7ff', tint: '#1d4a66',
      ring: ['#ffffff', '#bdf0ff', '#63d2f5', '#2f9fe0', '#3a6fd8', '#bdf0ff'],
      mesh: ['#ffffff', '#7fe3ff', '#2f9fe0', '#5a7bff'],
      core: '#ffffff', arc: '#c4efff', haze: '#2f9fe0', rim: '#8fe6ff', glass: '#1d5a80'
    },
    reef: {
      label: 'Reef', backdrop: [3, 14, 13], accent: '#f4e27a', tint: '#0f5249',
      ring: ['#f4e27a', '#8ff0a4', '#2fe0b0', '#14b8c4', '#2f7fd8', '#8ff0a4'],
      mesh: ['#f4e27a', '#2fe0b0', '#14b8c4', '#2f7fd8'],
      core: '#f6fff0', arc: '#a4f5cf', haze: '#14a890', rim: '#3fe8c0', glass: '#0f5e58'
    }
  };

  /* Three steps down for slow machines: fewer particles, a lower pixel ratio, a lower frame rate. */
  var TIERS = [
    { scale: 1.00, dpr: 2.0, frameMs: 16 },
    { scale: 0.62, dpr: 1.5, frameMs: 24 },
    { scale: 0.38, dpr: 1.0, frameMs: 33 }
  ];
  var CALM_FRAME_MS = 33;     /* idle and approval do not need 60 fps */
  var INLINE_FRAME_MS = 50;   /* tiles in a gallery are previews */
  var DOCK_HALF = 118;        /* half the picker's width, plus a small gap */
  var SLOW_DRAW_MS = 11;      /* average draw time that triggers a step down */
  var SLOW_GAP_MS = 45;       /* average gap between frames that triggers a step down */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rgba(c, a) { return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + a + ')'; }
  function ramp(stops, t) {
    var f = clamp(t, 0, 1) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f));
    return mix(hex(stops[i]), hex(stops[i + 1]), f - i);
  }
  function rng(seed) {   /* small seeded generator, so a look is the same shape on every load */
    var s = seed >>> 0;
    return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /* Smooth ripple over the unit sphere: about -1..1. */
  function field(x, y, z, t) {
    return Math.sin(x * 2.3 + t * 1.1 + Math.sin(y * 1.7 + t * 0.6)) * 0.5 +
           Math.sin(y * 3.1 - t * 0.9 + z * 1.3) * 0.3 +
           Math.sin(z * 4.7 + t * 1.3 + x * 2.1) * 0.2;
  }
  /* Speech RMS sits around 0.05 to 0.3; the square root spreads that across the visible range. */
  function shape(level) { return Math.min(1, Math.sqrt(level) * 1.4); }

  /* ---- voice bus: one per page, shared by every orb ---- */
  var voice = (function () {
    var subs = [], simTimer = 0, simUntil = 0, simLevel = 0;
    var bus = { schema: SCHEMA, state: 'idle', level: 0, text: '' };

    function emit() { subs.slice().forEach(function (fn) { fn(bus); }); }

    /* set(state, level, text): unknown states are ignored, so a newer sender cannot break an older orb.
       A state change clears the caption unless the same call gives a new one. */
    bus.set = function (state, level, text) {
      var s = ALIASES[state] || state, changed = false;
      if (s != null && STATES[s] && s !== bus.state) { bus.state = s; bus.text = ''; changed = true; }
      if (typeof level === 'number' && isFinite(level)) bus.level = clamp(level, 0, 1);
      if (typeof text === 'string' && text !== bus.text) { bus.text = text; changed = true; }
      if (changed) emit();
      return bus;
    };
    bus.setLevel = function (level) { return bus.set(null, level); };
    bus.subscribe = function (fn) {
      subs.push(fn);
      return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
    };

    /* Stand-in for real audio: bursts the size of syllables with short gaps, in the same RMS range as speech.
       It only moves the level while the state is one that uses it. */
    bus.simulate = function (on) {
      clearInterval(simTimer); simTimer = 0;
      if (on === false) { bus.setLevel(0); return bus; }
      var target = 0, r = rng(20261106);
      simTimer = setInterval(function () {
        var now = performance.now();
        if (now > simUntil) {
          var pause = r() < 0.22;
          target = pause ? 0 : 0.05 + r() * r() * 0.32;
          simUntil = now + (pause ? 90 + r() * 190 : 70 + r() * 170);
        }
        simLevel += (target - simLevel) * 0.42;
        var gain = bus.state === 'speaking' ? 1 : bus.state === 'listening' ? 0.5 : 0;
        bus.setLevel(simLevel * gain);
      }, 33);
      return bus;
    };

    /* Real audio: read RMS from an AnalyserNode. Returns a function that stops it. */
    bus.fromAnalyser = function (analyser) {
      var buf = new Float32Array(analyser.fftSize);
      var timer = setInterval(function () {
        analyser.getFloatTimeDomainData(buf);
        var sum = 0; for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        bus.setLevel(Math.sqrt(sum / buf.length));
      }, 33);
      return function () { clearInterval(timer); bus.setLevel(0); };
    };

    /* Real audio from an <audio> element: speaking while it plays, idle when it stops. Sound still reaches
       the speakers. A cross-origin source needs CORS headers, or the browser mutes it. Returns a stop function. */
    var taps = typeof WeakMap === 'function' ? new WeakMap() : null;
    bus.fromAudio = function (el) {
      var tap = taps.get(el);
      if (!tap) {   /* an element can only be wired to Web Audio once */
        var AC = window.AudioContext || window.webkitAudioContext;
        var ctx = new AC(), analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaElementSource(el).connect(analyser);
        analyser.connect(ctx.destination);
        tap = { ctx: ctx, analyser: analyser };
        taps.set(el, tap);
      }
      var stopLevel = null;
      function onPlay() { tap.ctx.resume(); if (!stopLevel) stopLevel = bus.fromAnalyser(tap.analyser); bus.set('speaking'); }
      function onStop() { if (stopLevel) { stopLevel(); stopLevel = null; } bus.set('idle', 0); }
      el.addEventListener('play', onPlay); el.addEventListener('pause', onStop); el.addEventListener('ended', onStop);
      if (!el.paused) onPlay();
      return function () {
        el.removeEventListener('play', onPlay); el.removeEventListener('pause', onStop); el.removeEventListener('ended', onStop);
        onStop();
      };
    };

    window.addEventListener('fleet:voice', function (e) {
      var d = e.detail;
      if (d && (d.schema === undefined || d.schema === SCHEMA)) bus.set(d.state, d.level, d.text);
    });
    return bus;
  }());

  /* ---- dot batching: changing fillStyle per dot is the slow part, so sort dots by colour first ---- */
  var COLOURS = 24, BRIGHTS = 4;
  var ALPHAS = [0.30, 0.52, 0.82, 1];
  var SIZES = [0.8, 1.0, 1.25, 1.6];
  function Dots(max) {
    this.n = 0;
    this.x = new Float32Array(max); this.y = new Float32Array(max); this.s = new Float32Array(max);
    this.b = new Int16Array(max); this.order = new Int32Array(max);
    this.count = new Int32Array(COLOURS * BRIGHTS + 2);   /* every bucket, the white spark, and one for the prefix sum */
  }
  Dots.prototype.add = function (x, y, size, bucket) {
    var i = this.n++;
    this.x[i] = x; this.y[i] = y; this.s[i] = size; this.b[i] = bucket;
  };
  Dots.prototype.flush = function (ctx, lut, roundFrom) {
    var i, n = this.n, count = this.count, nb = lut.length;
    count.fill(0);
    for (i = 0; i < n; i++) count[this.b[i] + 1]++;
    for (i = 0; i < nb; i++) count[i + 1] += count[i];
    for (i = 0; i < n; i++) this.order[count[this.b[i]]++] = i;
    var p = 0;
    for (var b = 0; b < nb; b++) {
      var end = count[b];
      if (end === p) continue;
      ctx.fillStyle = lut[b];
      ctx.beginPath();
      var round = (b % BRIGHTS) >= roundFrom;
      for (; p < end; p++) {
        var k = this.order[p], x = this.x[k], y = this.y[k], s = this.s[k];
        if (round) { ctx.moveTo(x + s, y); ctx.arc(x, y, s, 0, TAU); } else ctx.rect(x - s, y - s, s * 2, s * 2);
      }
      ctx.fill();
    }
    this.n = 0;
  };
  function dotLut(stops, tint) {
    var lut = [], t = hex(tint);
    for (var c = 0; c < COLOURS; c++) {
      var col = ramp(stops, c / (COLOURS - 1));
      for (var b = 0; b < BRIGHTS; b++) lut.push(rgba(b === 0 ? mix(col, t, 0.5) : col, ALPHAS[b]));
    }
    return lut.concat('rgba(255,255,255,1)');   /* last entry: the odd white spark */
  }
  function bucket(colour, bright) {
    return clamp(colour * COLOURS | 0, 0, COLOURS - 1) * BRIGHTS + clamp(bright * BRIGHTS | 0, 0, BRIGHTS - 1);
  }
  function fibonacci(n) {
    var ux = new Float32Array(n), uy = new Float32Array(n), uz = new Float32Array(n), ga = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var y = 1 - (i + 0.5) * 2 / n, r = Math.sqrt(1 - y * y);
      ux[i] = Math.cos(ga * i) * r; uy[i] = y; uz[i] = Math.sin(ga * i) * r;
    }
    return { x: ux, y: uy, z: uz };
  }
  function glowSprite(rgb, px, peak) {
    var c = document.createElement('canvas'); c.width = c.height = px;
    var g = c.getContext('2d'), grad = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
    grad.addColorStop(0, rgba(rgb, peak)); grad.addColorStop(0.4, rgba(rgb, peak * 0.35)); grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad; g.fillRect(0, 0, px, px);
    return c;
  }

  /* ---- looks: build(v) sets up once per size or quality change; draw(v) runs each frame ----
     v: ctx, cx, cy, R, px (one CSS pixel), scale, pal, p (current params), drive (0..1), spin, phase, clock, sweepAngle */
  var LOOKS = {};

  /* Point ring: a see-through sphere of dots, with a bright rippling rim. */
  LOOKS.ring = {
    label: 'Point ring',
    build: function (v) {
      var r = rng(1373), n = Math.round(3000 * v.scale), m = Math.round(1000 * v.scale);
      this.sphere = fibonacci(n); this.n = n; this.m = m;
      this.seed = new Float32Array(n);
      for (var i = 0; i < n; i++) this.seed[i] = r();
      this.rimA = new Float32Array(m); this.rimJ = new Float32Array(m);
      for (var j = 0; j < m; j++) { this.rimA[j] = r() * TAU; this.rimJ[j] = r() * r() * (r() < 0.5 ? -1 : 1); }
      this.dots = new Dots(n + m);
      this.lut = dotLut(v.pal.ring, v.pal.tint);
    },
    draw: function (v) {
      var s = this.sphere, seed = this.seed, dots = this.dots, p = v.p, R = v.R, cx = v.cx, cy = v.cy, px = v.px;
      var cs = Math.cos(v.spin), sn = Math.sin(v.spin), ct = Math.cos(0.32), st = Math.sin(0.32);
      var t = v.phase, drive = v.drive, swell = 0.06 * drive, top = cy - R * 1.2, span = R * 2.4;
      var white = this.lut.length - 1, sweeping = p.sweep > 0.02, sonaring = p.sonar > 0.02;
      for (var i = 0; i < this.n; i++) {
        var ux = s.x[i], uy = s.y[i], uz = s.z[i];
        var x1 = ux * cs + uz * sn, z1 = uz * cs - ux * sn;
        var y2 = uy * ct - z1 * st, z2 = uy * st + z1 * ct;
        var rho2 = x1 * x1 + y2 * y2, e = rho2 * rho2 * rho2;   /* close to 1 on the silhouette */
        var n = field(ux, uy, uz, t), k = seed[i];
        var d = 1 + p.amp * n * (0.5 + e * 1.6) + swell + drive * 0.09 * n * (0.35 + e);
        if (k > 0.9) d += e * (k - 0.9) * (1.1 + drive * 3.2) * (0.5 + Math.abs(n));   /* loose dots off the rim */
        var sx = cx + x1 * R * d, sy = cy - y2 * R * d;
        var b = (0.16 + e * 0.85) * p.glow * (z2 < 0 ? 0.72 : 1) + drive * 0.16;
        if (sonaring) { var w = Math.sin(Math.sqrt(rho2) * 13 - v.clock * 5.5); if (w > 0) b += w * 0.42 * p.sonar; }
        if (sweeping) {
          var diff = (Math.atan2(y2, x1) - v.sweepAngle) % TAU; if (diff < 0) diff += TAU;
          b += Math.exp(-diff * 2.6) * 0.8 * p.sweep;
        }
        dots.add(sx, sy, px * (0.62 + b * 0.5) * SIZES[clamp(b * 4 | 0, 0, 3)], k > 0.9965 ? white : bucket((sy - top) / span, b));
      }
      for (var j = 0; j < this.m; j++) {
        var a = this.rimA[j], ca = Math.cos(a), sa = Math.sin(a), jit = this.rimJ[j];
        var rr = 1 + field(ca, sa, 0.3, t * 1.15) * (p.amp * 2.1 + drive * 0.11) + swell + jit * (0.035 + drive * 0.05);
        var rx = cx + ca * R * rr, ry = cy - sa * R * rr;
        var rb = (0.62 + (1 - Math.abs(jit)) * 0.5) * (0.5 + p.glow * 0.6);
        dots.add(rx, ry, px * (0.72 + rb * 0.34), bucket((ry - top) / span, rb));
      }
      dots.flush(v.ctx, this.lut, v.roundFrom);
    }
  };

  /* Flow mesh: a wavy wire sphere with dots on the knots and a loose halo of particles. */
  LOOKS.mesh = {
    label: 'Flow mesh',
    build: function (v) {
      var r = rng(12235);
      this.lat = Math.round(13 + 13 * v.scale); this.lon = Math.round(20 + 22 * v.scale);
      var n = this.lat * this.lon;
      this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
      this.seed = new Float32Array(n);
      for (var i = 0; i < n; i++) this.seed[i] = r();
      this.h = Math.round(300 * v.scale);
      this.ha = new Float32Array(this.h); this.hr = new Float32Array(this.h);
      for (var j = 0; j < this.h; j++) { this.ha[j] = r() * TAU; this.hr[j] = 1.12 + r() * r() * 0.26; }
      this.dots = new Dots(n + this.h);
      this.lut = dotLut(v.pal.mesh, v.pal.tint);
      this.colours = []; this.segs = [];
      for (var c = 0; c < 12; c++) {
        var col = ramp(v.pal.mesh, c / 11);
        this.colours.push(rgba(col, 0.16), rgba(mix(col, [255, 255, 255], 0.12), 0.46), rgba(mix(col, [255, 255, 255], 0.3), 0.85));
      }
      for (var q = 0; q < 36; q++) this.segs.push([]);
      var size = Math.round(v.R * 2);
      this.glowA = glowSprite(hex(v.pal.mesh[0]), size, 0.55);
      this.glowB = glowSprite(hex(v.pal.mesh[3]), size, 0.55);
    },
    draw: function (v) {
      var ctx = v.ctx, p = v.p, R = v.R, cx = v.cx, cy = v.cy, drive = v.drive, t = v.phase, px = v.px;
      var lat = this.lat, lon = this.lon, vx = this.vx, vy = this.vy, vz = this.vz, dots = this.dots;
      var cs = Math.cos(v.spin), sn = Math.sin(v.spin), ct = 1, st = 0;
      var amp = p.amp * 2.6 + 0.045 + drive * 0.17, swell = 0.05 * drive, i, j;

      ctx.globalAlpha = 0.28 + p.glow * 0.42 + drive * 0.3;
      var gs = R * 2 * (1 + drive * 0.05), wob = Math.sin(v.clock * 0.7) * R * 0.05;
      ctx.drawImage(this.glowA, cx - gs / 2 - R * 0.42 + wob, cy - gs / 2 - R * 0.28, gs, gs);
      ctx.drawImage(this.glowB, cx - gs / 2 + R * 0.42 - wob, cy - gs / 2 + R * 0.38, gs, gs);
      ctx.globalAlpha = 1;

      for (i = 0; i < lat; i++) {
        var th = (i + 1.5) / (lat + 2) * Math.PI, sy0 = Math.cos(th), sr = Math.sin(th);
        for (j = 0; j < lon; j++) {
          var ph = j / lon * TAU, ux = Math.cos(ph) * sr, uz = Math.sin(ph) * sr;
          var d = 1 + field(ux * 1.7, sy0 * 1.7, uz * 1.7, t) * amp + swell;
          var x1 = ux * cs + uz * sn, z1 = uz * cs - ux * sn;
          var y2 = sy0 * ct - z1 * st, z2 = sy0 * st + z1 * ct, k = i * lon + j;
          vx[k] = cx + x1 * R * d; vy[k] = cy - y2 * R * d; vz[k] = z2;
        }
      }
      var segs = this.segs, span = R * 3.2, base = cx - cy - R * 1.6;
      for (i = 0; i < 36; i++) segs[i].length = 0;
      for (i = 0; i < lat; i++) {
        for (j = 0; j < lon; j++) {
          var a = i * lon + j, right = i * lon + (j + 1) % lon, down = a + lon, z = vz[a];
          var c = clamp(((vx[a] - vy[a] - base) / span) * 12 | 0, 0, 11) * 3;
          var layer = z < 0 ? 0 : z < 0.5 ? 2 : 1;   /* the front edge is brightest, the centre softer, the far side faint */
          segs[c + layer].push(a, right);
          if (i < lat - 1) segs[c + layer].push(a, down);
        }
      }
      ctx.lineWidth = px * 0.7;
      for (i = 0; i < 36; i++) {
        var list = segs[i];
        if (!list.length) continue;
        ctx.strokeStyle = this.colours[i];
        ctx.beginPath();
        for (j = 0; j < list.length; j += 2) {
          var p0 = list[j], p1 = list[j + 1];
          ctx.moveTo(vx[p0], vy[p0]); ctx.lineTo(vx[p1], vy[p1]);
        }
        ctx.stroke();
      }
      var brightBase = 0.4 + p.glow * 0.3 + drive * 0.3, sw = p.sweep > 0.02;
      for (i = 0; i < lat * lon; i++) {
        if (this.seed[i] > 0.34 || vz[i] < 0) continue;
        var b = brightBase;
        if (sw) {
          var df = (Math.atan2(cy - vy[i], vx[i] - cx) - v.sweepAngle) % TAU; if (df < 0) df += TAU;
          b += Math.exp(-df * 2.6) * 0.6 * p.sweep;
        }
        dots.add(vx[i], vy[i], px * 0.9, bucket((vx[i] - vy[i] - base) / span, b));
      }
      for (i = 0; i < this.h; i++) {
        var ang = this.ha[i] + v.spin * 0.35, hr = this.hr[i] * (1 + drive * 0.1 + Math.sin(this.ha[i] * 7 + t) * 0.012);
        var hx = cx + Math.cos(ang) * R * hr, hy = cy - Math.sin(ang) * R * hr;
        dots.add(hx, hy, px * 0.8, bucket((hx - hy - base) / span, 0.45 + p.glow * 0.25));
      }
      dots.flush(ctx, this.lut, v.roundFrom);
    }
  };

  /* Lightning ball: arcs from a bright core inside a glass sphere. No shadowBlur: it is far too slow here. */
  LOOKS.lightning = {
    label: 'Lightning',
    build: function (v) {
      var pal = v.pal, R = v.R, size = Math.ceil(R * 2.7), c = size / 2;
      var rim = hex(pal.rim), glass = hex(pal.glass), haze = hex(pal.haze);
      this.max = Math.round(10 + 14 * v.scale);
      this.rand = rng(207);
      this.nextBolt = 0; this.path = null;
      this.angles = [];
      for (var i = 0; i < 40; i++) this.angles.push(this.rand() * TAU);

      /* the glass does not change from frame to frame, so paint it once */
      var layer = document.createElement('canvas'); layer.width = layer.height = size;
      var g = layer.getContext('2d');
      var body = g.createRadialGradient(c, c, R * 0.1, c, c, R);
      body.addColorStop(0, rgba(haze, 0.34)); body.addColorStop(0.6, rgba(glass, 0.2)); body.addColorStop(0.92, rgba(glass, 0.42)); body.addColorStop(1, rgba(rim, 0.5));
      g.fillStyle = body; g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
      for (var w = 7; w >= 1; w--) {
        g.strokeStyle = rgba(rim, w === 1 ? 0.95 : 0.075);
        g.lineWidth = w === 1 ? v.px * 1.6 : w * v.px * 2.6;
        g.beginPath(); g.arc(c, c, R, 0, TAU); g.stroke();
      }
      g.save();
      g.beginPath(); g.ellipse(c, c - R * 0.66, R * 0.56, R * 0.2, 0, 0, TAU); g.clip();
      var shine = g.createLinearGradient(0, c - R * 0.86, 0, c - R * 0.46);
      shine.addColorStop(0, 'rgba(255,255,255,.34)'); shine.addColorStop(1, 'rgba(255,255,255,.03)');
      g.fillStyle = shine; g.fillRect(0, 0, size, size);
      g.restore();
      g.strokeStyle = 'rgba(255,255,255,.2)'; g.lineWidth = R * 0.05; g.lineCap = 'round';
      g.beginPath(); g.arc(c, c, R * 0.86, Math.PI * 0.86, Math.PI * 1.08); g.stroke();
      g.beginPath(); g.arc(c, c, R * 0.88, Math.PI * 0.2, Math.PI * 0.3); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.72)';
      g.beginPath(); g.ellipse(c - R * 0.3, c + R * 0.8, R * 0.075, R * 0.028, 0.32, 0, TAU); g.fill();
      this.layer = layer; this.layerSize = size;

      this.coreSprite = glowSprite(hex(pal.arc), Math.round(R * 1.2), 0.95);
      this.whiteSprite = glowSprite(hex(pal.core), Math.round(R * 0.5), 1);
      this.colourWide = rgba(haze, 0.13); this.colourMid = rgba(hex(pal.arc), 0.42); this.colourCore = rgba(hex(pal.core), 0.92);
    },
    /* One jagged run from (x0, y0) to (x1, y1), bowed sideways so the arcs curl like plasma. */
    bolt: function (path, x0, y0, x1, y1, steps, jag, bow) {
      var r = this.rand, dx = x1 - x0, dy = y1 - y0, nx = -dy, ny = dx, x = x0, y = y0;
      path.moveTo(x0, y0);
      for (var i = 1; i <= steps; i++) {
        var s = i / steps, envelope = Math.sin(s * Math.PI), off = bow * envelope + (r() - 0.5) * jag * (0.3 + envelope);
        x = x0 + dx * s + nx * off; y = y0 + dy * s + ny * off;
        path.lineTo(x, y);
        if (i > 1 && i < steps - 1 && r() < 0.22) {
          var fork = new Path2D(), a = Math.atan2(dy, dx) + (r() - 0.5) * 1.6, len = Math.hypot(dx, dy) * 0.24;
          fork.moveTo(x, y);
          fork.lineTo(x + Math.cos(a) * len * 0.5 + (r() - 0.5) * len * 0.3, y + Math.sin(a) * len * 0.5 + (r() - 0.5) * len * 0.3);
          fork.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
          path.addPath(fork);
        }
      }
    },
    draw: function (v) {
      var ctx = v.ctx, p = v.p, R = v.R, cx = v.cx, cy = v.cy, drive = v.drive, px = v.px, r = this.rand;
      var size = this.layerSize * (1 + drive * 0.022);
      ctx.drawImage(this.layer, cx - size / 2, cy - size / 2, size, size);

      if (!this.path || v.clock >= this.nextBolt || v.still) {
        var want = Math.round(this.max * (0.34 + p.glow * 0.42 + drive * 0.6 + p.sonar * 0.1));
        var reach = 0.5 + p.glow * 0.3 + drive * 0.2 + p.sonar * 0.12, path = new Path2D();
        for (var i = 0; i < want; i++) {
          var a = this.angles[i % 40] + v.spin * (i % 2 ? 1 : -0.6) + (r() - 0.5) * 0.3;
          var len = R * Math.min(0.97, reach * (0.72 + r() * 0.36));
          this.bolt(path, cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len, 7, 0.1, (r() - 0.5) * 0.34);
        }
        this.path = path;
        this.nextBolt = v.clock + 0.05 + (1 - drive) * 0.075 + (1 - p.glow) * 0.08;
      }
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = this.colourWide; ctx.lineWidth = px * 5; ctx.stroke(this.path);
      ctx.strokeStyle = this.colourMid; ctx.lineWidth = px * 1.7; ctx.stroke(this.path);
      ctx.strokeStyle = this.colourCore; ctx.lineWidth = px * 0.7; ctx.stroke(this.path);

      var flick = v.still ? 1 : 0.92 + Math.sin(v.clock * 31) * 0.05 + Math.sin(v.clock * 17) * 0.03;
      var cs = R * (0.72 + p.glow * 0.3 + drive * 0.7) * flick, ws = R * (0.34 + drive * 0.42) * flick;
      ctx.globalAlpha = clamp(0.5 + p.glow * 0.5, 0, 1);
      ctx.drawImage(this.coreSprite, cx - cs / 2, cy - cs / 2, cs, cs);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.whiteSprite, cx - ws / 2, cy - ws / 2, ws, ws);
    }
  };

  /* Neon ribbons: bands of light wrapped round a sphere. 'lighter' blending makes them burn white where they cross. */
  LOOKS.ribbon = {
    label: 'Ribbons',
    build: function (v) {
      var r = rng(4242);
      this.bands = 5; this.lines = Math.round(3 + 4 * v.scale); this.steps = Math.round(44 + 36 * v.scale);
      this.x = new Float32Array(this.steps + 1); this.y = new Float32Array(this.steps + 1); this.z = new Float32Array(this.steps + 1);
      this.axes = []; this.front = []; this.back = [];
      for (var b = 0; b < this.bands; b++) {
        this.axes.push({ tilt: 0.5 + b * 0.62 + r() * 0.3, turn: r() * TAU, rate: 0.35 + r() * 0.5, waves: 2 + (b % 3), offset: r() * TAU });
        for (var l = 0; l < this.lines; l++) {
          var col = ramp(v.pal.mesh, (b + l / this.lines * 0.8) / this.bands);
          this.front.push(rgba(col, 0.72)); this.back.push(rgba(col, 0.15));
        }
      }
      this.haze = glowSprite(hex(v.pal.haze), Math.round(v.R * 2), 0.32);
      this.rim = rgba(hex(v.pal.rim), 0.42);
    },
    draw: function (v) {
      var ctx = v.ctx, p = v.p, R = v.R, cx = v.cx, cy = v.cy, drive = v.drive, t = v.phase, px = v.px;
      var steps = this.steps, X = this.x, Y = this.y, Z = this.z, lines = this.lines, scaleR = R * (1 + drive * 0.07), i;
      var hs = R * 2 * (1 + drive * 0.05);
      ctx.globalAlpha = 0.45 + p.glow * 0.5;
      ctx.drawImage(this.haze, cx - hs / 2, cy - hs / 2, hs, hs);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.rim; ctx.lineWidth = px * 1.1;
      ctx.beginPath(); ctx.arc(cx, cy, scaleR * 1.03, 0, TAU); ctx.stroke();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (var b = 0; b < this.bands; b++) {
        var ax = this.axes[b], turn = ax.turn + v.spin * ax.rate * (b % 2 ? 1 : -1), tilt = ax.tilt;
        /* two axes across the band and one along its normal */
        var ct = Math.cos(tilt), st = Math.sin(tilt), cu = Math.cos(turn), su = Math.sin(turn);
        var ax1 = cu, ay1 = su * st, az1 = su * ct, by1 = ct, bz1 = -st;
        var nx = -su, ny = cu * st, nz = cu * ct;
        var wave = 0.1 + p.amp * 2 + drive * 0.26;
        for (var l = 0; l < lines; l++) {
          var o = (l / (lines - 1) - 0.5) * (0.26 + drive * 0.2), rad = Math.sqrt(1 - o * o);
          for (i = 0; i <= steps; i++) {
            var th = i / steps * TAU, c = Math.cos(th), s = Math.sin(th);
            var w = o + Math.sin(th * ax.waves + t * 1.4 + ax.offset) * wave * (0.6 + 0.4 * Math.sin(th * 3 - t + l * 0.4));
            var k = 1 / Math.sqrt(rad * rad + w * w);   /* keep it on the sphere */
            X[i] = cx + (ax1 * c * rad + nx * w) * k * scaleR;
            Y[i] = cy - (ay1 * c * rad + by1 * s * rad + ny * w) * k * scaleR;
            Z[i] = az1 * c + bz1 * s + nz * w;
          }
          var at = b * lines + l;
          ctx.lineWidth = px * (0.7 + p.glow * 0.5 + drive * 0.9);
          ctx.strokeStyle = this.back[at]; this.trace(ctx, false);
          ctx.strokeStyle = this.front[at]; this.trace(ctx, true);
        }
      }
    },
    trace: function (ctx, front) {
      var X = this.x, Y = this.y, Z = this.z, pen = false;
      ctx.beginPath();
      for (var i = 0; i <= this.steps; i++) {
        if ((Z[i] >= 0) === front) { if (pen) ctx.lineTo(X[i], Y[i]); else { ctx.moveTo(X[i], Y[i]); pen = true; } } else pen = false;
      }
      ctx.stroke();
    }
  };

  /* Eclipse: a dark disc with a crescent of light turning round its rim, shedding dust. */
  LOOKS.eclipse = {
    label: 'Eclipse',
    build: function (v) {
      var r = rng(3700);
      this.arcs = 72;
      this.n = Math.round(1000 * v.scale);
      this.a = new Float32Array(this.n); this.k = new Float32Array(this.n);
      for (var i = 0; i < this.n; i++) { this.a[i] = r() * TAU; this.k[i] = r(); }
      this.dots = new Dots(this.n);
      this.lut = dotLut(v.pal.ring, v.pal.tint);
      this.colours = [];
      for (var c = 0; c < this.arcs; c++) this.colours.push(ramp(v.pal.ring, Math.abs(c / this.arcs * 2 - 1)));
      this.flare = glowSprite(hex(v.pal.core), Math.round(v.R * 0.9), 1);
      this.wash = glowSprite(hex(v.pal.haze), Math.round(v.R * 2), 0.3);
    },
    draw: function (v) {
      var ctx = v.ctx, p = v.p, R = v.R, cx = v.cx, cy = v.cy, drive = v.drive, t = v.phase, px = v.px, dots = this.dots;
      var head = v.spin * 1.5 + 0.9, sharp = 3.2 - drive * 1.9 - p.sonar * 0.8, step = TAU / this.arcs, i;
      var ws = R * 2 * (1 + drive * 0.08);
      ctx.globalAlpha = 0.3 + p.glow * 0.4;
      ctx.drawImage(this.wash, cx + Math.cos(head) * R * 0.42 - ws / 2, cy - Math.sin(head) * R * 0.42 - ws / 2, ws, ws);
      ctx.globalAlpha = 1;
      ctx.lineCap = 'butt';
      for (i = 0; i < this.arcs; i++) {
        var a = i * step, lit = Math.pow(Math.cos(a - head) * 0.5 + 0.5, sharp) * (0.35 + p.glow * 0.65 + drive * 0.4) + 0.07;
        var rr = R * (1 + field(Math.cos(a), Math.sin(a), 0.4, t) * (p.amp * 0.8 + drive * 0.07));
        var col = this.colours[i];
        ctx.strokeStyle = rgba(col, Math.min(0.2, lit * 0.2)); ctx.lineWidth = px * (4 + lit * 13);
        ctx.beginPath(); ctx.arc(cx, cy, rr, -a - step * 0.56, -a + step * 0.56); ctx.stroke();
        ctx.strokeStyle = rgba(col, Math.min(1, lit * 1.05)); ctx.lineWidth = px * (0.9 + lit * 2.8);
        ctx.beginPath(); ctx.arc(cx, cy, rr, -a - step * 0.56, -a + step * 0.56); ctx.stroke();
      }
      var top = cy - R * 1.3, span = R * 2.6, flow = v.clock * (0.05 + p.flow * 0.05 + drive * 0.16);
      for (i = 0; i < this.n; i++) {
        var k = this.k[i], life = (k + flow) % 1, ang = this.a[i] + life * 0.5;
        var near = Math.pow(Math.cos(ang - head) * 0.5 + 0.5, 2);
        if (near < 0.04) continue;
        var dist = 1 + life * life * (0.24 + drive * 0.2), b = near * (1 - life) * (0.55 + p.glow * 0.5 + drive * 0.5);
        var sy = cy - Math.sin(ang) * R * dist;
        dots.add(cx + Math.cos(ang) * R * dist, sy, px * (0.55 + b * 0.75), bucket((sy - top) / span, b));
      }
      dots.flush(ctx, this.lut, v.roundFrom);
      var fs = R * (0.3 + p.glow * 0.18 + drive * 0.36) * (v.still ? 1 : 0.94 + Math.sin(v.clock * 9) * 0.06);
      ctx.drawImage(this.flare, cx + Math.cos(head) * R - fs / 2, cy - Math.sin(head) * R - fs / 2, fs, fs);
    }
  };

  /* Overlays shared by every look, so each state reads the same whichever look is chosen. */
  function drawOverlays(v) {
    var ctx = v.ctx, p = v.p, R = v.R, cx = v.cx, cy = v.cy, px = v.px, i;
    if (p.sonar > 0.02) {   /* listening: rings leaving the orb */
      ctx.strokeStyle = v.pal.rim || '#fff';
      ctx.lineWidth = px * 1.4;
      for (i = 0; i < 3; i++) {
        var s = v.still ? (i + 0.6) / 3 : (v.clock * 0.42 + i / 3) % 1;
        ctx.globalAlpha = (1 - s) * 0.65 * p.sonar;
        ctx.beginPath(); ctx.arc(cx, cy, R * (1.04 + s * 0.34), 0, TAU); ctx.stroke();
      }
    }
    if (p.sweep > 0.02) {   /* thinking: a radar arc with a fading tail */
      ctx.strokeStyle = v.pal.accent;
      ctx.lineWidth = px * 2.2; ctx.lineCap = 'butt';
      var steps = 14, tail = 0.13;
      for (i = 0; i < steps; i++) {
        var a0 = -v.sweepAngle + i * tail;
        ctx.globalAlpha = (1 - i / steps) * 0.85 * p.sweep;
        ctx.beginPath(); ctx.arc(cx, cy, R * 1.2, a0, a0 + tail + 0.01); ctx.stroke();
      }
    }
    if (p.ring > 0.02) {    /* needs approval: a steady ring that does not move */
      ctx.globalAlpha = p.ring;
      ctx.strokeStyle = v.pal.accent;
      ctx.lineWidth = px * 2.6;
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.2, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ---- one loop for every orb on the page ---- */
  var orbs = [], looping = false;
  function loop(now) {
    var alive = false;
    for (var i = 0; i < orbs.length; i++) if (orbs[i].frame(now)) alive = true;
    looping = alive;
    if (alive) requestAnimationFrame(loop);
  }
  function startLoop() { if (!looping) { looping = true; requestAnimationFrame(loop); } }

  var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function systemReduced() {
    return !!(motionQuery && motionQuery.matches) || document.documentElement.getAttribute('data-reduced-motion') === 'true';
  }
  function motionChanged() { orbs.forEach(function (o) { o.syncMotion(); }); }
  if (motionQuery && motionQuery.addEventListener) motionQuery.addEventListener('change', motionChanged);
  if (window.MutationObserver) new MutationObserver(motionChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] });

  function loadSaved(key) {
    try { var o = JSON.parse(localStorage.getItem(key)); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }

  /* ---- mount ---- */
  function mount(opts) {
    opts = opts || {};
    var id = opts.id || 'assistant';
    var key = 'binnacle:' + id;
    var persist = opts.persist !== false;
    var saved = persist ? loadSaved(key) : {};
    var size = Math.round(clamp(opts.size || 260, 120, 640));
    var look = LOOKS[saved.look] ? saved.look : LOOKS[opts.look] ? opts.look : 'ring';
    var theme = THEMES[saved.theme] ? saved.theme : THEMES[opts.theme] ? opts.theme : 'aurora';
    var inline = !!opts.inline;   /* sits in the page flow: a tile, not a floating orb. No dragging. */
    var margin = size * 0.4 + 8;   /* the visible disc plus a gap; the canvas corners may leave the screen */
    var forced = opts.quality === 'high' ? 0 : opts.quality === 'medium' ? 1 : opts.quality === 'low' ? 2 : -1;
    var tier = Math.max(forced, 0);
    var motionOverride = opts.reducedMotion;

    function homePos() {
      return { x: isNum(opts.x) ? opts.x : window.innerWidth - margin - 16, y: isNum(opts.y) ? opts.y : window.innerHeight - margin - 16 };
    }
    /* null until someone moves it, so the default corner follows the window */
    var want = isNum(saved.x) && isNum(saved.y) ? { x: saved.x, y: saved.y } : null;
    var pos = { x: 0, y: 0 };

    var el = document.createElement('div');
    el.className = 'binnacle' + (inline ? ' inline' : ''); el.style.width = el.style.height = size + 'px';
    if (opts.zIndex !== undefined) el.style.setProperty('--binnacle-z', String(opts.zIndex));
    var canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true');
    var hit = document.createElement('button'); hit.type = 'button'; hit.className = 'binnacle-hit';
    var dock = document.createElement('div'); dock.className = 'binnacle-dock';
    var cap = document.createElement('div'); cap.className = 'binnacle-cap'; cap.setAttribute('role', 'status');
    dock.appendChild(cap);
    var pick = null;
    if (opts.picker !== false) {
      pick = document.createElement('div'); pick.className = 'binnacle-pick';
      pick.setAttribute('role', 'group'); pick.setAttribute('aria-label', 'Orb look');
      var lookRow = document.createElement('div'), themeRow = document.createElement('div');
      lookRow.className = themeRow.className = 'binnacle-pick-row';
      pick.appendChild(lookRow); pick.appendChild(themeRow);
      Object.keys(LOOKS).forEach(function (name) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = LOOKS[name].label; b.setAttribute('data-look', name);
        b.addEventListener('click', function () { api.setLook(name); });
        lookRow.appendChild(b);
      });
      Object.keys(THEMES).forEach(function (name) {
        var t = THEMES[name], b = document.createElement('button');
        b.type = 'button'; b.className = 'swatch'; b.title = t.label; b.setAttribute('aria-label', 'Theme: ' + t.label); b.setAttribute('data-theme', name);
        b.style.background = 'linear-gradient(135deg,' + t.ring[0] + ',' + t.ring[2] + ' 50%,' + t.ring[4] + ')';
        b.addEventListener('click', function () { api.setTheme(name); });
        themeRow.appendChild(b);
      });
      dock.appendChild(pick);
    }
    el.appendChild(canvas); el.appendChild(hit); el.appendChild(dock);
    (opts.parent || document.body).appendChild(el);

    var ctx = canvas.getContext('2d');
    var view = {
      ctx: ctx, cx: 0, cy: 0, R: 0, px: 1, scale: 1, pal: THEMES[theme], p: {}, drive: 0,
      spin: 0.6, phase: 1.3, clock: 0, sweepAngle: 0.8, still: false, roundFrom: 2
    };
    PARAMS.forEach(function (k) { view.p[k] = STATES[voice.state][k]; });
    var drive = 0, kick = 0, lastDraw = 0, lastFrame = 0, drawEma = 0, gapEma = 0, slowFrames = 0, frames = 0, fpsStart = 0, fps = 0;
    var backdrop = null, reduced = false, dead = false, active = null, onScreen = true, watcher = null;

    function isReduced() { return motionOverride === undefined ? systemReduced() : !!motionOverride; }

    function save() {
      if (!persist) return;
      var state = { look: look, theme: theme };
      if (want) { state.x = Math.round(want.x); state.y = Math.round(want.y); }
      try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {}
    }
    function place() {
      if (inline) return;
      var w = window.innerWidth, h = window.innerHeight, to = want || homePos();
      pos.x = w > margin * 2 ? clamp(to.x, margin, w - margin) : w / 2;
      pos.y = h > margin * 2 ? clamp(to.y, margin, h - margin) : h / 2;
      el.style.transform = 'translate3d(' + Math.round(pos.x - size / 2) + 'px,' + Math.round(pos.y - size / 2) + 'px,0)';
      el.classList.toggle('up', pos.y + size * 0.38 + 64 > h);
      var shift = Math.min(0, w - DOCK_HALF - pos.x) + Math.max(0, DOCK_HALF - pos.x);
      el.style.setProperty('--binnacle-shift', Math.round(shift) + 'px');   /* flip the caption above the orb near the bottom */
    }

    function build() {
      var t = TIERS[tier], dpr = Math.min(window.devicePixelRatio || 1, t.dpr);
      canvas.width = canvas.height = Math.round(size * dpr);
      var half = canvas.width / 2;
      view.cx = view.cy = half; view.R = canvas.width * 0.34; view.px = dpr * (size / 260 + 1) / 2;
      view.scale = t.scale; view.pal = THEMES[theme];
      view.roundFrom = tier === 0 ? 1 : tier === 1 ? 2 : BRIGHTS;
      var g = document.createElement('canvas'); g.width = g.height = canvas.width;
      var gc = g.getContext('2d'), grad = gc.createRadialGradient(half, half, view.R * 0.5, half, half, half);
      var bg = view.pal.backdrop;
      grad.addColorStop(0, rgba(bg, 0.94)); grad.addColorStop(0.62, rgba(bg, 0.86)); grad.addColorStop(1, rgba(bg, 0));
      gc.fillStyle = grad; gc.fillRect(0, 0, g.width, g.height);
      backdrop = g;
      active = Object.create(LOOKS[look]);   /* each orb keeps its own particles and colours */
      active.build(view);
    }

    function paint() {
      var start = performance.now();
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(backdrop, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      active.draw(view);
      drawOverlays(view);
      return performance.now() - start;
    }

    function renderStill() {
      var target = STATES[voice.state];
      PARAMS.forEach(function (k) { view.p[k] = target[k]; });
      view.drive = target.talk ? 0.5 * target.talk : 0;
      view.still = true; view.spin = 0.6; view.phase = 1.3; view.clock = 2; view.sweepAngle = 0.8;
      paint();
    }

    function frame(now) {
      if (dead || reduced) return false;
      if (!onScreen) return true;
      var calm = voice.state === 'idle' || voice.state === 'approval';
      var target = Math.max(TIERS[tier].frameMs, calm ? CALM_FRAME_MS : 0, inline ? INLINE_FRAME_MS : 0);
      if (now - lastFrame < target - 2) return true;
      var gap = now - lastFrame; lastFrame = now;
      var dt = Math.min(gap, 100) / 1000, p = view.p, s = STATES[voice.state];
      var ease = 1 - Math.exp(-dt * 5.5);
      for (var i = 0; i < PARAMS.length; i++) { var k = PARAMS[i]; p[k] += (s[k] - p[k]) * ease; }
      /* quick to rise, slower to fall, so the orb follows syllables without jitter */
      var heard = shape(voice.level) * p.talk;
      drive += (heard - drive) * (1 - Math.exp(-dt * (heard > drive ? 26 : 9)));
      kick *= Math.exp(-dt * 3.2);
      view.drive = clamp(drive + kick, 0, 1);
      view.clock += dt; view.spin += dt * p.rot; view.phase += dt * (p.flow + drive * 1.6);
      view.sweepAngle = (view.sweepAngle - dt * 2.6 * Math.max(p.sweep, 0.2) + TAU) % TAU;
      view.still = false;

      var cost = paint();
      lastDraw = cost;
      drawEma += (cost - drawEma) * 0.08;
      if (gap < 250) gapEma += (gap - gapEma) * 0.08;
      frames++;
      if (now - fpsStart >= 1000) { fps = Math.round(frames * 1000 / (now - fpsStart)); frames = 0; fpsStart = now; }

      if (forced < 0 && tier < TIERS.length - 1) {
        var slow = drawEma > SLOW_DRAW_MS || (!calm && gapEma > SLOW_GAP_MS);
        slowFrames = slow ? slowFrames + 1 : 0;
        if (slowFrames > 45) { tier++; slowFrames = 0; drawEma = 0; gapEma = 0; build(); }
      }
      return true;
    }

    function syncMotion() {
      reduced = isReduced();
      if (reduced) renderStill(); else { lastFrame = 0; startLoop(); }
    }

    function describe() {
      var label = STATES[voice.state].label;
      hit.setAttribute('aria-label', (opts.name || 'Assistant') + ' orb, ' + LOOKS[look].label + ', ' + THEMES[theme].label + ', ' + label + (inline ? '.' : '. Drag or use the arrow keys to move it.'));
      cap.textContent = '';
      var b = document.createElement('b'); b.textContent = label; cap.appendChild(b);
      if (voice.text) cap.appendChild(document.createTextNode(': ' + voice.text));
      cap.hidden = opts.caption === false || (voice.state === 'idle' && !voice.text);
      if (pick) Array.prototype.forEach.call(pick.querySelectorAll('button'), function (c) {
        c.setAttribute('aria-pressed', String(c.getAttribute('data-look') === look || c.getAttribute('data-theme') === theme));
      });
    }

    var unsubscribe = voice.subscribe(function () { describe(); if (reduced) renderStill(); });

    /* dragging */
    var drag = null, swallowClick = false;
    hit.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || inline) return;
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: e.clientX - pos.x, oy: e.clientY - pos.y, moved: false, lx: e.clientX, ly: e.clientY };
      swallowClick = false;
      hit.setPointerCapture(e.pointerId);
    });
    hit.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return;
        drag.moved = true; el.classList.add('dragging');
      }
      want = { x: e.clientX - drag.ox, y: e.clientY - drag.oy };
      place();
      /* a quick throw stirs the surface */
      kick = Math.min(0.5, kick + (Math.abs(e.clientX - drag.lx) + Math.abs(e.clientY - drag.ly)) * 0.0022);
      drag.lx = e.clientX; drag.ly = e.clientY;
    });
    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) { swallowClick = true; save(); }
      el.classList.remove('dragging');
      drag = null;
    }
    hit.addEventListener('pointerup', endDrag);
    hit.addEventListener('pointercancel', endDrag);
    hit.addEventListener('click', function () {
      if (swallowClick) { swallowClick = false; return; }
      if (opts.onActivate) opts.onActivate(api);
    });
    hit.addEventListener('keydown', function (e) {
      if (inline) return;
      var step = e.shiftKey ? 64 : 16, dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step; else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step; else if (e.key === 'ArrowDown') dy = step;
      else if (e.key === 'Home') { e.preventDefault(); api.resetPosition(); return; }
      else return;
      e.preventDefault();
      api.moveTo(pos.x + dx, pos.y + dy);
    });
    function onResize() { place(); }
    window.addEventListener('resize', onResize);

    var api = {
      id: id, el: el,
      get look() { return look; },
      get theme() { return theme; },
      get position() { return { x: pos.x, y: pos.y }; },
      setLook: function (name) {
        if (!LOOKS[name] || name === look) return api;
        look = name; build(); describe(); save();
        if (reduced) renderStill();
        return api;
      },
      setTheme: function (name) {
        if (!THEMES[name] || name === theme) return api;
        theme = name; build(); describe(); save();
        if (reduced) renderStill();
        return api;
      },
      moveTo: function (x, y) { want = { x: x, y: y }; place(); save(); return api; },
      resetPosition: function () { want = null; place(); save(); return api; },
      stats: function () {
        return { fps: fps, drawMs: Math.round(lastDraw * 100) / 100, avgDrawMs: Math.round(drawEma * 100) / 100, tier: tier, look: look, reduced: reduced, canvas: canvas.width };
      },
      destroy: function () {
        dead = true; unsubscribe();
        if (watcher) watcher.disconnect();
        window.removeEventListener('resize', onResize);
        orbs.splice(orbs.indexOf(handle), 1);
        el.remove();
      }
    };
    if (inline && window.IntersectionObserver) {
      watcher = new IntersectionObserver(function (seen) { onScreen = seen[seen.length - 1].isIntersecting; });
      watcher.observe(el);
    }
    var handle = { frame: frame, syncMotion: syncMotion };
    orbs.push(handle);
    place(); build(); describe(); syncMotion();
    return api;
  }

  window.Binnacle = {
    version: VERSION, schema: SCHEMA, mount: mount, voice: voice,
    looks: Object.keys(LOOKS).map(function (k) { return { id: k, label: LOOKS[k].label }; }),
    themes: Object.keys(THEMES).map(function (k) { return { id: k, label: THEMES[k].label }; }),
    states: Object.keys(STATES).map(function (k) { return { id: k, label: STATES[k].label }; })
  };
}());
