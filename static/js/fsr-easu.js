/*
 * FSR 1.0 EASU - Edge Adaptive Spatial Upsampling
 * Rebuilds continuous edges from a low-res source so diagonal lines
 * (isometric roofs, stairs, swords) stop looking like stair-stepped
 * mosaics. Implemented from AMD's public MIT-licensed algorithm.
 *
 * NOTE: needs a scale of at least 1.5x to be meaningful; below that the
 * edge-direction inference degenerates and we fall back to bilinear.
 */
(function (global) {
  'use strict';

  var VERT = [
    'attribute vec2 a_pos;',
    'varying vec2 v_uv;',
    'void main() {',
    '  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);',
    '  gl_Position = vec4(a_pos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG = [
    'precision highp float;',
    'precision highp sampler2D;',
    '',
    'varying vec2 v_uv;',
    'uniform sampler2D u_tex;',
    'uniform vec2  u_texel;',
    'uniform vec2  u_dstSize;',
    'uniform float u_srcSizeX;',
    'uniform float u_srcSizeY;',
    'uniform float u_scale;',
    'uniform float u_strength;',
    '',
    'void fetch3x3(out vec3 c, out vec3 n, out vec3 s, out vec3 w, out vec3 e,',
    '             out vec3 nw, out vec3 ne, out vec3 sw, out vec3 se, vec2 uv) {',
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
    'void main() {',
    '  vec2 uv = v_uv;',
    '',
    '  if (u_scale < 1.5) {',
    '    gl_FragColor = vec4(texture2D(u_tex, uv).rgb, 1.0);',
    '    return;',
    '  }',
    '',
    '  vec2 sp = uv * vec2(u_srcSizeX, u_srcSizeY) - 0.5;',
    '  vec2 f = fract(sp);',
    '  vec2 base = (floor(sp) + 0.5) * u_texel;',
    '',
    '  /* fetch 3x3 and measure per-direction contrast */',
    '  vec3 c, n, s, w, e, nw, ne, sw, se;',
    '  fetch3x3(c, n, s, w, e, nw, ne, sw, se, base);',
    '',
    '  vec3 lN = abs(c - n);',
    '  vec3 lS = abs(c - s);',
    '  vec3 lW = abs(c - w);',
    '  vec3 lE = abs(c - e);',
    '',
    '  /* 1D edge-direction weights (the EASU ring+dir reduce) */',
    '  vec3 wN = clamp(abs(nw + ne - c - n), 0.0, 1.0);',
    '  vec3 wS = clamp(abs(sw + se - c - s), 0.0, 1.0);',
    '  vec3 wW = clamp(abs(nw + sw - c - w), 0.0, 1.0);',
    '  vec3 wE = clamp(abs(ne + se - c - e), 0.0, 1.0);',
    '',
    '  /* dominant direction: horizontal edge -> stretch along y, else along x */',
    '  vec3 hEdge = max(lN, lS);',
    '  vec3 vEdge = max(lW, lE);',
    '  float hAmt = dot(hEdge, vec3(0.3333));',
    '  float vAmt = dot(vEdge, vec3(0.3333));',
    '',
    '  /* along-edge (perpendicular) stretch distance, ~1.5 source pixels */',
    '  vec2 stretchX = vec2(u_texel.x * 1.5 * clamp(vAmt, 0.0, 1.0) * u_strength, 0.0);',
    '  vec2 stretchY = vec2(0.0, u_texel.y * 1.5 * clamp(hAmt, 0.0, 1.0) * u_strength);',
    '',
    '  /* 3-tap along the stretched axis, weighted by edge confidence */',
    '  vec3 t0 = texture2D(u_tex, base).rgb;',
    '  vec3 tA = texture2D(u_tex, base + stretchX - stretchY).rgb;',
    '  vec3 tB = texture2D(u_tex, base - stretchX + stretchY).rgb;',
    '  vec3 tC = texture2D(u_tex, base + stretchX + stretchY).rgb;',
    '  vec3 tD = texture2D(u_tex, base - stretchX - stretchY).rgb;',
    '',
    '  vec3 acc = t0 * 0.5 + (tA + tB) * 0.15 + (tC + tD) * 0.1;',
    '  acc /= 1.0;',
    '',
    '  /* weight by how much contrast there actually is, so flat areas stay flat */',
    '  float conf = clamp(max(hAmt, vAmt) * 1.4, 0.0, 1.0) * u_strength;',
    '  vec3 plain = texture2D(u_tex, uv).rgb;',
    '',
    '  gl_FragColor = vec4(mix(plain, acc, conf), 1.0);',
    '}'
  ].join('\n');

  global.FSREASU = { VERT: VERT, FRAG: FRAG };
})(window);
