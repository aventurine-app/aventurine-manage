'use strict';

/* The sign-in pages' ground (pages/auth/): a square grid of light
   grey dots on white that swell and shrink in a slow wave. A copy of the
   website's home hero (aventurine-app.com, js/dot-wave.js); keep the two in
   step. The dots never move; only their size changes, so the wave reads as
   light rolling across a fixed matrix.

   Two swells cross at an angle, each a sine travelling across the page, so
   the crests bend and drift rather than marching in straight rows. A dot's
   size is the two swells' weighted sum, squared, which keeps the troughs
   broad and the crests narrow. The grid is centred on the page, so it keeps
   its place at any width, and every dot's distance along each swell is
   worked out once per resize; each frame only advances the time and redraws
   every dot in one path. The colour is the canvas's CSS `color`
   (static/css/auth.css).

   It runs only while the canvas is on screen and the tab is in view; with
   motion reduced it draws one still frame. */
(() => {
  const canvas = document.querySelector('canvas.dot-wave');
  const ctx = canvas && canvas.getContext('2d');
  if (!ctx) return;

  const GAP = 22;                  // CSS px between dot centres
  const R_MIN = 0.6;               // a dot's radius in a trough, CSS px
  const R_MAX = 2.6;               // and on a crest
  // direction of travel (radians, 0 is rightward, y runs down), wavelength in
  // CSS px, seconds per wavelength, and share of the size; the shares sum to 1
  const SWELLS = [
    { angle: 0.35, length: 560, period: 10, weight: 0.65 },
    { angle: -0.9, length: 380, period: 14, weight: 0.35 },
  ];
  const TAU = 2 * Math.PI;

  let width = 0, height = 0, dpr = 1, count = 0, colour = '';
  let xs, ys, phases;              // per dot; phases holds SWELLS.length values per dot

  const layout = () => {
    dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    colour = getComputedStyle(canvas).color;

    // one more column and row than fit, centred, so the edges are always covered
    const cols = Math.ceil(width / GAP) + 1, rows = Math.ceil(height / GAP) + 1;
    const x0 = (width - (cols - 1) * GAP) / 2, y0 = (height - (rows - 1) * GAP) / 2;
    count = cols * rows;
    xs = new Float32Array(count);
    ys = new Float32Array(count);
    phases = new Float32Array(count * SWELLS.length);
    for (let i = 0; i < count; i++) {
      const x = x0 + (i % cols) * GAP, y = y0 + Math.floor(i / cols) * GAP;
      xs[i] = x;
      ys[i] = y;
      SWELLS.forEach(({ angle, length }, s) => {
        phases[i * SWELLS.length + s] = TAU * (x * Math.cos(angle) + y * Math.sin(angle)) / length;
      });
    }
  };

  const draw = t => {
    const shifts = SWELLS.map(({ period }) => TAU * t / period);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = colour;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let s = 0; s < SWELLS.length; s++) {
        sum += SWELLS[s].weight * Math.sin(phases[i * SWELLS.length + s] - shifts[s]);
      }
      const v = (sum + 1) / 2;     // 0 in the deepest trough, 1 on the highest crest
      const r = R_MIN + (R_MAX - R_MIN) * v * v;
      ctx.moveTo(xs[i] + r, ys[i]);
      ctx.arc(xs[i], ys[i], r, 0, TAU);
    }
    ctx.fill();
  };

  let t = 0, last = 0, raf = 0, visible = false;

  // resizing a canvas clears it, so every resize redraws the current frame
  new ResizeObserver(() => { layout(); draw(t); }).observe(canvas);

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const tick = now => {
    t += last ? (now - last) / 1000 : 0;
    last = now;
    draw(t);
    raf = requestAnimationFrame(tick);
  };
  const sync = () => {
    const run = visible && !document.hidden;
    if (run && !raf) { last = 0; raf = requestAnimationFrame(tick); }
    else if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  new IntersectionObserver(es => { visible = es[es.length - 1].isIntersecting; sync(); }).observe(canvas);
  document.addEventListener('visibilitychange', sync);
})();
