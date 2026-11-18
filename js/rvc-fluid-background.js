/*
 * ReVoiceChat : fond « fluide » qui suit le curseur, aux couleurs du site.
 *
 * - traînée de fluide derrière le contenu, qui suit la souris ;
 * - couleurs lues dans le thème (variables CSS --color-primary et --color-brand-pink, réglées dans
 *   le backoffice, page Design) : la traînée passe du cyan au rose ;
 * - le défilement de la page entraîne le fluide (il « suit » le contenu) ;
 * - un clic produit une éclaboussure ;
 * - pause automatique quand la souris est immobile ; désactivé sur écran tactile et si le visiteur
 *   a demandé à réduire les animations (prefers-reduced-motion).
 *
 * Simulation : portage JavaScript de WebGL Fluid Simulation de Pavel Dobryakov
 * (https://github.com/PavelDoGreat/WebGL-Fluid-Simulation), réglages de l'effet « Fluid Cursor » de Cursify.
 *
 *   MIT License
 *
 *   Copyright (c) 2017 Pavel Dobryakov
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */
(function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  var config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1440,
    DENSITY_DISSIPATION: 3.5,
    VELOCITY_DISSIPATION: 2,
    PRESSURE: 0.1,
    PRESSURE_ITERATIONS: 20,
    CURL: 3,
    SPLAT_RADIUS: 0.2,
    SPLAT_FORCE: 6000,
    SHADING: true,
    COLOR_UPDATE_SPEED: 10,
    /* Intensité de la couleur injectée (0.15 = réglage Cursify ; plus discret ici) */
    INTENSITY: 0.1,
    /* Entraînement du fluide par le défilement : déplacement total ≈ force / VELOCITY_DISSIPATION texels
       de simulation (SIM_RESOLUTION par hauteur d'écran) → 2 × 128 pour suivre le contenu */
    SCROLL_FORCE: 256,
    /* Pause de la boucle après inactivité (ms) : le fluide est alors entièrement dissipé */
    IDLE_TIMEOUT: 3000,
  };

  /* ---------------------------------------------------------------- */
  /* Couleurs du thème                                                 */
  /* ---------------------------------------------------------------- */

  /** Couleur CSS quelconque (hex, hsl, oklch…) → { r, g, b } entre 0 et 1, via un pixel de canvas 2D. */
  function cssColor(variable, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    var c = document.createElement('canvas');
    c.width = c.height = 1;
    var g = c.getContext('2d');
    if (!g) return { r: 0, g: 1, b: 1 };
    g.fillStyle = fallback;
    if (value) g.fillStyle = value; // valeur invalide : la couleur de repli est conservée
    g.fillRect(0, 0, 1, 1);
    var p = g.getImageData(0, 0, 1, 1).data;
    return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255 };
  }

  var palette = [cssColor('--color-primary', '#03f1ff'), cssColor('--color-brand-pink', '#eb6aff')];

  /** Couleur au hasard entre les deux couleurs du thème. */
  function generateColor() {
    var t = Math.random();
    var a = palette[0];
    var b = palette[1];
    return {
      r: (a.r + (b.r - a.r) * t) * config.INTENSITY,
      g: (a.g + (b.g - a.g) * t) * config.INTENSITY,
      b: (a.b + (b.b - a.b) * t) * config.INTENSITY,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Canvas (derrière le contenu)                                      */
  /* ---------------------------------------------------------------- */

  var canvas = document.createElement('canvas');
  canvas.id = 'rvc-fluid';
  canvas.setAttribute('aria-hidden', 'true');
  // Premier enfant de <body>, z-index 0 : les sections (positionnées) se dessinent par-dessus.
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;';
  document.body.insertBefore(canvas, document.body.firstChild);

  var webgl = getWebGLContext(canvas);
  if (!webgl) {
    canvas.remove();
    return;
  }
  var gl = webgl.gl;
  var ext = webgl.ext;

  if (!ext.supportLinearFiltering) {
    config.DYE_RESOLUTION = 256;
    config.SHADING = false;
  }

  function getWebGLContext(canvas) {
    var params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
    var gl = canvas.getContext('webgl2', params);
    var isWebGL2 = !!gl;
    if (!isWebGL2) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
    if (!gl) return null;

    var halfFloat;
    var supportLinearFiltering;
    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
      halfFloat = gl.getExtension('OES_texture_half_float');
      supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
      if (!halfFloat) return null;
    }
    gl.clearColor(0, 0, 0, 1);

    var halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
    var formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
      formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
      formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    } else {
      formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }
    if (!formatRGBA || !formatRG || !formatR) return null;

    return {
      gl: gl,
      ext: {
        formatRGBA: formatRGBA,
        formatRG: formatRG,
        formatR: formatR,
        halfFloatTexType: halfFloatTexType,
        supportLinearFiltering: !!supportLinearFiltering,
      },
    };
  }

  function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      switch (internalFormat) {
        case gl.R16F:
          return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
        case gl.RG16F:
          return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
        default:
          return null;
      }
    }
    return { internalFormat: internalFormat, format: format };
  }

  function supportRenderTextureFormat(gl, internalFormat, format, type) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    return ok;
  }

  /* ---------------------------------------------------------------- */
  /* Shaders                                                           */
  /* ---------------------------------------------------------------- */

  function compileShader(type, source, keywords) {
    if (keywords) source = keywords.map(function (k) { return '#define ' + k + '\n'; }).join('') + source;
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader');
    return shader;
  }

  function Program(vertexShader, fragmentShader) {
    var program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'program');
    this.program = program;
    this.uniforms = {};
    var count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < count; i++) {
      var name = gl.getActiveUniform(program, i).name;
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
  }
  Program.prototype.bind = function () {
    gl.useProgram(this.program);
  };

  var baseVertexShader = compileShader(
    gl.VERTEX_SHADER,
    [
      'precision highp float;',
      'attribute vec2 aPosition;',
      'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
      'uniform vec2 texelSize;',
      'void main () {',
      '  vUv = aPosition * 0.5 + 0.5;',
      '  vL = vUv - vec2(texelSize.x, 0.0);',
      '  vR = vUv + vec2(texelSize.x, 0.0);',
      '  vT = vUv + vec2(0.0, texelSize.y);',
      '  vB = vUv - vec2(0.0, texelSize.y);',
      '  gl_Position = vec4(aPosition, 0.0, 1.0);',
      '}',
    ].join('\n'),
  );

  var HEAD = 'precision highp float;\nprecision highp sampler2D;\nvarying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;\n';
  function frag(body, keywords) {
    return compileShader(gl.FRAGMENT_SHADER, HEAD + body, keywords);
  }

  var copyShader = frag('uniform sampler2D uTexture;\nvoid main () { gl_FragColor = texture2D(uTexture, vUv); }');

  var clearShader = frag('uniform sampler2D uTexture;\nuniform float value;\nvoid main () { gl_FragColor = value * texture2D(uTexture, vUv); }');

  var displayShader = frag(
    [
      'uniform sampler2D uTexture;',
      'uniform vec2 texelSize;',
      'void main () {',
      '  vec3 c = texture2D(uTexture, vUv).rgb;',
      '#ifdef SHADING',
      '  vec3 lc = texture2D(uTexture, vL).rgb;',
      '  vec3 rc = texture2D(uTexture, vR).rgb;',
      '  vec3 tc = texture2D(uTexture, vT).rgb;',
      '  vec3 bc = texture2D(uTexture, vB).rgb;',
      '  float dx = length(rc) - length(lc);',
      '  float dy = length(tc) - length(bc);',
      '  vec3 n = normalize(vec3(dx, dy, length(texelSize)));',
      '  vec3 l = vec3(0.0, 0.0, 1.0);',
      '  float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);',
      '  c *= diffuse;',
      '#endif',
      '  float a = max(c.r, max(c.g, c.b));',
      '  gl_FragColor = vec4(c, a);',
      '}',
    ].join('\n'),
    config.SHADING ? ['SHADING'] : null,
  );

  var splatShader = frag(
    [
      'uniform sampler2D uTarget;',
      'uniform float aspectRatio;',
      'uniform vec3 color;',
      'uniform vec2 point;',
      'uniform float radius;',
      'void main () {',
      '  vec2 p = vUv - point.xy;',
      '  p.x *= aspectRatio;',
      '  vec3 splat = exp(-dot(p, p) / radius) * color;',
      '  vec3 base = texture2D(uTarget, vUv).xyz;',
      '  gl_FragColor = vec4(base + splat, 1.0);',
      '}',
    ].join('\n'),
  );

  var advectionShader = frag(
    [
      'uniform sampler2D uVelocity;',
      'uniform sampler2D uSource;',
      'uniform vec2 texelSize;',
      'uniform vec2 dyeTexelSize;',
      'uniform float dt;',
      'uniform float dissipation;',
      'vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {',
      '  vec2 st = uv / tsize - 0.5;',
      '  vec2 iuv = floor(st);',
      '  vec2 fuv = fract(st);',
      '  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);',
      '  vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);',
      '  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);',
      '  vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);',
      '  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);',
      '}',
      'void main () {',
      '#ifdef MANUAL_FILTERING',
      '  vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;',
      '  vec4 result = bilerp(uSource, coord, dyeTexelSize);',
      '#else',
      '  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;',
      '  vec4 result = texture2D(uSource, coord);',
      '#endif',
      '  float decay = 1.0 + dissipation * dt;',
      '  gl_FragColor = result / decay;',
      '}',
    ].join('\n'),
    ext.supportLinearFiltering ? null : ['MANUAL_FILTERING'],
  );

  var divergenceShader = frag(
    [
      'uniform sampler2D uVelocity;',
      'void main () {',
      '  float L = texture2D(uVelocity, vL).x;',
      '  float R = texture2D(uVelocity, vR).x;',
      '  float T = texture2D(uVelocity, vT).y;',
      '  float B = texture2D(uVelocity, vB).y;',
      '  vec2 C = texture2D(uVelocity, vUv).xy;',
      '  if (vL.x < 0.0) { L = -C.x; }',
      '  if (vR.x > 1.0) { R = -C.x; }',
      '  if (vT.y > 1.0) { T = -C.y; }',
      '  if (vB.y < 0.0) { B = -C.y; }',
      '  float div = 0.5 * (R - L + T - B);',
      '  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);',
      '}',
    ].join('\n'),
  );

  var curlShader = frag(
    [
      'uniform sampler2D uVelocity;',
      'void main () {',
      '  float L = texture2D(uVelocity, vL).y;',
      '  float R = texture2D(uVelocity, vR).y;',
      '  float T = texture2D(uVelocity, vT).x;',
      '  float B = texture2D(uVelocity, vB).x;',
      '  float vorticity = R - L - T + B;',
      '  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);',
      '}',
    ].join('\n'),
  );

  var vorticityShader = frag(
    [
      'uniform sampler2D uVelocity;',
      'uniform sampler2D uCurl;',
      'uniform float curl;',
      'uniform float dt;',
      'void main () {',
      '  float L = texture2D(uCurl, vL).x;',
      '  float R = texture2D(uCurl, vR).x;',
      '  float T = texture2D(uCurl, vT).x;',
      '  float B = texture2D(uCurl, vB).x;',
      '  float C = texture2D(uCurl, vUv).x;',
      '  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));',
      '  force /= length(force) + 0.0001;',
      '  force *= curl * C;',
      '  force.y *= -1.0;',
      '  vec2 velocity = texture2D(uVelocity, vUv).xy;',
      '  velocity += force * dt;',
      '  velocity = min(max(velocity, -1000.0), 1000.0);',
      '  gl_FragColor = vec4(velocity, 0.0, 1.0);',
      '}',
    ].join('\n'),
  );

  var pressureShader = frag(
    [
      'uniform sampler2D uPressure;',
      'uniform sampler2D uDivergence;',
      'void main () {',
      '  float L = texture2D(uPressure, vL).x;',
      '  float R = texture2D(uPressure, vR).x;',
      '  float T = texture2D(uPressure, vT).x;',
      '  float B = texture2D(uPressure, vB).x;',
      '  float divergence = texture2D(uDivergence, vUv).x;',
      '  float pressure = (L + R + B + T - divergence) * 0.25;',
      '  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);',
      '}',
    ].join('\n'),
  );

  var gradientSubtractShader = frag(
    [
      'uniform sampler2D uPressure;',
      'uniform sampler2D uVelocity;',
      'void main () {',
      '  float L = texture2D(uPressure, vL).x;',
      '  float R = texture2D(uPressure, vR).x;',
      '  float T = texture2D(uPressure, vT).x;',
      '  float B = texture2D(uPressure, vB).x;',
      '  vec2 velocity = texture2D(uVelocity, vUv).xy;',
      '  velocity.xy -= vec2(R - L, T - B);',
      '  gl_FragColor = vec4(velocity, 0.0, 1.0);',
      '}',
    ].join('\n'),
  );

  var copyProgram = new Program(baseVertexShader, copyShader);
  var clearProgram = new Program(baseVertexShader, clearShader);
  var displayProgram = new Program(baseVertexShader, displayShader);
  var splatProgram = new Program(baseVertexShader, splatShader);
  var advectionProgram = new Program(baseVertexShader, advectionShader);
  var divergenceProgram = new Program(baseVertexShader, divergenceShader);
  var curlProgram = new Program(baseVertexShader, curlShader);
  var vorticityProgram = new Program(baseVertexShader, vorticityShader);
  var pressureProgram = new Program(baseVertexShader, pressureShader);
  var gradientSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);

  /* ---------------------------------------------------------------- */
  /* Quad plein écran                                                  */
  /* ---------------------------------------------------------------- */

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  /* ---------------------------------------------------------------- */
  /* Framebuffers                                                      */
  /* ---------------------------------------------------------------- */

  var dye, velocity, divergence, curl, pressure;

  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture: texture,
      fbo: fbo,
      width: w,
      height: h,
      texelSizeX: 1 / w,
      texelSizeY: 1 / h,
      attach: function (id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    var fbo1 = createFBO(w, h, internalFormat, format, type, param);
    var fbo2 = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w,
      height: h,
      texelSizeX: fbo1.texelSizeX,
      texelSizeY: fbo1.texelSizeY,
      get read() { return fbo1; },
      set read(v) { fbo1 = v; },
      get write() { return fbo2; },
      set write(v) { fbo2 = v; },
      swap: function () {
        var t = fbo1;
        fbo1 = fbo2;
        fbo2 = t;
      },
    };
  }

  function deleteFBO(target) {
    gl.deleteFramebuffer(target.fbo);
    gl.deleteTexture(target.texture);
  }

  function resizeFBO(target, w, h, internalFormat, format, type, param) {
    var next = createFBO(w, h, internalFormat, format, type, param);
    copyProgram.bind();
    gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
    blit(next);
    deleteFBO(target);
    return next;
  }

  function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
    if (target.width === w && target.height === h) return target;
    target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
    deleteFBO(target.write);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width = w;
    target.height = h;
    target.texelSizeX = 1 / w;
    target.texelSizeY = 1 / h;
    return target;
  }

  function getResolution(resolution) {
    var aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1) aspectRatio = 1 / aspectRatio;
    var min = Math.round(resolution);
    var max = Math.round(resolution * aspectRatio);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { width: max, height: min } : { width: min, height: max };
  }

  function initFramebuffers() {
    var simRes = getResolution(config.SIM_RESOLUTION);
    var dyeRes = getResolution(config.DYE_RESOLUTION);
    var texType = ext.halfFloatTexType;
    var rgba = ext.formatRGBA;
    var rg = ext.formatRG;
    var r = ext.formatR;
    var filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    gl.disable(gl.BLEND);

    dye = dye
      ? resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering)
      : createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    velocity = velocity
      ? resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering)
      : createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

    if (divergence) deleteFBO(divergence);
    if (curl) deleteFBO(curl);
    if (pressure) {
      deleteFBO(pressure.read);
      deleteFBO(pressure.write);
    }
    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curl = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  function step(dt) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (var i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    gradientSubtractProgram.bind();
    gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering) gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    var velocityId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    if (!ext.supportLinearFiltering) gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
  }

  function render() {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    displayProgram.bind();
    if (config.SHADING) gl.uniform2f(displayProgram.uniforms.texelSize, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
    gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
    blit(null);
  }

  function correctRadius(radius) {
    var aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1) radius *= aspectRatio;
    return radius;
  }

  /** Injecte vitesse (dx, dy) et couleur au point (x, y) ; color = null → vitesse seule. */
  function splat(x, y, dx, dy, color, radius) {
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0);
    gl.uniform1f(splatProgram.uniforms.radius, correctRadius((radius || config.SPLAT_RADIUS) / 100));
    blit(velocity.write);
    velocity.swap();

    if (!color) return;
    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
  }

  /* ---------------------------------------------------------------- */
  /* Pointeur                                                          */
  /* ---------------------------------------------------------------- */

  var pointer = { x: 0.5, y: 0.5, prevX: 0.5, prevY: 0.5, dx: 0, dy: 0, moved: false, color: generateColor() };

  function scaleByPixelRatio(input) {
    return Math.floor(input * (window.devicePixelRatio || 1));
  }

  function setPointer(clientX, clientY, reset) {
    var x = scaleByPixelRatio(clientX) / canvas.width;
    var y = 1 - scaleByPixelRatio(clientY) / canvas.height;
    var aspectRatio = canvas.width / canvas.height;
    pointer.prevX = reset ? x : pointer.x;
    pointer.prevY = reset ? y : pointer.y;
    pointer.x = x;
    pointer.y = y;
    pointer.dx = (x - pointer.prevX) * (aspectRatio < 1 ? aspectRatio : 1);
    pointer.dy = (y - pointer.prevY) / (aspectRatio > 1 ? aspectRatio : 1);
    pointer.moved = pointer.dx !== 0 || pointer.dy !== 0;
  }

  /* ---------------------------------------------------------------- */
  /* Boucle : démarrée par la souris, en pause après inactivité         */
  /* ---------------------------------------------------------------- */

  var running = false;
  var hasPosition = false;
  var lastUpdateTime = Date.now();
  var lastInputTime = 0;
  var colorUpdateTimer = 0;
  var pendingScroll = 0;
  var lastScrollY = window.scrollY;

  function resizeCanvas() {
    var width = scaleByPixelRatio(canvas.clientWidth);
    var height = scaleByPixelRatio(canvas.clientHeight);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      return true;
    }
    return false;
  }

  resizeCanvas();
  initFramebuffers();

  function update() {
    var now = Date.now();
    if (now - lastInputTime > config.IDLE_TIMEOUT) {
      running = false;
      return;
    }
    var dt = Math.min((now - lastUpdateTime) / 1000, 0.016666);
    lastUpdateTime = now;

    if (resizeCanvas()) initFramebuffers();

    colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
    if (colorUpdateTimer >= 1) {
      colorUpdateTimer %= 1;
      pointer.color = generateColor();
    }

    if (pointer.moved) {
      pointer.moved = false;
      splat(pointer.x, pointer.y, pointer.dx * config.SPLAT_FORCE, pointer.dy * config.SPLAT_FORCE, pointer.color);
    }

    // Défilement : large poussée verticale (sans couleur) pour que le fluide suive le contenu
    if (pendingScroll) {
      var shift = (scaleByPixelRatio(pendingScroll) / canvas.height) * config.SCROLL_FORCE;
      pendingScroll = 0;
      splat(0.5, 0.5, 0, shift, null, 60);
    }

    step(dt);
    render();
    requestAnimationFrame(update);
  }

  function wake() {
    lastInputTime = Date.now();
    if (!running) {
      running = true;
      lastUpdateTime = Date.now();
      requestAnimationFrame(update);
    }
  }

  window.addEventListener(
    'mousemove',
    function (e) {
      setPointer(e.clientX, e.clientY, !hasPosition); // 1er mouvement : pas de « saut » depuis le coin
      hasPosition = true;
      wake();
    },
    { passive: true },
  );

  window.addEventListener(
    'mousedown',
    function (e) {
      setPointer(e.clientX, e.clientY, true);
      hasPosition = true;
      wake();
      var c = generateColor();
      splat(pointer.x, pointer.y, 10 * (Math.random() - 0.5), 30 * (Math.random() - 0.5), { r: c.r * 10, g: c.g * 10, b: c.b * 10 });
    },
    { passive: true },
  );

  window.addEventListener(
    'scroll',
    function () {
      var y = window.scrollY;
      // Uniquement si du fluide est visible (la boucle tourne) : inutile de réveiller la simulation sinon
      if (running) {
        pendingScroll += y - lastScrollY;
        lastInputTime = Date.now();
      }
      lastScrollY = y;
    },
    { passive: true },
  );

  document.documentElement.addEventListener('mouseleave', function () {
    hasPosition = false;
  });
})();
