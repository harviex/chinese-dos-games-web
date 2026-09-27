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
    hd:    { label: '纯净HD', curvature: 0,     scanline: 0,     vignette: 0,    chroma: 0,      sharpen: 0.55, glow: 0.10, saturation: 1.06, contrast: 1.05,  brightness: 0.01, fsr: 0.85, scaleMode: 1, intScale: 2 },
    crt:   { label: 'CRT',    curvature: 0.055, scanline: 0.14,  vignette: 0.28, chroma: 0.0016, sharpen: 0.30, glow: 0.28, saturation: 1.14, contrast: 1.08,  brightness: 0.02, fsr: 0.75, scaleMode: 1, intScale: 2 },
    crt_hi:{ label: '重CRT',  curvature: 0.090, scanline: 0.22,  vignette: 0.42, chroma: 0.0030, sharpen: 0.20, glow: 0.42, saturation: 1.22, contrast: 1.14,  brightness: 0.03, fsr: 0.60, scaleMode: 1, intScale: 2 },
    clean: { label: '柔和',   curvature: 0.025, scanline: 0.06,  vignette: 0.15, chroma: 0.0006, sharpen: 0.40, glow: 0.18, saturation: 1.10, contrast: 1.03,  brightness: 0.01, fsr: 0.90, scaleMode: 1, intScale: 2 },
    fsr_max:{ label: '极限FSR', curvature: 0,     scanline: 0,     vignette: 0,    chroma: 0,      sharpen: 0.35, glow: 0.05, saturation: 1.04, contrast: 1.03,  brightness: 0.00, fsr: 1.00, scaleMode: 1, intScale: 3 }
  };

  var offPreset = { curvature: 0, scanline: 0, vignette: 0, chroma: 0, sharpen: 0, glow: 0, saturation: 1, contrast: 1, brightness: 0, fsr: 0, scaleMode: 0, intScale: 2 };
  PRESETS.off = { label: '关闭' };
  for (var _k in offPreset) { PRESETS.off[_k] = offPreset[_k]; }

  var TUNABLE = ['curvature', 'scanline', 'vignette', 'chroma', 'sharpen', 'glow', 'saturation', 'contrast', 'brightness', 'fsr', 'scaleMode', 'intScale'];

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
    'uniform float u_srcW;',           /* 源纹理像素宽 */
    'uniform float u_srcH;',
    'uniform float u_scaleNow;',       /* 实际放大倍率 */
    '',
    '/* 3x3 邻域采样，FSR 边缘方向推断用 */',
    'void fetch3x3(vec2 uv, out vec3 c, out vec3 n, out vec3 s, out vec3 w, out vec3 e,',
    '             out vec3 nw, out vec3 ne, out vec3 sw, out vec3 se) {',
    '  c  = texture2D(u_tex, uv).rgb;',
    '  n  = texture2D(u_tex, uv + vec2(0.0, -u_texel.y)).rgb;',
    '  s  = texture2D(u_tex, uv + vec2(0.0,  u_texel.y)).rgb;',
    '  w  = texture2D(u_tex, uv + vec2(-u_texel.x, 0.0)).rgb;',
    '  e  = texture2D(u_tex, uv + vec2( u_texel.x, 0.0)).rgb;',
    '  nw = texture2D(u_tex, uv + vec2(-u_texel.x, -u_texel.y)).rgb;',
    '  ne = texture2D(u_tex, uv + vec2( u_texel.x, -u_texel.y)).rgb;',
    '  sw = texture2D(u_tex, uv + vec2(-u_texel.x,  u_texel.y)).rgb;',
    '  se = texture2D(u_tex, uv + vec2( u_texel.x,  u_texel.y)).rgb;',
    '}',
    '',
    '/* FSR 1.0 EASU 简化实现：沿边缘方向做定向拉伸采样，',
    ' * 把阶梯状斜线重建成连续斜线。倍率 <1.5 时退化为普通双线性。 */',
    'vec3 easu(vec2 uv) {',
    '  if (u_fsr <= 0.0 || u_scaleNow < 1.5) {',
    '    return texture2D(u_tex, uv).rgb;',
    '  }',
    '  vec2 sp = uv * vec2(u_srcW, u_srcH) - 0.5;',
    '  vec2 f = fract(sp);',
    '  vec2 base = (floor(sp) + 0.5) * u_texel;',
    '',
    '  vec3 c, n, s, w, e, nw, ne, sw, se;',
    '  fetch3x3(base, c, n, s, w, e, nw, ne, sw, se);',
    '',
    '  vec3 lN = abs(c - n), lS = abs(c - s), lW = abs(c - w), lE = abs(c - e);',
    '  float hEdge = dot(max(lN, lS), vec3(0.3333));',
    '  float vEdge = dot(max(lW, lE), vec3(0.3333));',
    '',
    '  /* 边缘走向决定拉伸轴：水平边缘沿 x 拉，垂直边缘沿 y 拉 */',
    '  vec2 strX = vec2(u_texel.x * 1.5 * clamp(hEdge, 0.0, 1.0) * u_fsr, 0.0);',
    '  vec2 strY = vec2(0.0, u_texel.y * 1.5 * clamp(vEdge, 0.0, 1.0) * u_fsr);',
    '',
    '  vec3 t0 = texture2D(u_tex, base).rgb;',
    '  vec3 acc = t0 * 0.5;',
    '  acc += (texture2D(u_tex, base + strX - strY).rgb',
    '        + texture2D(u_tex, base - strX + strY).rgb) * 0.15;',
    '  acc += (texture2D(u_tex, base + strX + strY).rgb',
    '        + texture2D(u_tex, base - strX - strY).rgb) * 0.1;',
    '',
    '  /* 置信度：平坦区域不改动，避免糊掉 */',
    '  float conf = clamp(max(hEdge, vEdge) * 1.4, 0.0, 1.0) * u_fsr;',
    '  return mix(texture2D(u_tex, uv).rgb, acc, conf);',
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
    '  vec3 c = easu(uv);',
    '  if (u_chroma > 0.0) {',
    '    vec2 dir = uv - 0.5;',
    '    c.r = texture2D(u_tex, uv + dir * u_chroma).r;',
    '    c.b = texture2D(u_tex, uv - dir * u_chroma).b;',
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
                 'u_brightness', 'u_curved', 'u_fsr', 'u_srcW', 'u_srcH', 'u_scaleNow'];
    for (var i = 0; i < names.length; i++) {
      this.u[names[i]] = gl.getUniformLocation(prog, names[i]);
    }
    gl.uniform1i(this.u.u_tex, 0);

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
     * FSR/EASU 需要 >=2 倍放大倍率才有效。当前 CSS 框只有 1.14 倍
     * （640 源放到 728 框），EASU 会退化成双线性，等于白做。
     * 解决办法：绘图缓冲按整数倍放大，渲染完由 GPU 双线性缩回 CSS 尺寸。
     * 这样着色器始终在高倍率下工作，输出再平滑贴回屏幕。 */
    var dpr = global.devicePixelRatio || 1;
    var s = this.settings;
    var wantInt = (s && s.intScale) || 1;
    /* 只在"框不够大"时用整数倍兜底；框本来就够大就按实际尺寸 */
    var natScale = (cw2 * dpr) / iw;
    var useInt = wantInt > 1 && natScale < wantInt;

    var w, h;
    if (useInt) {
      w = Math.max(1, Math.round(iw * wantInt));
      h = Math.max(1, Math.round(ih * wantInt));
    } else {
      w = Math.max(1, Math.round(cw2 * dpr));
      h = Math.max(1, Math.round(ch2 * dpr));
    }

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return true;
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
