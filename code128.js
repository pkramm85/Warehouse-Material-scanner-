"use strict";
/* Code 128 barcode generator (no dependencies).
   Code 128 reads on every phone camera and every Bluetooth/USB scanner.
   Digits-only SKUs with an even length use the compact subset C; everything else uses subset B. */
window.Code128 = (function () {
  // Bar/space widths for symbols 0-106, alternating bar, space, bar, space, bar, space (106 = stop, 7 elements).
  const P = ("212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 " +
    "221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 " +
    "231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 " +
    "314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 " +
    "111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 " +
    "114131 311141 411131 211412 211214 211232 2331112").split(" ");
  const START_B = 104, START_C = 105, STOP = 106, CODE_C = 99, CODE_B = 100;

  function symbols(text) {
    const t = String(text);
    for (const ch of t) { const c = ch.charCodeAt(0); if (c < 32 || c > 126) throw new Error("Codes can only use letters, numbers and keyboard symbols."); }
    if (!t) throw new Error("Empty code.");
    const out = [];
    if (/^\d+$/.test(t) && t.length % 2 === 0 && t.length >= 4) {
      out.push(START_C);
      for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 10));
    } else {
      out.push(START_B);
      for (const ch of t) out.push(ch.charCodeAt(0) - 32);
    }
    let sum = out[0];
    for (let i = 1; i < out.length; i++) sum += out[i] * i;
    out.push(sum % 103, STOP);
    return out;
  }

  // Returns an SVG string. `module` is the width of the thinnest bar in px.
  function svg(text, { module = 2, height = 60 } = {}) {
    const quiet = 10 * module;
    let x = quiet, bars = "";
    symbols(text).forEach(s => {
      [...P[s]].forEach((w, i) => {
        const wd = +w * module;
        if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${wd}" height="${height}"/>`;
        x += wd;
      });
    });
    const W = x + quiet;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" preserveAspectRatio="none" role="img" aria-label="Barcode ${String(text).replace(/[<>&"]/g, "")}"><rect width="${W}" height="${height}" fill="#fff"/><g fill="#000">${bars}</g></svg>`;
  }
  return { svg, symbols, patterns: P };
})();
