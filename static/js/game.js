function htmlFullscreen() {
    var gameCanvas = document.getElementById('canvas');
    var exitButton = document.getElementById('exit_button')
    if (gameCanvas.classList.contains('html-fullscreen')) {
        gameCanvas.classList.remove('html-fullscreen');
        exitButton.classList.remove('exit_fullscreen_show');
    }
    else {
        gameCanvas.classList.add('html-fullscreen');
        exitButton.classList.add('exit_fullscreen_show');
    }
    if (window.hd && window.hd.ok) { window.hd.canvas.classList.toggle('html-fullscreen', !gameCanvas.classList.contains('html-fullscreen')); }
    if (window.hd && window.hd.ok) { window.hd._syncSize(); }
}

/* 原生全屏与画质覆盖层的兼容处理。
 *
 * 问题：覆盖层是原画布的兄弟节点（都在 #screen_container 里），
 * 而浏览器原生全屏只渲染全屏元素「及其后代」，兄弟节点不渲染。
 * 原画布此时又被覆盖层隐藏(opacity:0)，于是全屏后一片黑。
 *
 * 解法：把原生全屏的目标从「原画布」换成「共同父容器 #screen_container」。
 * 容器同时包含原画布和覆盖层，两者都是全屏元素的后代，都能正常渲染，
 * 保留真正的沉浸式全屏和 ESC 退出。
 *
 * 覆盖层在容器内按 contain 方式贴合原画布可见区，由 _syncSize 完成。 */
function nativeFullscreen() {
    var src = document.getElementById('canvas');
    var container = document.getElementById('screen_container');
    if (!src) { return; }

    /* 画质层可用时，全屏目标换成共同父容器 */
    var target = (window.hd && window.hd.ok && container) ? container : src;

    var req = target.requestFullscreen || target.webkitRequestFullscreen ||
              target.mozRequestFullScreen || target.msRequestFullscreen;
    if (!req) { return; }

    var r = req.call(target);
    if (r && typeof r.catch === 'function') {
        r.catch(function () { htmlFullscreen(); });  /* 被拒时回落 CSS 全屏 */
    }
}

/* 原生全屏进入/退出时同步覆盖层几何。
 * 容器成为全屏元素后尺寸变为整个视口，覆盖层需重新贴合原画布。 */
(function () {
    'use strict';
    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange'].forEach(function (ev) {
        document.addEventListener(ev, function () {
            var el = document.fullscreenElement || document.webkitFullscreenElement;
            if (!el) { return; }
            var src = document.getElementById('canvas');
            var btn = document.getElementById('exit_button');
            if (btn) { btn.classList.add('exit_fullscreen_show'); }
            /* 标记真实全屏态，让 _syncSize 走 contain 分支 */
            if (src) { src.classList.add('html-fullscreen'); }
            if (window.hd && window.hd.ok) {
                window.hd.canvas.classList.add('html-fullscreen');
                window.hd._syncSize();
            }
        });
    });
})();

/* 画质面板：在游戏页注入一个可折叠的控制条 */
(function () {
  'use strict';

  var PALETTE = ['off', 'hd', 'clean', 'crt', 'crt_hi', 'fsr_max'];
  var SLIDERS = [
    { key: 'fsr',         label: '像素重建', min: 0,    max: 1,    step: 0.01  },
    { key: 'advmame',     label: 'AdvMAME', min: 0,    max: 1,    step: 1     },
    { key: 'curvature',   label: '曲面',   min: 0,    max: 0.15, step: 0.001 },
    { key: 'scanline',    label: '扫描线', min: 0,    max: 0.4,  step: 0.005 },
    { key: 'vignette',    label: '暗角',   min: 0,    max: 0.7,  step: 0.01  },
    { key: 'chroma',      label: '色差',   min: 0,    max: 0.008,step: 0.0001},
    { key: 'sharpen',     label: '锐化',   min: 0,    max: 1.2,  step: 0.01  },
    { key: 'glow',        label: '辉光',   min: 0,    max: 0.8,  step: 0.01  },
    { key: 'saturation',  label: '饱和度', min: 0.5,  max: 1.8,  step: 0.01  },
    { key: 'contrast',    label: '对比度', min: 0.7,  max: 1.5,  step: 0.01  },
    { key: 'brightness',  label: '亮度',   min: -0.2, max: 0.2,  step: 0.005 }
  ];

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (parent) { parent.appendChild(e); }
    return e;
  }

  function build() {
    if (!window.hd) { return; }

    var wrap = el('div', 'hd-panel');
    var body = el('div', 'hd-panel-body', wrap);

    var title = el('div', 'hd-panel-title', body);
    title.textContent = '画质增强';

    var grid = el('div', 'hd-presets', body);
    PALETTE.forEach(function (name) {
      var b = el('button', 'hd-preset-btn', grid);
      b.type = 'button';
      b.textContent = (window.HD_PRESETS[name] || {}).label || name;
      b.dataset.preset = name;
      b.addEventListener('click', function () {
        window.hd.applyPreset(name);
        sync();
      });
    });

    var toggler = el('label', 'hd-toggle', body);
    var cb = el('input', null, toggler);
    cb.type = 'checkbox';
    cb.checked = window.hd.enabled;
    cb.addEventListener('change', function () {
      window.hd.setEnabled(cb.checked);
      sync();
    });
    el('span', null, toggler).textContent = ' 启用后处理';

    var knobs = el('div', 'hd-sliders', body);
    var inputs = {};
    SLIDERS.forEach(function (s) {
      var row = el('div', 'hd-slider-row', knobs);
      var lab = el('label', 'hd-slider-label', row);
      lab.textContent = s.label;
      var inp = el('input', 'hd-slider', row);
      inp.type = 'range';
      inp.min = s.min; inp.max = s.max; inp.step = s.step;
      var val = el('span', 'hd-slider-val', row);
      inputs[s.key] = { input: inp, val: val, def: s };
      inp.addEventListener('input', function () {
        var v = parseFloat(inp.value);
        window.hd.setParam(s.key, v);
        val.textContent = v.toFixed(s.step < 0.01 ? 4 : 2);
        markCustom();
      });
    });

    function markCustom() {
      Array.prototype.forEach.call(grid.children, function (b) { b.classList.remove('active'); });
    }

    function sync() {
      var st = window.hd.settings;
      Array.prototype.forEach.call(grid.children, function (b) {
        b.classList.toggle('active', b.dataset.preset === st.preset);
      });
      cb.checked = window.hd.enabled;
      for (var k in inputs) {
        if (!Object.prototype.hasOwnProperty.call(inputs, k)) { continue; }
        var it = inputs[k];
        it.input.value = st[k];
        it.val.textContent = parseFloat(st[k]).toFixed(it.def.step < 0.01 ? 4 : 2);
      }
    }

    var tab = el('button', 'hd-panel-tab', null);
    tab.type = 'button';
    tab.textContent = '画质';
    tab.addEventListener('click', function () {
      wrap.classList.toggle('collapsed');
    });

    document.body.appendChild(wrap);
    document.body.appendChild(tab);
    sync();

    // F 键快速切换滤镜
    document.addEventListener('keydown', function (e) {
      if (e.key === 'f' || e.key === 'F') {
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { return; }
        window.hd.applyPreset('off');
        sync();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
