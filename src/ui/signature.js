/* Mesh signature: the orb, the lit word, and the lava lamp. One drop-in file.
 *
 *   <script src="/signature.js" data-word="MESH" data-accent="#5b7cff" data-accent2="#22d3ee" data-voice="/voice/tara.mp3"></script>
 *
 * Marks it looks for in the page:
 *   <canvas data-orb="quiet|voice|teal|#hex" data-n="130">   a particle orb anywhere (logo, chat header)
 *   <canvas class="heroorb" data-orb="quiet">                  the hero orb: the one light source
 *   <div class="mesh-word" id="meshWord">MESH</div>            the word across the back (layout + font from the page CSS)
 *   <button data-sig-hear>                                     optional: plays data-voice, the light follows the sound
 * It gives the page:
 *   window.MeshOrb.set(canvas, palette, busy)   recolour / excite an orb
 *   window.meshLightTalk(on)                     "someone is talking" (the demo call uses it)
 *   window.MeshSignature                         {light, blobs, config} for tests and tuning
 *
 * Rules it keeps: nothing loads from another host; the light holds still and the lava stops for
 * prefers-reduced-motion; the hero orb stays softer on phones so the headline is readable.
 *
 * The lens (2026-10-29): where WebGL exists, a blob crossing the word is a magnifying glass. The letters
 * under it swell from its centre and smear around its rim, and just outside the rim they cling to it for
 * a moment. The lens edge wobbles with the drawn blob, so glass and bubble are one thing. Without WebGL
 * (or with data-lens="off") the word falls back to the strip warp below. Same marks, same attributes.
 */
(function () {
  var me = document.currentScript, D = (me && me.dataset) || {};
  function hex(h) { var n = parseInt(String(h).replace('#', ''), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; }
  var CFG = {
    word: D.word || 'MESH',
    accent: hex(D.accent || '#5b7cff'),
    accent2: hex(D.accent2 || '#22d3ee'),
    bg: hex(D.bg || '#010102'),
    voice: D.voice || '',
    blobs: D.blobs ? +D.blobs : 0,
    lens: D.lens !== 'off'
  };
  var WHITE = [255, 255, 255];
  var reduce = false; try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var phone = function () { return innerWidth < 900; };

  /* ---------- 1. the orb (a small cut of the MeshMarket orb, with its moods) ---------- */
  var P = {
    quiet: [[59, 130, 246], [56, 189, 248], [14, 165, 233], [96, 165, 250], [147, 197, 253]],
    voice: [[34, 211, 238], [91, 124, 255], [167, 139, 250], [56, 189, 248], [45, 212, 191]],
    teal: [[45, 212, 191], [94, 234, 212], [20, 184, 166], [153, 246, 228], [56, 189, 248]]
  };
  function hexPal(h) { var c = hex(h); return [c, mix(c, WHITE, .35), mix(c, [0, 0, 0], .25), mix(c, WHITE, .6), [c[0] * .9, c[1] * .95, c[2]]].map(function (x) { return x.map(function (v) { return v | 0; }); }); }
  function pal(k) { return k && k[0] === '#' ? hexPal(k) : (P[k] || P.quiet); }
  function pmix(p, ph) { ph = ((ph % 1) + 1) % 1; var f = ph * p.length, i = f | 0, t = f - i, a = p[i % p.length], b = p[(i + 1) % p.length]; return ((a[0] + (b[0] - a[0]) * t) | 0) + ',' + ((a[1] + (b[1] - a[1]) * t) | 0) + ',' + ((a[2] + (b[2] - a[2]) * t) | 0); }
  var orbs = [];
  function Orb(cv) {
    var ctx = cv.getContext && cv.getContext('2d'); if (!ctx) return;
    var n = +cv.dataset.n || 130, st = +cv.dataset.s || 1.35, pts = [];
    for (var i = 0; i < n; i++) pts.push({ r: .55 + Math.pow(Math.random(), 1.6) * 1.1, inc: Math.acos(2 * Math.random() - 1), az: Math.random() * 6.283, ph: Math.random() * 6.283, w: (.4 + Math.random() * .9) * (Math.random() < .5 ? 1 : -1), s: .6 + Math.random() * 1.1 });
    var cur = pal(cv.dataset.orb).map(function (c) { return c.slice(); });
    var o = { cv: cv, busy: false, target: pal(cv.dataset.orb), amp: 0, draw: function (ts) {
      var dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      var W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) * .3 * (1 + o.amp * .35), tg = o.target;
      for (var k = 0; k < 5; k++) for (var c = 0; c < 3; c++) cur[k][c] += (tg[k][c] - cur[k][c]) * .06;
      var b = o.busy, t = ts * .001, br = 1 + Math.sin(t * (b ? 3.2 : 1.1)) * (b ? .09 : .05);
      ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter';
      [[R * 1.7, pmix(cur, t * .05 + .4), .18], [R * .95, pmix(cur, t * .05), .32], [R * .32, '255,255,255', .55]].forEach(function (L) {
        var lr = Math.min(L[0] * br, Math.min(W, H) / 2 - 1), g = ctx.createRadialGradient(cx, cy, 0, cx, cy, lr);
        g.addColorStop(0, 'rgba(' + L[1] + ',' + L[2] * st + ')'); g.addColorStop(1, 'rgba(' + L[1] + ',0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, lr, 0, 7); ctx.fill();
      });
      var rot = t * (b ? .9 : .35), cY = Math.cos(rot), sY = Math.sin(rot), cX = Math.cos(.45), sX = Math.sin(.45), pr = Math.max(1, R / 40);
      for (var p = 0; p < pts.length; p++) { var q = pts[p], a = q.ph + t * q.w * (b ? 1.6 : .6), rr = q.r * br, x0 = Math.cos(a) * rr, s0 = Math.sin(a) * rr, y0 = s0 * Math.sin(q.inc), z0 = s0 * Math.cos(q.inc), x = x0 * Math.cos(q.az) + z0 * Math.sin(q.az), z = -x0 * Math.sin(q.az) + z0 * Math.cos(q.az), x1 = x * cY - z * sY, z1 = x * sY + z * cY, y1 = y0 * cX - z1 * sX, z2 = y0 * sX + z1 * cX, d = (z2 / 2.2 + 1) / 2, per = 1 / (1.9 - z2 / 2.2);
        ctx.fillStyle = 'rgba(' + pmix(cur, p / pts.length) + ',' + ((.15 + d * .7) * st).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(cx + x1 * R * per, cy + y1 * R * per, (.5 + d * 1.3) * q.s * dpr * Math.min(pr, 2.2), 0, 7); ctx.fill(); }
      ctx.globalCompositeOperation = 'source-over'; } };
    orbs.push(o); return o;
  }
  window.MeshOrb = { set: function (cv, k, busy) { for (var i = 0; i < orbs.length; i++) if (orbs[i].cv === cv) { if (k) orbs[i].target = pal(k); if (busy != null) orbs[i].busy = busy; orbs[i].amp = busy ? .25 : 0; } } };
  [].forEach.call(document.querySelectorAll('canvas[data-orb]'), Orb);

  /* ---------- 2. the light: one source, the hero orb ---------- */
  var word = document.getElementById('meshWord'), hero = document.querySelector('.heroorb'), hear = document.querySelector('[data-sig-hear]');
  var light = { x: innerWidth * .72, y: innerHeight * .45, r: innerWidth * .26, a: .42, talk: 0, voice: 0, flash: 0, nudge: 0 };
  var mx = null, my = null, lx = 0, ly = 0, first = true, t0 = performance.now();
  var audio = null, analyser = null, buf = null;
  function orbCentre() { if (!hero) return { x: innerWidth * .72, y: innerHeight * .45 }; var r = hero.getBoundingClientRect(); if (!r.width || r.bottom < 0 || r.top > innerHeight) return { x: innerWidth * .72, y: innerHeight * .45 }; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  addEventListener('pointermove', function (e) { mx = e.clientX; my = e.clientY; light.nudge = Math.min(1, light.nudge + .05); }, { passive: true });
  addEventListener('pointerdown', function () { light.flash = 1; });
  addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') light.flash = Math.max(light.flash, .6); });
  window.meshLightTalk = function (on) { light.talk = on ? 1 : 0; };
  function stopVoice() { if (audio) { audio.pause(); } audio = null; analyser = null; if (hear) { hear.setAttribute('aria-pressed', 'false'); hear.innerHTML = '&#9654; Hear it'; } }
  if (hear && CFG.voice) hear.addEventListener('click', function (e) {
    e.stopPropagation();
    if (audio) return stopVoice();
    audio = new Audio(CFG.voice); hear.setAttribute('aria-pressed', 'true'); hear.innerHTML = '&#10074;&#10074; ' + (hear.dataset.sigHear || 'Playing');
    try { var C = window.AudioContext || window.webkitAudioContext; var ctx = new C(); var src = ctx.createMediaElementSource(audio); analyser = ctx.createAnalyser(); analyser.fftSize = 512; buf = new Uint8Array(analyser.fftSize); src.connect(analyser); analyser.connect(ctx.destination); if (ctx.resume) ctx.resume(); } catch (err) { analyser = null; }
    audio.addEventListener('ended', stopVoice);
    audio.play().catch(stopVoice);
  });
  function level() { if (!analyser) return 0; analyser.getByteTimeDomainData(buf); var s = 0; for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; s += v * v; } return Math.min(1, Math.sqrt(s / buf.length) * 4.5); }
  function stepLight(now) {
    var c = orbCentre(), tx = c.x, ty = c.y;
    if (mx !== null) { tx += (mx - c.x) * .18; ty += (my - c.y) * .18; }
    if (first) { lx = tx; ly = ty; first = false; }
    lx += (tx - lx) * .12; ly += (ty - ly) * .12;
    light.voice += (level() - light.voice) * .35;
    light.flash *= .94; light.nudge *= .975;
    var breathe = reduce ? 0 : Math.sin((now - t0) / 1900) * 1.4;
    light.x = lx; light.y = ly;
    light.r = (26 + breathe + light.flash * 16 + light.nudge * 7 + light.talk * 3 + light.voice * 14) * innerWidth / 100;
    light.a = Math.min(.9, .42 + light.flash * .3 + light.nudge * .12 + light.talk * .05 + light.voice * .4);
    if (hero) { hero.style.opacity = ((phone() ? .55 : 1) * Math.min(1, .55 + light.flash * .35 + light.nudge * .12 + light.voice * .4)).toFixed(3); window.MeshOrb.set(hero, null, light.voice > .15 || light.flash > .4); }
    if (word) { var wr = word.getBoundingClientRect(); word.style.setProperty('--lx', (lx - wr.left) + 'px'); word.style.setProperty('--ly', (ly - wr.top) + 'px'); word.style.setProperty('--lr', (light.r / innerWidth * 100) + 'vw'); word.style.setProperty('--la', light.a.toFixed(3)); }
  }

  /* ---------- 3. the lava lamp: slow blobs far behind the page, and the word that grips them ---------- */
  var lava = document.createElement('canvas'); lava.id = 'sigLava'; lava.setAttribute('aria-hidden', 'true');
  var lctx = lava.getContext('2d');
  var blobs = [], strips = [], S = {};
  var style = document.createElement('style');
  style.textContent = '#sigLava,#sigLens{position:fixed;inset:0;width:100%;height:100%;z-index:-2;pointer-events:none}#sigLens{z-index:-1}html.sig-on .mesh-word{opacity:0}html.sig-on body{background:transparent}';
  document.head.appendChild(style);
  if (lctx) { document.body.appendChild(lava); document.documentElement.classList.add('sig-on'); }
  var mask = document.createElement('canvas'), mctx = mask.getContext('2d'), lit = document.createElement('canvas'), litc = lit.getContext('2d');
  function dpr() { return Math.min(devicePixelRatio || 1, 1.5); }

  /* ---------- 3b. the lens: WebGL over the lava; the word is drawn through the blobs ---------- */
  var glc = document.createElement('canvas'); glc.id = 'sigLens'; glc.setAttribute('aria-hidden', 'true');
  var gl = null, tex = null, vbuf = null, U = {}, BL = new Float32Array(32), BW = new Float32Array(8), Q = new Float32Array(12);
  if (lctx && CFG.lens) { try { gl = glc.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false }); } catch (e) { gl = null; } }
  if (gl) {
    try {
      // positions arrive in CSS px, y down; the quad covers the word plus a margin for what the lens pushes out
      var VS = 'attribute vec2 a;uniform vec2 vp;varying vec2 p;void main(){p=a;vec2 c=a/vp*2.0-1.0;gl_Position=vec4(c.x,-c.y,0.0,1.0);}';
      // inside a blob: sample from nearer its centre (pow(u,k), k>1) so the middle swells and the rim squeezes and
      // smears; just outside: pull the sample outward so the letters cling to the rim; the rim itself brightens.
      var FS = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n' +
        'varying vec2 p;uniform sampler2D tex;uniform vec4 rect;uniform vec4 bl[8];uniform float bw[8];uniform int n;uniform float t;uniform float P;uniform float grip;' +
        'float rad(vec4 b,float w,vec2 d){float th=atan(d.y,d.x);return b.z*(1.0+0.07*sin(3.0*th+t*w+b.w)+0.04*sin(5.0*th-t*0.5+b.w));}' +
        'vec2 lens(vec2 q,float k){vec2 s=q;for(int i=0;i<8;i++){if(i>=n)break;vec4 b=bl[i];vec2 d=s-b.xy;float r=length(d);if(r<0.001)continue;float R=rad(b,bw[i],d);float u=r/R;' +
        'if(u<1.0){s=b.xy+d*(pow(u,k)/u);}else if(u<1.5){float g=(u-1.0)*2.0;s+=(d/r)*R*grip*(g*(1.0-g)*4.0);}}return s;}' +
        'float rim(vec2 q){float m=0.0;for(int i=0;i<8;i++){if(i>=n)break;vec4 b=bl[i];vec2 d=q-b.xy;float u=length(d)/rad(b,bw[i],d);if(u<1.0)m=max(m,smoothstep(0.68,1.0,u));}return m;}' +
        'vec4 sm(vec2 s){vec2 uv=(s-rect.xy)/rect.zw;if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0)return vec4(0.0);return texture2D(tex,uv);}' +
        'void main(){vec4 c=sm(lens(p,P));vec4 cr=sm(lens(p,P+0.035));vec4 cb=sm(lens(p,P-0.03));float a=max(c.a,max(cr.a,cb.a));' +
        'vec3 rgb=vec3(cr.r,c.g,cb.b)*(1.0+0.6*rim(p));gl_FragColor=vec4(min(rgb,vec3(a)),a);}';
      var sh = function (type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      var prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      ['vp', 'tex', 'rect', 'n', 't', 'P', 'grip'].forEach(function (k) { U[k] = gl.getUniformLocation(prog, k); });
      U.bl = gl.getUniformLocation(prog, 'bl') || gl.getUniformLocation(prog, 'bl[0]');
      U.bw = gl.getUniformLocation(prog, 'bw') || gl.getUniformLocation(prog, 'bw[0]');
      U.a = gl.getAttribLocation(prog, 'a');
      vbuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbuf); gl.enableVertexAttribArray(U.a); gl.vertexAttribPointer(U.a, 2, gl.FLOAT, false, 0, 0);
      tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(U.tex, 0); gl.uniform1f(U.P, 1.85); gl.uniform1f(U.grip, 0.09);   // the lens constants are the signature: not per page
      glc.addEventListener('webglcontextlost', function (e) { e.preventDefault(); gl = null; }, false);
      lava.parentNode.insertBefore(glc, lava.nextSibling);
    } catch (e) { gl = null; }
  }
  function drawLens(wr, t) {
    var n = 0, maxR = 0, i, b;
    for (i = 0; i < blobs.length && n < 8; i++) { b = blobs[i]; var span = b.r * 1.6; if (b.y + span < wr.top || b.y - span > wr.bottom) continue;
      BL[n * 4] = b.x; BL[n * 4 + 1] = b.y; BL[n * 4 + 2] = b.r; BL[n * 4 + 3] = b.ph; BW[n] = b.w; maxR = Math.max(maxR, b.r); n++; }
    gl.viewport(0, 0, glc.width, glc.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lit);
    gl.uniform2f(U.vp, innerWidth, innerHeight); gl.uniform4f(U.rect, wr.left, wr.top, S.W, S.H);
    gl.uniform4fv(U.bl, BL); gl.uniform1fv(U.bw, BW); gl.uniform1i(U.n, n); gl.uniform1f(U.t, t);
    var m = maxR * .35, x0 = wr.left - m, y0 = wr.top - m, x1 = wr.left + S.W + m, y1 = wr.top + S.H + m;
    Q[0] = x0; Q[1] = y0; Q[2] = x1; Q[3] = y0; Q[4] = x0; Q[5] = y1; Q[6] = x0; Q[7] = y1; Q[8] = x1; Q[9] = y0; Q[10] = x1; Q[11] = y1;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf); gl.bufferData(gl.ARRAY_BUFFER, Q, gl.DYNAMIC_DRAW); gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  function spawn(b, fromBottom) {
    var ph = phone(), R = ph ? 90 + Math.random() * 90 : 140 + Math.random() * 190;
    b.r = R; b.x = (.08 + Math.random() * .84) * innerWidth; b.y = fromBottom ? innerHeight + R * 1.3 : Math.random() * (innerHeight + R * 2) - R;
    b.v = 8 + Math.random() * 14; b.ph = Math.random() * 6.283; b.w = .6 + Math.random() * .8; b.t = Math.random(); b.a = .09 + Math.random() * .07; b.drift = (Math.random() - .5) * .3;
    return b;
  }
  function layout() {
    var d = dpr();
    lava.width = Math.round(innerWidth * d); lava.height = Math.round(innerHeight * d);
    if (gl) { glc.width = lava.width; glc.height = lava.height; }
    var n = CFG.blobs || (phone() ? 4 : 7);
    while (blobs.length < n) blobs.push(spawn({}, false)); blobs.length = n;
    if (word) {
      var wr = word.getBoundingClientRect(), cs = getComputedStyle(word);
      S.wr = wr; S.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; S.ls = cs.letterSpacing;
      S.W = Math.max(1, Math.round(wr.width)); S.H = Math.max(1, Math.round(wr.height));
      mask.width = lit.width = Math.round(S.W * d); mask.height = lit.height = Math.round(S.H * d);
      mctx.setTransform(d, 0, 0, d, 0, 0); mctx.clearRect(0, 0, S.W, S.H);
      mctx.font = S.font; try { mctx.letterSpacing = S.ls; } catch (e) {}
      mctx.textAlign = 'center'; mctx.textBaseline = 'middle'; mctx.fillStyle = '#fff';
      mctx.fillText(CFG.word, S.W / 2, S.H / 2);
      S.strip = phone() ? 14 : 10; var count = Math.ceil(S.W / S.strip) + 1;   // nodes: the strip boundaries
      while (strips.length < count) strips.push({ dx: 0, dy: 0, vx: 0, vy: 0 }); strips.length = count;
    }
  }
  var resizeT = null; addEventListener('resize', function () { clearTimeout(resizeT); resizeT = setTimeout(layout, 120); });
  function drawBlob(ctx, b, t, scale) {
    var x = b.x * scale, y = b.y * scale, r = b.r * scale, lit = Math.max(0, 1 - Math.hypot(b.x - light.x, b.y - light.y) / (light.r * 1.6));
    var a = b.a * (.75 + lit * .8), col = mix(CFG.accent, CFG.accent2, b.t);
    var g = ctx.createRadialGradient(x - r * .2, y - r * .25, 0, x, y, r * 1.15);
    g.addColorStop(0, rgba(mix(col, WHITE, .25), a)); g.addColorStop(.55, rgba(col, a * .55)); g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 1.15, 0, 7); ctx.fill();
    ctx.fillStyle = rgba(col, a * .5); ctx.beginPath();
    for (var i = 0; i <= 48; i++) { var th = i / 48 * 6.283, rr = r * (1 + .07 * Math.sin(3 * th + t * b.w + b.ph) + .04 * Math.sin(5 * th - t * .5 + b.ph)); ctx.lineTo(x + Math.cos(th) * rr, y + Math.sin(th) * rr); }
    ctx.closePath(); ctx.fill();
  }
  var last = 0;
  function stepLava(now, dt) {
    var d = dpr(), t = now * .001, W = innerWidth, H = innerHeight, wr = S.wr, wy = wr ? wr.top + wr.height / 2 : H / 2;
    for (var i = 0; i < blobs.length; i++) { var b = blobs[i];
      if (!reduce) { var grip = wr && Math.abs(b.y - wy) < b.r ? .55 : 1; b.y -= b.v * grip * dt; b.x += Math.sin(t * .2 + b.ph) * .12 + b.drift * .1; if (b.y + b.r * 1.4 < 0) spawn(b, true); if (b.x < -b.r) b.x = W + b.r; if (b.x > W + b.r) b.x = -b.r; }
    }
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.fillStyle = rgba(CFG.bg, 1); lctx.fillRect(0, 0, lava.width, lava.height);
    var g1 = lctx.createRadialGradient(lava.width / 2, lava.height * 1.1, 0, lava.width / 2, lava.height * 1.1, 900 * d); g1.addColorStop(0, rgba(CFG.accent, .14)); g1.addColorStop(1, rgba(CFG.accent, 0)); lctx.fillStyle = g1; lctx.fillRect(0, 0, lava.width, lava.height);
    lctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < blobs.length; i++) drawBlob(lctx, blobs[i], t, d);
    lctx.globalCompositeOperation = 'source-over';
    var v = lctx.createRadialGradient(lava.width / 2, lava.height / 2, Math.min(lava.width, lava.height) * .35, lava.width / 2, lava.height / 2, Math.max(lava.width, lava.height) * .75); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.6)'); lctx.fillStyle = v; lctx.fillRect(0, 0, lava.width, lava.height);
    if (!wr) return;
    litc.setTransform(d, 0, 0, d, 0, 0); litc.globalCompositeOperation = 'source-over'; litc.clearRect(0, 0, S.W, S.H);
    var L = litc.createRadialGradient(light.x - wr.left, light.y - wr.top, 0, light.x - wr.left, light.y - wr.top, light.r);
    L.addColorStop(0, rgba(mix(CFG.accent, WHITE, .7), light.a)); L.addColorStop(.38, rgba(CFG.accent, light.a * .55)); L.addColorStop(.62, rgba(CFG.accent2, light.a * .18)); L.addColorStop(1, rgba(CFG.accent2, 0));
    litc.fillStyle = L; litc.fillRect(0, 0, S.W, S.H);
    litc.fillStyle = 'rgba(255,255,255,.022)'; litc.fillRect(0, 0, S.W, S.H);
    litc.globalCompositeOperation = 'lighter';
    for (i = 0; i < blobs.length; i++) { b = blobs[i]; if (b.y + b.r < wr.top || b.y - b.r > wr.bottom) continue;
      var bg = litc.createRadialGradient(b.x - wr.left, b.y - wr.top, 0, b.x - wr.left, b.y - wr.top, b.r); bg.addColorStop(0, rgba(mix(CFG.accent, CFG.accent2, b.t), .28)); bg.addColorStop(1, rgba(CFG.accent2, 0)); litc.fillStyle = bg; litc.fillRect(0, 0, S.W, S.H); }
    litc.globalCompositeOperation = 'destination-in'; litc.setTransform(1, 0, 0, 1, 0, 0); litc.drawImage(mask, 0, 0); litc.globalCompositeOperation = 'source-over';
    if (gl) { drawLens(wr, t); return; }   // the lens draws the word; the strips below are the fallback
    var st = S.strip, n = strips.length, maxPull;
    // each node is a strip boundary; a blob within reach pulls it toward itself
    for (i = 0; i < n; i++) { var s = strips[i], sx = wr.left + i * st, tx = 0, ty = 0;
      if (!reduce) for (var j = 0; j < blobs.length; j++) { b = blobs[j]; var syc = Math.max(wr.top, Math.min(wr.bottom, b.y)), dist = Math.hypot(b.x - sx, b.y - syc), reach = b.r * 1.15;
        if (dist < reach) { var f = 1 - dist / reach; f *= f; maxPull = Math.min(70, b.r * .3); tx += Math.max(-maxPull, Math.min(maxPull, (b.x - sx) * f * .5)); ty += Math.max(-maxPull, Math.min(maxPull, (b.y - syc) * f * .6)); } }
      s.tx = tx; s.ty = ty; }
    // surface tension between neighbours, then a spring: soft while held, quick with a wobble when let go
    for (i = 0; i < n; i++) { s = strips[i]; var p = strips[i - 1] || s, q = strips[i + 1] || s, tx2 = (p.tx + 2 * s.tx + q.tx) / 4, ty2 = (p.ty + 2 * s.ty + q.ty) / 4, held = tx2 || ty2, k = held ? .05 : .11, c = held ? .32 : .14;
      s.vx += (tx2 - s.dx) * k - s.vx * c; s.vy += (ty2 - s.dy) * k - s.vy * c; s.dx += s.vx; s.dy += s.vy; }
    // draw each strip as the quad between its two boundary nodes: the edges meet, so no seams
    for (i = 0; i < n - 1; i++) { var L0 = strips[i], R0 = strips[i + 1], x0 = wr.left + i * st, w0 = Math.min(st, S.W - i * st); if (w0 <= 0) break;
      var sxl = x0 + L0.dx, sxr = x0 + w0 + R0.dx, a = (sxr - sxl) / w0, bsh = (R0.dy - L0.dy) / w0;
      lctx.setTransform(a * d, bsh * d, 0, d, sxl * d, (wr.top + L0.dy) * d);
      lctx.drawImage(lit, i * st * d, 0, w0 * d, lit.height, 0, 0, w0, S.H); }
    lctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  window.MeshSignature = { light: light, blobs: blobs, config: CFG, strips: strips, layout: layout, lens: function () { return Boolean(gl); } };

  /* ---------- the one loop, 30 fps ---------- */
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || now - last < 33) return;
    var dt = Math.min(.1, (now - last) / 1000) || .033; last = now;
    stepLight(now);
    for (var i = 0; i < orbs.length; i++) orbs[i].draw(now);
    if (lctx) stepLava(now, dt);
  }
  if (lctx) layout();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (lctx) layout(); });
  if (reduce) { stepLight(1000); for (var i = 0; i < orbs.length; i++) orbs[i].draw(1000); if (lctx) stepLava(1000, 0); }
  else { if (lctx) { stepLight(performance.now()); stepLava(performance.now(), 0); } requestAnimationFrame(frame); }   // paint frame 0 now: no flash of the page behind before the first rAF
})();
