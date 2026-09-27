/*
 * HD Render — 画质增强层
 * 为 Emularity/DOSBox 的 2D canvas 叠加一个 WebGL 后处理层。
 *
 * 设计约束：绝不能替换原 canvas（Emscripten 依赖 getContext('2d')，
 * 且鼠标/全屏坐标都基于原 canvas 的 bounding rect）。
 * 因此本模块在原 canvas 之上叠一个 pointer-events:none 的 WebGL 画布，
 * 每帧把原画布当作纹理上传并跑 uber-shader。
 */
(function (global) {
  'use strict';

  var LS_KEY = 'cdg-hd-settings-v1';

  var PRESETS = {
    off:   { label: '关闭',   curvature: 0,     scanline: 0,     vignette: 0,    chroma: 0,      sharpen: 0,    glow: 0,    saturation: 1,    contrast: 1,     brightness: 0 },
    hd:    { label: '纯净HD', curvature: 0,     scanline: 0,     vignette: 0,    chroma: 0,      sharpen: 0.25, glow: 0.06, saturation: 1.05, contrast: 1.04,  brightness: 0.01, fsr: 1, advmame: 1, scaleMode: 1, intScale: 3 },
    crt:   { label: 'CRT',    curvature: 0.055, scanline: 0.14,  vignette: 0.28, chroma: 0.0016, sharpen: 0.30, glow: 0.28, saturation: 1.14, contrast: 1.08,  brightness: 0.02, fsr: 1, advmame: 1, scaleMode: 1, intScale: 2 },
    crt_hi:{ label: '重CRT',  curvature: 0.090, scanline: 0.22,  vignette: 0.42, chroma: 0.0030, sharpen: 0.20, glow: 0.42, saturation: 1.22, contrast: 1.14,  brightness: 0.03, fsr: 1, advmame: 1, scaleMode: 1, intScale: 2 },
    clean: { label: '柔和',   curvature: 0.025, scanline: 0.06,  vignette: 0.15, chroma: 0.0006, sharpen: 0.40, glow: 0.18, saturation: 1.10, contrast: 1.03,  brightness: 0.01, fsr: 1, advmame: 1, scaleMode: 1, intScale: 2 },
    fsr_max:{ label: '像素重建', curvature: 0,   scanline: 0,     vignette: 0,    chroma: 0,      sharpen: 0.15, glow: 0.03, saturation: 1.03, contrast: 1.02,  brightness: 0.00, fsr: 1, advmame: 1, scaleMode: 1, intScale: 4 }
  };

  var offPreset = { curvature: 0, scanline: 0, vignette: 0, chroma: 0, sharpen: 0, glow: 0, saturation: 1, contrast: 1, brightness: 0, fsr: 0, advmame: 1, scaleMode: 0, intScale: 2 };
  PRESETS.off = { label: '关闭' };
  for (var _k in offPreset) { PRESETS.off[_k] = offPreset[_k]; }

  var TUNABLE = ['curvature', 'scanline', 'vignette', 'chroma', 'sharpen', 'glow', 'saturation', 'contrast', 'brightness', 'fsr', 'advmame', 'scaleMode', 'intScale'];

  var VERT = [
    'attribute vec2 a_pos;',
    'varying vec2 v_uv;',
    'void main() {',
    '  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);',
    '  gl_Position = vec4(a_pos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG = [
    'precision mediump float;',
    'varying vec2 v_uv;',
    'uniform sampler2D u_tex;',
    'uniform vec2  u_texel;',
    'uniform float u_outH;',
    'uniform float u_curvature;',
    'uniform float u_scanline;',
    'uniform float u_vignette;',
    'uniform float u_chroma;',
    'uniform float u_sharpen;',
    'uniform float u_glow;',
    'uniform float u_saturation;',
    'uniform float u_contrast;',
    'uniform float u_brightness;',
    'uniform float u_curved;',
    'uniform float u_fsr;',           /* FSR 边缘自适应强度 0..1 */
    'uniform float u_advmame;',        /* 0=Scale2x 1=AdvMAME2x */
    'uniform float u_srcW;',           /* 源纹理像素宽 */
    'uniform float u_srcH;',
    'uniform float u_scaleNow;',       /* 实际放大倍率 */
    '',
    '// ---- Scale2x / AdvMAME2x: pixel-art edge reconstruction, no blur ----',
    '//',
    '// Classic upscaling (bilinear, my old EASU) blends neighbouring pixels,',
    '// which softens and blurs every edge. Scale2x never blends: for each of',
    '// the 4 output sub-pixels it picks either the centre pixel or a',
    '// neighbour whose colour matches, so diagonals become continuous lines',
    '// and colour-block boundaries stay perfectly hard.',
    '// This is exactly what isometric pixel art (sloped roofs, stairs,',
    '// floorboards) needs.',
    'void scale2xPixel(vec2 sp, out vec3 e0, out vec3 e1, out vec3 e2, out vec3 e3) {',
    '  vec2 t = u_texel;',
    '  vec2 b = (floor(sp) + 0.5) * t;',
    '  vec3 c  = texture2D(u_tex, b).rgb;',
    '  vec3 n  = texture2D(u_tex, b + vec2(0.0, -t.y)).rgb;',
    '  vec3 s  = texture2D(u_tex, b + vec2(0.0,  t.y)).rgb;',
    '  vec3 w  = texture2D(u_tex, b + vec2(-t.x, 0.0)).rgb;',
    '  vec3 e  = texture2D(u_tex, b + vec2( t.x, 0.0)).rgb;',
    '  vec3 nw = texture2D(u_tex, b + vec2(-t.x, -t.y)).rgb;',
    '  vec3 ne = texture2D(u_tex, b + vec2( t.x, -t.y)).rgb;',
    '  vec3 sw = texture2D(u_tex, b + vec2(-t.x,  t.y)).rgb;',
    '  vec3 se = texture2D(u_tex, b + vec2( t.x,  t.y)).rgb;',
    '  e0 = (nw == c) ? w : ((ne == c) ? e : c);',
    '  e1 = (ne == c) ? e : ((nw == c) ? w : c);',
    '  e2 = (sw == c) ? w : ((se == c) ? e : c);',
    '  e3 = (se == c) ? e : ((sw == c) ? w : c);',
    '}',
    '',
    '// AdvMAME2x: interpolates only on one-sided matches, giving smoother',
    '// diagonal transitions while still keeping edges hard.',
    'void advmame2xPixel(vec2 sp, out vec3 e0, out vec3 e1, out vec3 e2, out vec3 e3) {',
    '  vec2 t = u_texel;',
    '  vec2 b = (floor(sp) + 0.5) * t;',
    '  vec3 c  = texture2D(u_tex, b).rgb;',
    '  vec3 w  = texture2D(u_tex, b + vec2(-t.x, 0.0)).rgb;',
    '  vec3 e  = texture2D(u_tex, b + vec2( t.x, 0.0)).rgb;',
    '  vec3 nw = texture2D(u_tex, b + vec2(-t.x, -t.y)).rgb;',
    '  vec3 ne = texture2D(u_tex, b + vec2( t.x, -t.y)).rgb;',
    '  vec3 sw = texture2D(u_tex, b + vec2(-t.x,  t.y)).rgb;',
    '  vec3 se = texture2D(u_tex, b + vec2( t.x,  t.y)).rgb;',
    '  e0 = (nw == c && ne == w) ? (w + c) * 0.5',
    '     : (nw == c)          ? w',
    '     : (ne == c)          ? e',
    '     :                      c;',
    '  e1 = (ne == c && nw == e) ? (e + c) * 0.5',
    '     : (ne == c)          ? e',
    '     : (nw == c)          ? w',
    '     :                      c;',
    '  e2 = (sw == c && se == w) ? (w + c) * 0.5',
    '     : (sw == c)          ? w',
    '     : (se == c)          ? e',
    '     :                      c;',
    '  e3 = (se == c && sw == e) ? (e + c) * 0.5',
    '     : (se == c)          ? e',
    '     : (sw == c)          ? w',
    '     :                      c;',
    '}',
    '',
    '// Entry point: reconstruct at 2x then interpolate for arbitrary scale.',
    'vec3 upscale(vec2 uv) {',
    '  if (u_fsr <= 0.001) { return texture2D(u_tex, uv).rgb; }',
    '  // 越界时夹回边缘而非返回 0：返回 0 会静默把该像素变成纯黑，',
    '  // 在色差/曲面等偏移采样下会把整片画面打坏。',
    '  uv = clamp(uv, vec2(0.0), vec2(1.0));',
    '  vec2 sp = uv * vec2(u_srcW, u_srcH) - 0.5;',
    '  vec2 g = sp * 0.5 - 0.25;',
    '  vec3 e0, e1, e2, e3;',
    '  if (u_advmame > 0.5) { advmame2xPixel(g, e0, e1, e2, e3); }',
    '  else                { scale2xPixel(g, e0, e1, e2, e3); }',
    '  vec2 f = clamp(fract(sp * 0.5 - 0.25) * 2.0, 0.0, 1.0);',
    '  vec3 top = mix(e0, e1, f.x);',
    '  vec3 bot = mix(e2, e3, f.x);',
    '  return mix(top, bot, f.y);',
    '}',
    '',
    'vec2 curve(vec2 uv) {',
    '  uv = uv * 2.0 - 1.0;',
    '  vec2 off = abs(uv.yx) / vec2(6.0, 5.0);',
    '  uv = uv + uv * off * off * u_curvature * 4.0;',
    '  return uv * 0.5 + 0.5;',
    '}',
    '',
    'vec3 sampleRGB(vec2 uv) {',
    '  vec3 c = upscale(uv);',
    '  if (u_chroma > 0.0) {',
    '    vec2 dir = uv - 0.5;',
    '    // 三通道必须同源：若 R/B 直接取原纹理、G 取重建结果，',
    '    // 三通道采样位置不一致，边缘互相错位，画面偏品红。',
    '    // 偏移后越界时 upscale 返回 0，会把该通道整片清零，',
    '    // 所以只取 R/B 分量并夹回，避免毁掉整帧。',
    '    vec3 cr = upscale(clamp(uv + dir * u_chroma, 0.0, 1.0));',
    '    vec3 cb = upscale(clamp(uv - dir * u_chroma, 0.0, 1.0));',
    '    return vec3(cr.r, c.g, cb.b);',
    '  }',
    '  return c;',
    '}',
    '',
    'void main() {',
    '  vec2 uv = v_uv;',
    '  if (u_curved > 0.5) { uv = curve(uv); }',
    '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {',
    '    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);',
    '    return;',
    '  }',
    '',
    '  vec2 o = u_texel;',
    '  vec3 c = sampleRGB(uv);',
    '',
    '  if (u_sharpen > 0.0) {',
    '    vec3 blur = (',
    '      texture2D(u_tex, uv + vec2( o.x, 0.0)).rgb +',
    '      texture2D(u_tex, uv + vec2(-o.x, 0.0)).rgb +',
    '      texture2D(u_tex, uv + vec2(0.0,  o.y)).rgb +',
    '      texture2D(u_tex, uv + vec2(0.0, -o.y)).rgb) * 0.25;',
    '    c = c + (c - blur) * u_sharpen;',
    '  }',
    '',
    '  if (u_glow > 0.0) {',
    '    vec3 g = (',
    '      texture2D(u_tex, uv + vec2( o.x * 2.0, 0.0)).rgb +',
    '      texture2D(u_tex, uv + vec2(-o.x * 2.0, 0.0)).rgb +',
    '      texture2D(u_tex, uv + vec2(0.0,  o.y * 2.0)).rgb +',
    '      texture2D(u_tex, uv + vec2(0.0, -o.y * 2.0)).rgb) * 0.25;',
    '    c += g * u_glow;',
    '  }',
    '',
    '  float l = dot(c, vec3(0.299, 0.587, 0.114));',
    '  c = mix(vec3(l), c, u_saturation);',
    '  c = (c - 0.5) * u_contrast + 0.5 + u_brightness;',
    '',
    '  if (u_scanline > 0.0) {',
    '    float line = mod(floor(v_uv.y * u_outH), 2.0);',
    '    c *= 1.0 - u_scanline * line;',
    '  }',
    '',
    '  if (u_vignette > 0.0) {',
    '    vec2 q = v_uv - 0.5;',
    '    c *= 1.0 - u_vignette * dot(q, q) * 2.0;',
    '  }',
    '',
    '  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  function defaults() {
    var s = { preset: 'crt' };
    var p = PRESETS.crt;
    for (var i = 0; i < TUNABLE.length; i++) { s[TUNABLE[i]] = p[TUNABLE[i]]; }
    s.enabled = true;
    return s;
  }

  function load() {
    var s = defaults();
    try {
      var raw = global.localStorage.getItem(LS_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        for (var k in s) { if (Object.prototype.hasOwnProperty.call(o, k)) { s[k] = o[k]; } }
      }
    } catch (e) { /* 忽略：隐私模式或损坏的 JSON */ }
    return s;
  }

  function save(s) {
    try { global.localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
  }

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile failed: ' + log);
    }
    return sh;
  }

  function HDRender(srcCanvas, container) {
    this.src = srcCanvas;
    this.container = container;
    this.settings = load();
    this.enabled = this.settings.enabled !== false;
    this.ok = false;
    this.texW = 0;
    this.texH = 0;
    this._raf = null;
    this._loop = this._loop.bind(this);
  }

  HDRender.prototype.init = function () {
    if (this.ok) { return true; }
    var canvas = document.createElement('canvas');
    canvas.id = 'canvas-hd';
    canvas.className = 'hd-overlay';
    var gl = canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance'
    });
    if (!gl) { return false; }

    var prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('link failed: ' + gl.getProgramInfoLog(prog));
      }
    } catch (e) {
      console.warn('[HD Render] 初始化失败，降级为原始画质：', e.message);
      return false;
    }

    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.u = {};
    var names = ['u_tex', 'u_texel', 'u_outH', 'u_curvature', 'u_scanline', 'u_vignette',
                 'u_chroma', 'u_sharpen', 'u_glow', 'u_saturation', 'u_contrast',
                 'u_brightness', 'u_curved', 'u_fsr', 'u_advmame', 'u_srcW', 'u_srcH', 'u_scaleNow'];
    for (var i = 0; i < names.length; i++) {
      this.u[names[i]] = gl.getUniformLocation(prog, names[i]);
    }
    gl.uniform1i(this.u.u_tex, 0);

    /* 帧缓存统计（供调试面板显示） */
    this.skipped = 0;
    this.dirty = null;
    this.dirtyRatio = 0;
    this._frameCheck = true;
    this._hotFrames = 0;

    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      this.ok = false;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      if (this._timer) { global.clearInterval(this._timer); this._timer = null; }
      this._fallback(true);
    }.bind(this), false);

    canvas.addEventListener('webglcontextrestored', function () {
      this.ok = false;
      this._fallback(false);
    }.bind(this), false);

    // 可见性切换时切换驱动方式（rAF ↔ 定时器）
    global.document.addEventListener('visibilitychange', function () {
      if (!this.ok) { return; }
      if (global.document.hidden) {
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
        if (!this._timer) { this._timer = global.setInterval(this._loop, 66); }
      } else {
        if (this._timer) { global.clearInterval(this._timer); this._timer = null; }
        this._raf = requestAnimationFrame(this._loop);
      }
    }.bind(this), false);

    this.gl = gl;
    this.canvas = canvas;
    this.container.appendChild(canvas);
    this.ok = true;
    this._start();
    return true;
  };

  /* 启动渲染循环。
   * 不能只在 init 里调一次 requestAnimationFrame：页面处于后台/无头状态时
   * rAF 根本不会触发，循环体一次都跑不起来。改为先判断可见性，
   * 隐藏时直接用定时器启动。 */
  HDRender.prototype._start = function () {
    if (global.document && global.document.hidden) {
      if (!this._timer) {
        this._timer = global.setInterval(this._loop, 66);
      }
    } else {
      this._raf = requestAnimationFrame(this._loop);
    }
  };

  HDRender.prototype._fallback = function (lost) {
    if (lost) {
      if (this.canvas) { this.canvas.style.display = 'none'; }
      this.src.style.opacity = '1';
    } else {
      this.ok = false;
      this.init();
      if (this.ok && this.canvas) { this.canvas.style.display = ''; }
    }
  };

  HDRender.prototype._syncSize = function () {
    var src = this.src;
    var box = src.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) { return false; }

    var iw = src.width, ih = src.height;
    var left, top, cw, ch;

    // 判定 src 是否处于全屏 letterbox 模式（object-fit: contain）
    var cs = getComputedStyle(src);
    var contained = cs.objectFit === 'contain' || src.classList.contains('html-fullscreen');

    if (contained && iw > 0 && ih > 0) {
      // 复刻 object-fit: contain 的等比内缩，与原画布可见区域完全一致
      var scale = Math.min(box.width / iw, box.height / ih);
      cw = iw * scale;
      ch = ih * scale;
      left = box.left + (box.width - cw) / 2;
      top = box.top + (box.height - ch) / 2;
    } else {
      // 非全屏：src 用 width:100% + height:auto，可见区域即 border box
      left = box.left; top = box.top;
      cw = box.width; ch = box.height;
    }

    var parentBox = this.container.getBoundingClientRect();
    /* 覆盖层坐标基准。
     * 非全屏时覆盖层是 position:absolute，坐标相对父容器；
     * 全屏时覆盖层被 CSS 切成 position:fixed，坐标相对视口。
     * 两种基准混用会导致覆盖层整体偏移，src 已隐藏时表现为全黑屏。 */
    var ovCs = getComputedStyle(this.canvas);
    var overlayIsFixed = ovCs.position === 'fixed';
    var originX = overlayIsFixed ? 0 : parentBox.left;
    var originY = overlayIsFixed ? 0 : parentBox.top;
    var x = Math.round(left - originX);
    var y = Math.round(top - originY);
    var cw2 = Math.max(1, Math.round(cw));
    var ch2 = Math.max(1, Math.round(ch));

    var st = this.canvas.style;
    st.left = x + 'px';
    st.top = y + 'px';
    st.width = cw2 + 'px';
    st.height = ch2 + 'px';

    /* 绘图缓冲尺寸。
     * 必须等于「实际显示像素数」，一次成像，中间不做任何缩放。
     *
     * 之前的做法是渲染到 1280 再由 GPU 双线性缩到 728，
     * 相当于把刚重建好的边缘又重新采样糊了一遍 ——
     * 这正是「整数倍 2.00 开了也没效果」的原因。
     * Scale2x 这类逐像素重建算法必须在最终分辨率上一次性输出。 */
    var dpr = global.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(cw2 * dpr));
    var h = Math.max(1, Math.round(ch2 * dpr));

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return true;
  };

  /* 帧变化检测 + 脏矩形。
   *
   * 实测回合制游戏相邻帧仅有 0.01% 像素变化，绝大部分时间完全静止。
   * 若每帧都重算：① 重复对同一画面做同样计算 ② 采样误差逐帧累积，
   * 表现为画面持续微抖（用户感知为「只是变亮了」）。
   *
   * 这里做一次全分辨率读回并逐字节早退比对，得到脏矩形：
   * - 无变化：完全跳过重绘，屏幕上保持上一次高质量结果，完全静止
   * - 有变化：照常重绘（着色器本身很便宜），脏矩形供后续增量/AI 推理使用
   */
  HDRender.prototype._detectChange = function () {
    var src = this.src;
    if (!this._probe) {
      this._probe = global.document.createElement('canvas');
      this._probeCtx = this._probe.getContext('2d', { willReadFrequently: true });
    }
    var p = this._probe;
    if (p.width !== src.width || p.height !== src.height) {
      p.width = src.width;
      p.height = src.height;
      this._prevPix = null;
    }

    try {
      this._probeCtx.drawImage(src, 0, 0);
      var cur = this._probeCtx.getImageData(0, 0, p.width, p.height).data;
    } catch (e) {
      return { changed: true, rect: null };   /* 读回失败：保守当作有变化 */
    }

    var prev = this._prevPix;
    if (!prev || prev.length !== cur.length) {
      this._prevPix = new Uint8Array(cur);
      return { changed: true, rect: null };
    }

    /* 逐字节早退比对，同时累计脏矩形边界 */
    var n = cur.length;
    var minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    var diff = 0;
    for (var i = 0; i < n; i++) {
      if (cur[i] !== prev[i]) {
        diff++;
        var px = (i >> 2) % p.width;
        var py = (i >> 2) / p.width | 0;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }

    if (diff === 0) {
      return { changed: false, rect: null };
    }
    prev.set(cur);
    return {
      changed: true,
      rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      ratio: diff / n
    };
  };

  HDRender.prototype._loop = function () {
    if (!this.ok) { return; }

    // 双驱动：可见时用 rAF（省资源），页面隐藏时 rAF 完全不触发，
    // 改用定时器兜底，否则无头/后台环境下永远不会渲染。
    // 注意：这里只负责"挂上下一次驱动"，不能因为已有驱动就 return，
    // 否则当前这一帧的渲染会被跳过（曾经踩过：纹理永远停在 0x0）。
    if (global.document && global.document.hidden) {
      if (!this._timer) {
        this._timer = global.setInterval(this._loop, 66);
      }
    } else {
      this._raf = requestAnimationFrame(this._loop);
    }

    var s = this.settings;
    var active = this.enabled && s.preset !== 'off';
    if (!active) {
      if (this._wasActive !== false) {
        this._wasActive = false;
        this.src.style.opacity = '1';
        this.canvas.style.display = 'none';
      }
      return;
    }
    this._wasActive = true;
    this.src.style.opacity = '0';
    this.canvas.style.display = '';

    // 尺寸未就绪（游戏还没启动、canvas 为 0×0）时不要隐藏原画布，否则黑屏
    if (!this._syncSize()) {
      this.src.style.opacity = '1';
      this.canvas.style.display = 'none';
      return;
    }

    /* 安全网：一旦着色器/上下文出问题，立即回落原画布。
     * 宁可没有画质，也绝不能让用户看到黑屏。 */
    if (!this.ok) {
      this.src.style.opacity = '1';
      this.canvas.style.display = 'none';
      return;
    }

    /* 帧变化检测：静止时跳过重绘，消除逐帧采样误差累积导致的微抖。
     * 安全阀：连续 N 帧都在变（如动作场景/过场动画）就停止检测、
     * 恢复每帧重绘，避免白付检测开销却拿不到收益。 */
    if (this._frameCheck) {
      if (this._hotFrames === undefined) { this._hotFrames = 0; }
      if (this._hotFrames < 90) {
        var ch = this._detectChange();
        if (ch.rect) {
          this.dirty = ch.rect;
          this.dirtyRatio = ch.ratio;
          if (ch.ratio > 0.25) { this._hotFrames++; } else { this._hotFrames = 0; }
        } else if (ch.changed) {
          this.dirty = null;
          this._hotFrames = 0;
        } else {
          this.skipped++;
          return;                 /* 画面未变：保持上一帧结果，完全静止 */
        }
      }
    }

    var gl = this.gl;
    var sw = this.src.width, sh = this.src.height;
    if (sw < 1 || sh < 1) { return; }

    if (sw !== this.texW || sh !== this.texH) {
      this.texW = sw; this.texH = sh;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.src);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.src);
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.u.u_texel, 1 / sw, 1 / sh);
    gl.uniform1f(this.u.u_outH, this.src.height * (this.canvas.width / sw));
    gl.uniform1f(this.u.u_curvature, s.curvature);
    gl.uniform1f(this.u.u_scanline, s.scanline);
    gl.uniform1f(this.u.u_vignette, s.vignette);
    gl.uniform1f(this.u.u_chroma, s.chroma);
    gl.uniform1f(this.u.u_sharpen, s.sharpen);
    gl.uniform1f(this.u.u_glow, s.glow);
    gl.uniform1f(this.u.u_saturation, s.saturation);
    gl.uniform1f(this.u.u_contrast, s.contrast);
    gl.uniform1f(this.u.u_brightness, s.brightness);
    gl.uniform1f(this.u.u_curved, s.curvature > 0.0001 ? 1 : 0);
    gl.uniform1f(this.u.u_fsr, s.fsr || 0);
    gl.uniform1f(this.u.u_advmame, (s.advmame === undefined ? 1 : s.advmame) > 0.5 ? 1 : 0);
    gl.uniform1f(this.u.u_srcW, sw);
    gl.uniform1f(this.u.u_srcH, sh);
    gl.uniform1f(this.u.u_scaleNow, this.canvas.width / sw);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  HDRender.prototype.applyPreset = function (name) {
    if (!PRESETS[name]) { return; }
    this.settings.preset = name;
    var p = PRESETS[name];
    for (var i = 0; i < TUNABLE.length; i++) { this.settings[TUNABLE[i]] = p[TUNABLE[i]]; }
    save(this.settings);
  };

  HDRender.prototype.setParam = function (key, val) {
    if (TUNABLE.indexOf(key) === -1) { return; }
    this.settings[key] = val;
    this.settings.preset = 'custom';
    save(this.settings);
  };

  HDRender.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    this.settings.enabled = this.enabled;
    save(this.settings);
  };

  /* 静态帧缓存开关。关闭后每帧都重绘（用于对比效果或遇到问题时排查）。 */
  HDRender.prototype.setFrameCache = function (on) {
    this._frameCheck = !!on;
    this._hotFrames = 0;
    this._prevPix = null;
    this.skipped = 0;
  };

  HDRender.prototype.toggleFullscreen = function () {
    var src = this.src;
    var on = src.classList.contains('html-fullscreen');
    if (on) {
      src.classList.remove('html-fullscreen');
      this.canvas.classList.remove('html-fullscreen');
    } else {
      src.classList.add('html-fullscreen');
      this.canvas.classList.add('html-fullscreen');
    }
    var btn = document.getElementById('exit_button');
    if (btn) { btn.classList.toggle('exit_fullscreen_show', !on); }
  };

  global.HDRender = HDRender;
  global.HD_PRESETS = PRESETS;
  global.HD_TUNABLE = TUNABLE;
})(window);
