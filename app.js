'use strict';

/* ---------- pdf.js worker setup ----------
   Under file:// Chrome can be picky about loading dedicated workers.
   pdf.js falls back to an in-main-thread "fake worker" automatically if the
   real worker fails to start, so pointing workerSrc at the local file is
   enough; if that still fails entirely, the catch block in handleFile()
   surfaces a message pointing to the README's local-server fallback. */
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const POINTS_TO_METERS = 0.0254 / 72;
const POINTS_TO_MM = 25.4 / 72;
const BEZIER_SEGMENTS = 24;
const DUP_ROUND_PT = 0.5; // ~0.18mm, rounding grid for duplicate signatures

// Loose hue-based colour matching (per user request: no strict CMYK match).
// A stroke counts as "red" or "green" if its hue falls in these windows and
// it's saturated enough to not be black/white/gray.
const RED_HUE_MAX = 35; // hue <= this OR hue >= (360 - this)
const GREEN_HUE_MIN = 75;
const GREEN_HUE_MAX = 165;
const MIN_SATURATION = 0.15;

const OTHER_PATH_POINT_BUDGET = 20000; // caps diagnostic (ignored-colour) preview data per page

const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

const PAPER_SIZES_MM = [
  ['A0', 841, 1189],
  ['A1', 594, 841],
  ['A2', 420, 594],
  ['A3', 297, 420],
  ['A4', 210, 297],
  ['A5', 148, 210],
  ['A6', 105, 148],
  ['Letter', 215.9, 279.4],
  ['Legal', 215.9, 355.6],
  ['Tabloid', 279.4, 431.8],
];

// Typical names print shops give the technical cut/crease layer, as opposed
// to the design/artwork layer — checked as whole-word matches (not bare
// substrings) so a layer literally named e.g. "Cutouts" or "Discount" isn't
// mistaken for a dieline layer.
const DIE_LAYER_KEYWORDS = [
  'крой', 'штанц', 'вырубка', 'нож', 'биговка',
  'kroj', 'sht', 'shanc', 'vyrubka', 'nozh',
  'dieline', 'die line', 'die-line', 'die cut', 'die-cut',
  'score', 'crease', 'knife', 'cut',
];

function isWordChar(ch) {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

function layerNameMatchesDieline(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return DIE_LAYER_KEYWORDS.some((kw) => {
    const idx = lower.indexOf(kw);
    if (idx === -1) return false;
    const before = idx > 0 ? lower[idx - 1] : '';
    const after = idx + kw.length < lower.length ? lower[idx + kw.length] : '';
    return !isWordChar(before) && !isWordChar(after);
  });
}

// Looks at the document's OCG (layer) structure and decides how to isolate
// the dieline layer's geometry from any design/artwork layers:
//  - 'none'   — no layers in the document at all; nothing to isolate, the
//               whole file is scanned (today's behaviour).
//  - 'auto'   — exactly one layer name matched a known dieline keyword.
//  - 'manual' — layers exist but none matched; the caller must ask the user.
async function resolveDieLayer(pdfDoc) {
  let ocConfig = null;
  try {
    ocConfig = await pdfDoc.getOptionalContentConfig();
  } catch (err) {
    console.warn('OCG lookup failed, proceeding without layer filtering:', err);
  }
  const groups = ocConfig ? ocConfig.getGroups() : null;
  const list = groups ? Object.entries(groups).map(([id, g]) => ({ id, name: g.name || '' })) : [];

  if (list.length === 0) {
    return { status: 'none', ocgId: null, layerName: null, groups: [] };
  }
  const match = list.find((g) => layerNameMatchesDieline(g.name));
  if (match) {
    return { status: 'auto', ocgId: match.id, layerName: match.name, groups: list };
  }
  return { status: 'needs-manual', ocgId: null, layerName: null, groups: list };
}

/* ---------- DOM references ---------- */

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const fileInfo = document.getElementById('fileInfo');
const fileMetaEl = document.getElementById('fileMeta');
const layerPickerEl = document.getElementById('layerPicker');
const layerSelectEl = document.getElementById('layerSelect');
const layerConfirmBtnEl = document.getElementById('layerConfirmBtn');
const progressEl = document.getElementById('progress');
const progressTextEl = document.getElementById('progressText');
const errorBox = document.getElementById('errorBox');
const noticeBox = document.getElementById('noticeBox');
const resultsSection = document.getElementById('resultsSection');
const pagesBreakdownEl = document.getElementById('pagesBreakdown');

let lastResult = null; // { fileName, pages: [{index, red, green, otherCount}], totalRed, totalGreen, detection }

/* ---------- File input wiring ---------- */

function updateBrowseBtnLabel() {
  browseBtn.textContent = lastResult ? 'Заменить файл' : 'Выбрать файл';
}

browseBtn.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('click', (e) => {
  if (e.target === browseBtn) return;
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) {
    handleFile(fileInput.files[0]);
  }
});

// The droppable area covers the whole page (not just the small dropzone
// box) so a file can be dropped anywhere — except on top of an existing
// result block, where a drop would just be confusing next to the price
// input/buttons there. The small dropzone box stays as the only visual
// highlight while dragging, so the rest of the page stays visually calm.
function isOverResultBlock(target) {
  return !!(target && target.closest && target.closest('.page-report-card'));
}

['dragenter', 'dragover'].forEach((evt) => {
  document.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.toggle('dragover', !isOverResultBlock(e.target));
  });
});

document.addEventListener('dragleave', (e) => {
  if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
    dropzone.classList.remove('dragover');
  }
});

document.addEventListener('dragend', () => dropzone.classList.remove('dragover'));

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (isOverResultBlock(e.target)) return;
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

/* ---------- Error / notice helpers ---------- */

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}
function hideError() {
  errorBox.classList.add('hidden');
  errorBox.textContent = '';
}
function showNotice(message) {
  noticeBox.textContent = message;
  noticeBox.classList.remove('hidden');
}
function hideNotice() {
  noticeBox.classList.add('hidden');
  noticeBox.textContent = '';
}
function showProgress(text) {
  progressTextEl.textContent = text;
  progressEl.classList.remove('hidden');
}
function hideProgress() {
  progressEl.classList.add('hidden');
}

/* ---------- Main file handling flow ---------- */

// Shows the layer picker and resolves once the user confirms a choice.
// Picking the explicit "whole file" option resolves ocgId to null.
function promptLayerChoice(groups) {
  return new Promise((resolve) => {
    layerSelectEl.innerHTML = '';
    groups.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name || `(без имени, id ${g.id})`;
      layerSelectEl.appendChild(opt);
    });
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'Весь файл (без фильтра по слоям)';
    layerSelectEl.appendChild(allOpt);

    layerPickerEl.classList.remove('hidden');

    function onConfirm() {
      layerConfirmBtnEl.removeEventListener('click', onConfirm);
      layerPickerEl.classList.add('hidden');
      const chosenId = layerSelectEl.value || null;
      const chosenGroup = groups.find((g) => g.id === chosenId);
      resolve({ ocgId: chosenId, layerName: chosenGroup ? chosenGroup.name : null });
    }
    layerConfirmBtnEl.addEventListener('click', onConfirm);
  });
}

async function handleFile(file) {
  hideError();
  hideNotice();
  resultsSection.classList.add('hidden');
  pagesBreakdownEl.innerHTML = '';
  layerPickerEl.classList.add('hidden');
  lastResult = null;

  const name = file.name || 'файл';
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  if (ext !== '.pdf' && ext !== '.ai') {
    showError('Неподдерживаемый формат файла. Загрузите файл .pdf или .ai.');
    return;
  }

  fileMetaEl.textContent = formatFileSize(file.size);
  fileInfo.classList.remove('hidden');

  showProgress('Загрузка файла…');

  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch (err) {
    hideProgress();
    showError('Не удалось прочитать файл с диска.');
    return;
  }

  let pdfDoc;
  try {
    showProgress('Открытие документа…');
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    hideProgress();
    console.error('PDF open error:', err);
    showError(
      "Не удалось открыть файл. Убедитесь, что AI-файл сохранён с опцией «PDF-совместимый», " +
      "либо что файл не повреждён. Если ошибка связана с загрузкой в браузере через file://, " +
      "попробуйте открыть приложение через локальный сервер (см. README)."
    );
    return;
  }

  const pageCount = pdfDoc.numPages;
  fileMetaEl.textContent = `${formatFileSize(file.size)} · страниц: ${pageCount}`;

  showProgress('Проверка слоёв документа…');
  let layerInfo = await resolveDieLayer(pdfDoc);

  if (layerInfo.status === 'needs-manual') {
    hideProgress();
    const choice = await promptLayerChoice(layerInfo.groups);
    showProgress('Обработка файла…');
    layerInfo = {
      status: choice.ocgId ? 'manual' : 'none',
      ocgId: choice.ocgId,
      layerName: choice.layerName,
      groups: layerInfo.groups,
    };
  }

  const pages = [];
  let totalRed = 0;
  let totalGreen = 0;
  let totalOther = 0;

  try {
    for (let i = 1; i <= pageCount; i++) {
      showProgress(`Обработка страницы ${i} из ${pageCount}…`);
      // Yield to the event loop so the progress text actually paints.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const page = await pdfDoc.getPage(i);
      const opList = await page.getOperatorList();
      const pageResult = analyzeOperatorList(opList, layerInfo.ocgId);

      // viewport at scale 1 already bakes in the page's own /Rotate, so its
      // width/height and transform match what a viewer would show on screen —
      // this is the page's mounting/media area, in points.
      const viewport = page.getViewport({ scale: 1 });
      const wmm = viewport.width * POINTS_TO_MM;
      const hmm = viewport.height * POINTS_TO_MM;

      const sheetAreaMm2 = wmm * hmm;
      const fillAreaMm2 = computeFillAreaPt2(pageResult.redPaths, viewport.width, viewport.height) * POINTS_TO_MM * POINTS_TO_MM;
      const fillPercent = sheetAreaMm2 > 0 ? Math.min(100, Math.max(0, (fillAreaMm2 / sheetAreaMm2) * 100)) : 0;

      pages.push({
        index: i,
        red: pageResult.red,
        green: pageResult.green,
        otherCount: pageResult.otherCount,
        redPaths: pageResult.redPaths,
        greenPaths: pageResult.greenPaths,
        otherPaths: pageResult.otherPaths,
        box: {
          widthPt: viewport.width,
          heightPt: viewport.height,
          widthMm: wmm,
          heightMm: hmm,
          format: detectPaperFormat(wmm, hmm),
          transform: viewport.transform,
        },
        area: {
          sheetM2: sheetAreaMm2 / 1e6,
          fillM2: fillAreaMm2 / 1e6,
          fillPercent,
          wastePercent: 100 - fillPercent,
        },
      });

      totalRed += pageResult.red;
      totalGreen += pageResult.green;
      totalOther += pageResult.otherCount;
    }
  } catch (err) {
    hideProgress();
    console.error('PDF parse error:', err);
    showError('Ошибка при разборе содержимого файла. Файл может быть повреждён или использовать неподдерживаемые функции PDF.');
    return;
  }

  hideProgress();

  if (totalOther > 0) {
    console.info(`Прочие линии (не нож/биговка): ${totalOther} шт.`);
  }

  if (totalRed === 0 && totalGreen === 0) {
    showNotice('Векторные линии биговки/ножа не найдены.');
  }

  lastResult = {
    fileName: name,
    pages,
    totalRed,
    totalGreen,
    totalOther,
    detection: layerInfo,
  };

  updateBrowseBtnLabel();
  renderResults();
  resultsSection.classList.remove('hidden');
}

function formatDetectionLabel(detection) {
  if (!detection) return null;
  if (detection.status === 'auto') return `Слой «${detection.layerName}» (определено автоматически)`;
  if (detection.status === 'manual') return `Слой «${detection.layerName}» (выбрано вручную)`;
  return null;
}

function detectPaperFormat(wmm, hmm) {
  const tol = 3; // mm
  for (const [name, a, b] of PAPER_SIZES_MM) {
    if ((Math.abs(wmm - a) <= tol && Math.abs(hmm - b) <= tol) ||
        (Math.abs(wmm - b) <= tol && Math.abs(hmm - a) <= tol)) {
      return name;
    }
  }
  return 'Пользовательский';
}

function formatSheetLabel(box) {
  const dims = `${box.widthMm.toFixed(0)} × ${box.heightMm.toFixed(0)} мм`;
  if (box.format === 'Пользовательский') return `Формат печатного листа: ${dims}`;
  return `Формат печатного листа: ${box.format}, ${dims}`;
}

function formatAreaLines(area) {
  return [
    `Площадь листа: ${area.sheetM2.toFixed(3)} м²`,
    `Заполнение: ${area.fillM2.toFixed(3)} м² (${area.fillPercent.toFixed(1)}%)`,
    `Отход: ${area.wastePercent.toFixed(1)}%`,
  ];
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} байт`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

/* ---------- Operator list analysis ----------
   pdf.js batches path-construction operators (m/l/c/v/y/h/re) into a single
   OPS.constructPath entry: args = [subOpCodes, flatCoordsArray]. Everything
   else (color, save/restore/transform, paint ops) stays one entry per op. */

function analyzeOperatorList(opList, targetOcgId) {
  const OPS = pdfjsLib.OPS;
  const fnArray = opList.fnArray;
  const argsArray = opList.argsArray;

  let ctm = IDENTITY_MATRIX;
  const ctmStack = [];

  // When a specific dieline layer was identified, only geometry marked as
  // belonging to that OCG (optional content group) counts — everything
  // else (design/artwork content on other layers) is skipped entirely, not
  // just excluded from red/green but not even shown as "other".
  const ocStack = [];
  function insideTargetLayer() {
    return !targetOcgId || ocStack.includes(targetOcgId);
  }

  let strokeCMYK = null;
  let strokeColorSpaceName = null;
  const colorStack = [];

  let pendingSubpaths = [];

  const buckets = {
    red: { length: 0, seen: new Set(), paths: [] },
    green: { length: 0, seen: new Set(), paths: [] },
  };
  let otherCount = 0;
  const otherPaths = [];
  let otherPointBudget = OTHER_PATH_POINT_BUDGET;

  function applyCtm(x, y) {
    return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  }

  // Combines two PDF matrices so that `first` is applied before `second`.
  function matMul(first, second) {
    return [
      first[0] * second[0] + first[1] * second[2],
      first[0] * second[1] + first[1] * second[3],
      first[2] * second[0] + first[3] * second[2],
      first[2] * second[1] + first[3] * second[3],
      first[4] * second[0] + first[5] * second[2] + second[4],
      first[4] * second[1] + first[5] * second[3] + second[5],
    ];
  }

  function buildSubpaths(subOps, coords) {
    const subpaths = [];
    let current = null;
    let startX = 0, startY = 0, curX = 0, curY = 0;
    let o = 0;

    for (let i = 0; i < subOps.length; i++) {
      const op = subOps[i];
      switch (op) {
        case OPS.rectangle: {
          const x = coords[o++], y = coords[o++];
          const w = coords[o++], h = coords[o++];
          const poly = [
            applyCtm(x, y),
            applyCtm(x + w, y),
            applyCtm(x + w, y + h),
            applyCtm(x, y + h),
            applyCtm(x, y),
          ];
          subpaths.push(poly);
          startX = x; startY = y; curX = x; curY = y;
          current = null;
          break;
        }
        case OPS.moveTo: {
          const x = coords[o++], y = coords[o++];
          current = [applyCtm(x, y)];
          subpaths.push(current);
          startX = x; startY = y; curX = x; curY = y;
          break;
        }
        case OPS.lineTo: {
          const x = coords[o++], y = coords[o++];
          if (!current) { current = [applyCtm(curX, curY)]; subpaths.push(current); }
          current.push(applyCtm(x, y));
          curX = x; curY = y;
          break;
        }
        case OPS.curveTo: {
          const x1 = coords[o++], y1 = coords[o++];
          const x2 = coords[o++], y2 = coords[o++];
          const x3 = coords[o++], y3 = coords[o++];
          if (!current) { current = [applyCtm(curX, curY)]; subpaths.push(current); }
          appendBezier(current, [curX, curY], [x1, y1], [x2, y2], [x3, y3]);
          curX = x3; curY = y3;
          break;
        }
        case OPS.curveTo2: {
          const x2 = coords[o++], y2 = coords[o++];
          const x3 = coords[o++], y3 = coords[o++];
          if (!current) { current = [applyCtm(curX, curY)]; subpaths.push(current); }
          appendBezier(current, [curX, curY], [curX, curY], [x2, y2], [x3, y3]);
          curX = x3; curY = y3;
          break;
        }
        case OPS.curveTo3: {
          const x1 = coords[o++], y1 = coords[o++];
          const x3 = coords[o++], y3 = coords[o++];
          if (!current) { current = [applyCtm(curX, curY)]; subpaths.push(current); }
          appendBezier(current, [curX, curY], [x1, y1], [x3, y3], [x3, y3]);
          curX = x3; curY = y3;
          break;
        }
        case OPS.closePath: {
          if (current && current.length > 0) {
            current.push(applyCtm(startX, startY));
          }
          curX = startX; curY = startY;
          break;
        }
        default:
          break;
      }
    }
    return subpaths;
  }

  function appendBezier(target, p0, p1, p2, p3) {
    for (let i = 1; i <= BEZIER_SEGMENTS; i++) {
      const t = i / BEZIER_SEGMENTS;
      const mt = 1 - t;
      const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
      const x = a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0];
      const y = a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1];
      target.push(applyCtm(x, y));
    }
  }

  function closeLastSubpath() {
    if (!pendingSubpaths.length) return;
    const sp = pendingSubpaths[pendingSubpaths.length - 1];
    if (sp.length === 0) return;
    const start = sp[0];
    const last = sp[sp.length - 1];
    if (Math.abs(start[0] - last[0]) > 1e-6 || Math.abs(start[1] - last[1]) > 1e-6) {
      sp.push(start);
    }
  }

  function paintCurrentPath() {
    if (!pendingSubpaths.length) return;
    if (!insideTargetLayer()) {
      pendingSubpaths = [];
      return;
    }
    const color = classifyColor(strokeCMYK);
    if (!color) {
      for (const sp of pendingSubpaths) {
        if (sp.length < 2) continue;
        otherCount++;
        if (otherPointBudget > 0) {
          otherPaths.push(sp);
          otherPointBudget -= sp.length;
        }
      }
      pendingSubpaths = [];
      return;
    }
    const bucket = buckets[color];
    for (const sp of pendingSubpaths) {
      if (sp.length < 2) continue;
      const len = polylineLength(sp);
      if (len < 0.01) continue;
      const sig = subpathSignature(sp, len);
      if (bucket.seen.has(sig)) continue;
      bucket.seen.add(sig);
      bucket.length += len;
      bucket.paths.push(sp);
    }
    pendingSubpaths = [];
  }

  for (let i = 0; i < fnArray.length; i++) {
    const f = fnArray[i];
    const a = argsArray[i];

    switch (f) {
      case OPS.save:
        ctmStack.push(ctm);
        colorStack.push({ strokeCMYK, strokeColorSpaceName });
        break;

      case OPS.restore:
        ctm = ctmStack.pop() || IDENTITY_MATRIX;
        {
          const cs = colorStack.pop();
          if (cs) { strokeCMYK = cs.strokeCMYK; strokeColorSpaceName = cs.strokeColorSpaceName; }
        }
        break;

      case OPS.transform:
        ctm = matMul(a, ctm);
        break;

      case OPS.beginMarkedContentProps:
        ocStack.push(a[0] === 'OC' && a[1] && a[1].id ? a[1].id : null);
        break;

      case OPS.beginMarkedContent:
        ocStack.push(null);
        break;

      case OPS.endMarkedContent:
        ocStack.pop();
        break;

      case OPS.constructPath:
        pendingSubpaths = pendingSubpaths.concat(buildSubpaths(a[0], a[1]));
        break;

      case OPS.setStrokeColorSpace:
        strokeColorSpaceName = (a[0] && a[0].name) || null;
        break;

      case OPS.setStrokeCMYKColor:
        strokeCMYK = normalizeCMYK(a);
        break;

      case OPS.setStrokeRGBColor:
        strokeCMYK = rgbToCmyk(normalizeRGB(a));
        break;

      case OPS.setStrokeGray: {
        const g = normalizeChannel(a[0]);
        strokeCMYK = rgbToCmyk([g * 2.55, g * 2.55, g * 2.55]);
        break;
      }

      case OPS.setStrokeColor:
      case OPS.setStrokeColorN:
        strokeCMYK = interpretColorN(a, strokeColorSpaceName);
        break;

      case OPS.stroke:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
        paintCurrentPath();
        break;

      case OPS.closeStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        closeLastSubpath();
        paintCurrentPath();
        break;

      case OPS.fill:
      case OPS.eoFill:
      case OPS.endPath:
        pendingSubpaths = [];
        break;

      default:
        break;
    }
  }

  return {
    red: buckets.red.length * POINTS_TO_METERS,
    green: buckets.green.length * POINTS_TO_METERS,
    otherCount,
    redPaths: buckets.red.paths,
    greenPaths: buckets.green.paths,
    otherPaths,
  };
}

/* ---------- Geometry helpers ---------- */

function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return len;
}

function subpathSignature(points, len) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sumX += x;
    sumY += y;
  }
  const midX = sumX / points.length;
  const midY = sumY / points.length;
  const r = (v) => Math.round(v / DUP_ROUND_PT) * DUP_ROUND_PT;
  return `${Math.round(len * 10)}|${r(minX)},${r(minY)},${r(maxX)},${r(maxY)}|${r(midX)},${r(midY)}`;
}

// Real die-cutting knife lines deliberately leave small uncut "nick" bridges
// (~0.5-9mm observed in real files) so the piece doesn't fall out of the
// sheet during cutting — the path is never meant to be 100% physically
// continuous. Reconstructing exact closed polygons by stitching fragment
// endpoints together turned out to be fragile on real multi-shape sheets:
// once the join tolerance is opened up enough to bridge a real nick gap,
// busy junctions (several tabs/notches meeting near the same point, or two
// separate parts placed close together) offer multiple plausible matches,
// and a wrong pick anywhere silently produces a self-intersecting loop with
// a wrong (sometimes near-zero) shoelace area.
//
// computeFillAreaPt2 sidesteps that entirely: it rasterizes the knife
// strokes onto an offscreen canvas and flood-fills inward from the sheet's
// own border, exactly like a paint-bucket tool — whatever the flood fill
// can't reach is "enclosed". Nick gaps are bridged by explicitly drawing a
// short connector between any two fragment endpoints that land close to
// each other, rather than by drawing every stroke extra-thick — a thick
// stroke would "bridge" gaps too, but it also eats into the interior along
// every ordinary (already-closed) edge, systematically undercounting the
// area. Thin strokes plus targeted connectors keep the measured boundary
// accurate while still closing the real gaps.
const AREA_RASTER_PT = 2; // ~0.7mm per cell at full resolution
const AREA_RASTER_MAX_DIM = 1400; // cap grid size; resolution coarsens automatically past this
const AREA_LINE_PX = 1.5; // stroke width in raster pixels — just enough to avoid aliasing gaps
const AREA_BRIDGE_TOLERANCE_PT = 32; // ~11mm, comfortably above observed nick gaps (up to ~9mm)

function computeFillAreaPt2(redPaths, sheetWidthPt, sheetHeightPt) {
  if (!redPaths || !redPaths.length || !(sheetWidthPt > 0) || !(sheetHeightPt > 0)) return 0;

  const scaleDown = Math.max(1, sheetWidthPt / AREA_RASTER_PT / AREA_RASTER_MAX_DIM, sheetHeightPt / AREA_RASTER_PT / AREA_RASTER_MAX_DIM);
  const cellPt = AREA_RASTER_PT * scaleDown;
  const cols = Math.max(1, Math.round(sheetWidthPt / cellPt));
  const rows = Math.max(1, Math.round(sheetHeightPt / cellPt));

  const bridgeTolSq = AREA_BRIDGE_TOLERANCE_PT * AREA_BRIDGE_TOLERANCE_PT;
  const endpoints = [];
  for (const p of redPaths) {
    if (p && p.length >= 2) { endpoints.push(p[0], p[p.length - 1]); }
  }
  const bridges = [];
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const dx = endpoints[i][0] - endpoints[j][0], dy = endpoints[i][1] - endpoints[j][1];
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.0001 && d2 <= bridgeTolSq) bridges.push([endpoints[i], endpoints[j]]);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cols, rows);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = AREA_LINE_PX;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const scale = 1 / cellPt;
  for (const path of redPaths) {
    if (!path || path.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(path[0][0] * scale, path[0][1] * scale);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0] * scale, path[i][1] * scale);
    ctx.stroke();
  }
  for (const [a, b] of bridges) {
    ctx.beginPath();
    ctx.moveTo(a[0] * scale, a[1] * scale);
    ctx.lineTo(b[0] * scale, b[1] * scale);
    ctx.stroke();
  }

  const img = ctx.getImageData(0, 0, cols, rows).data;
  const cellCount = cols * rows;
  const isWall = new Uint8Array(cellCount);
  for (let i = 0, p = 0; i < cellCount; i++, p += 4) {
    isWall[i] = (img[p] < 250 || img[p + 1] < 250 || img[p + 2] < 250) ? 1 : 0;
  }

  // Flood-fill "outside" inward from every border cell (iterative, to avoid
  // recursion limits on large grids).
  const outside = new Uint8Array(cellCount);
  const stack = [];
  function pushIfOpen(x, y) {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return;
    const idx = y * cols + x;
    if (outside[idx] || isWall[idx]) return;
    outside[idx] = 1;
    stack.push(idx);
  }
  for (let x = 0; x < cols; x++) { pushIfOpen(x, 0); pushIfOpen(x, rows - 1); }
  for (let y = 0; y < rows; y++) { pushIfOpen(0, y); pushIfOpen(cols - 1, y); }
  while (stack.length) {
    const idx = stack.pop();
    const x = idx % cols, y = (idx / cols) | 0;
    pushIfOpen(x + 1, y); pushIfOpen(x - 1, y); pushIfOpen(x, y + 1); pushIfOpen(x, y - 1);
  }

  let insideCells = 0;
  for (let i = 0; i < cellCount; i++) {
    if (!outside[i] && !isWall[i]) insideCells++;
  }

  return insideCells * cellPt * cellPt;
}

/* ---------- Color helpers ---------- */

function normalizeChannel(v) {
  if (v == null || Number.isNaN(v)) return 0;
  return v > 1.5 ? v : v * 100;
}

function normalizeCMYK(a) {
  return {
    c: normalizeChannel(a[0]),
    m: normalizeChannel(a[1]),
    y: normalizeChannel(a[2]),
    k: normalizeChannel(a[3]),
  };
}

function normalizeRGB(a) {
  const r = a[0] || 0, g = a[1] || 0, b = a[2] || 0;
  const max = Math.max(r, g, b);
  if (max <= 1.5) return [r * 255, g * 255, b * 255];
  return [r, g, b];
}

function rgbToCmyk([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: ((1 - r - k) / (1 - k)) * 100,
    m: ((1 - g - k) / (1 - k)) * 100,
    y: ((1 - b - k) / (1 - k)) * 100,
    k: k * 100,
  };
}

function interpretColorN(a, csName) {
  const nums = a.filter((v) => typeof v === 'number');
  if (csName === 'DeviceCMYK' && nums.length >= 4) return normalizeCMYK(nums);
  if (csName === 'DeviceRGB' && nums.length >= 3) return rgbToCmyk(normalizeRGB(nums));
  if (csName === 'DeviceGray' && nums.length >= 1) {
    const g = normalizeChannel(nums[0]);
    return rgbToCmyk([g * 2.55, g * 2.55, g * 2.55]);
  }
  // Unknown color space (e.g. spot/Separation) — fall back to component count.
  if (nums.length === 4) return normalizeCMYK(nums);
  if (nums.length === 3) return rgbToCmyk(normalizeRGB(nums));
  return null;
}

function cmykToRgb(cmyk) {
  const c = cmyk.c / 100, m = cmyk.m / 100, y = cmyk.y / 100, k = cmyk.k / 100;
  return [
    255 * (1 - c) * (1 - k),
    255 * (1 - m) * (1 - k),
    255 * (1 - y) * (1 - k),
  ];
}

// Standard RGB -> HSL hue/saturation (lightness unused here).
function rgbToHueSat(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return { hue: 0, sat: 0 };
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  const l = (max + min) / 2;
  const sat = d / (1 - Math.abs(2 * l - 1));
  return { hue: h, sat };
}

// Loose match: any stroke that's "red-ish" or "green-ish" by hue, as long as
// it's not too close to black/white/gray. No strict CMYK/RGB equality check —
// this deliberately tolerates spot colours, RGB-defined strokes, slightly
// off-hue reds/greens, etc.
function classifyColor(cmyk) {
  if (!cmyk) return null;
  const [r, g, b] = cmykToRgb(cmyk);
  const { hue, sat } = rgbToHueSat(r, g, b);
  if (sat < MIN_SATURATION) return null;
  if (hue <= RED_HUE_MAX || hue >= 360 - RED_HUE_MAX) return 'red';
  if (hue >= GREEN_HUE_MIN && hue <= GREEN_HUE_MAX) return 'green';
  return null;
}

/* ---------- Rendering ----------
   Each page in the file gets its own fully self-contained report block —
   own price input, own summary tiles, own cost block, own preview/area
   stats, own export buttons — so a multi-page file reads as N independent
   single-page reports rather than one shared total. */

function pageDisplayTitle(page, totalPages) {
  if (totalPages > 1) return `${lastResult.fileName} (Монтажная область ${page.index})`;
  return lastResult.fileName;
}

function buildSummaryTileEl(labelText, dotClass) {
  const tile = document.createElement('div');
  tile.className = 'summary-tile';

  const label = document.createElement('span');
  label.className = 'summary-label';
  if (dotClass) {
    const dot = document.createElement('span');
    dot.className = `dot ${dotClass}`;
    label.appendChild(dot);
  }
  label.appendChild(document.createTextNode(labelText));

  const value = document.createElement('span');
  value.className = 'summary-value';
  value.textContent = '0.00';

  const unit = document.createElement('span');
  unit.className = 'summary-unit';
  unit.textContent = 'м.п.';

  tile.append(label, value, unit);
  return { el: tile, valueEl: value };
}

function buildPageReportBlock(page, totalPages) {
  const displayTitle = pageDisplayTitle(page, totalPages);
  const baseFileName = (lastResult.fileName || 'report').replace(/\.[^.]+$/, '');
  const downloadBase = totalPages > 1 ? `${baseFileName}_p${page.index}` : baseFileName;

  const card = document.createElement('div');
  card.className = 'card page-report-card';

  const title = document.createElement('h2');
  title.className = 'results-file-title';
  title.textContent = displayTitle;
  card.appendChild(title);

  const detectionLabel = formatDetectionLabel(lastResult.detection);
  if (detectionLabel) {
    const detectionEl = document.createElement('p');
    detectionEl.className = 'detection-label';
    detectionEl.textContent = detectionLabel;
    card.appendChild(detectionEl);
  }

  const priceRow = document.createElement('div');
  priceRow.className = 'price-row';
  const priceLabel = document.createElement('span');
  priceLabel.className = 'price-label';
  priceLabel.textContent = 'Стоимость ножа за 1 м.п.';
  const priceWrap = document.createElement('div');
  priceWrap.className = 'price-input-wrap';
  const priceInputEl = document.createElement('input');
  priceInputEl.type = 'number';
  priceInputEl.className = 'price-input';
  priceInputEl.min = '0';
  priceInputEl.step = '0.01';
  priceInputEl.value = '0';
  priceInputEl.inputMode = 'decimal';
  const priceUnit = document.createElement('span');
  priceUnit.className = 'price-unit';
  priceUnit.textContent = 'грн.';
  priceWrap.append(priceInputEl, priceUnit);
  priceRow.append(priceLabel, priceWrap);
  card.appendChild(priceRow);

  const grid = document.createElement('div');
  grid.className = 'summary-grid';
  const greenTile = buildSummaryTileEl('Биговка', 'dot-green');
  const redTile = buildSummaryTileEl('Нож', 'dot-red');
  const allTile = buildSummaryTileEl('Общая длина', null);
  grid.append(greenTile.el, redTile.el, allTile.el);
  card.appendChild(grid);

  const hero = document.createElement('div');
  hero.className = 'cost-hero';
  const heroLabel = document.createElement('span');
  heroLabel.className = 'cost-label';
  heroLabel.textContent = 'Стоимость штанцформы';
  const heroSup = document.createElement('sup');
  heroSup.className = 'cost-label-asterisk';
  heroSup.textContent = '*';
  heroLabel.appendChild(heroSup);
  const costValueEl = document.createElement('span');
  costValueEl.textContent = '0';
  const heroUnit = document.createElement('span');
  heroUnit.className = 'cost-unit';
  heroUnit.textContent = 'грн.';
  const heroValue = document.createElement('span');
  heroValue.className = 'cost-value';
  heroValue.append(costValueEl, document.createTextNode(' '), heroUnit);
  hero.append(heroLabel, heroValue);
  card.appendChild(hero);

  const footnote = document.createElement('p');
  footnote.className = 'cost-footnote';
  footnote.textContent = '* Приблизительная стоимость. Точная стоимость будет известна после просчёта у подрядчика.';
  card.appendChild(footnote);

  const pageInfoCard = document.createElement('div');
  pageInfoCard.className = 'page-card';

  const info = document.createElement('div');
  info.className = 'page-info';
  const format = document.createElement('span');
  format.className = 'page-format';
  format.textContent = formatSheetLabel(page.box);
  info.appendChild(format);
  if (page.red === 0 && page.green === 0) {
    const empty = document.createElement('span');
    empty.className = 'page-row-empty';
    empty.textContent = 'линии не найдены';
    info.appendChild(empty);
  }
  pageInfoCard.appendChild(info);

  const preview = document.createElement('div');
  preview.className = 'page-preview';
  const canvas = document.createElement('canvas');
  preview.appendChild(canvas);
  pageInfoCard.appendChild(preview);
  drawPagePreview(canvas, page);

  const areaEl = document.createElement('div');
  areaEl.className = 'page-area';
  formatAreaLines(page.area).forEach((line) => {
    const row = document.createElement('span');
    row.textContent = line;
    areaEl.appendChild(row);
  });
  pageInfoCard.appendChild(areaEl);

  card.appendChild(pageInfoCard);

  const actions = document.createElement('div');
  actions.className = 'actions-row';
  const copyBtnEl = document.createElement('button');
  copyBtnEl.type = 'button';
  copyBtnEl.className = 'btn btn-primary';
  copyBtnEl.textContent = 'Скопировать результат';
  const reportBtnEl = document.createElement('button');
  reportBtnEl.type = 'button';
  reportBtnEl.className = 'btn btn-secondary';
  reportBtnEl.textContent = 'Скачать отчёт (PNG)';
  const copyReportBtnEl = document.createElement('button');
  copyReportBtnEl.type = 'button';
  copyReportBtnEl.className = 'btn btn-secondary';
  copyReportBtnEl.textContent = 'Скопировать отчёт (PNG)';
  const feedback = document.createElement('span');
  feedback.className = 'copy-feedback';
  actions.append(copyBtnEl, reportBtnEl, copyReportBtnEl, feedback);
  card.appendChild(actions);

  function getPrice() {
    return parseFloat(priceInputEl.value) || 0;
  }

  function recompute() {
    const price = getPrice();
    const totalAll = page.green + page.red;
    const totalCost = Math.round(totalAll * price);
    greenTile.valueEl.textContent = page.green.toFixed(2);
    redTile.valueEl.textContent = page.red.toFixed(2);
    allTile.valueEl.textContent = totalAll.toFixed(2);
    costValueEl.textContent = totalCost;
  }
  recompute();
  priceInputEl.addEventListener('input', recompute);

  copyBtnEl.addEventListener('click', () => {
    const text = buildPageSummaryText(displayTitle, page, getPrice());
    copyTextToClipboard(text, feedback);
  });
  reportBtnEl.addEventListener('click', () => {
    const canvasOut = generatePageReportCanvas(page, getPrice(), displayTitle);
    downloadCanvasAsPng(canvasOut, downloadBase);
  });
  copyReportBtnEl.addEventListener('click', () => {
    const canvasOut = generatePageReportCanvas(page, getPrice(), displayTitle);
    copyCanvasToClipboard(canvasOut, feedback);
  });

  return card;
}

function renderResults() {
  if (!lastResult) return;

  pagesBreakdownEl.innerHTML = '';
  const totalPages = lastResult.pages.length;
  lastResult.pages.forEach((page) => {
    pagesBreakdownEl.appendChild(buildPageReportBlock(page, totalPages));
  });
}

/* ---------- Page preview canvas ----------
   Draws the page's mounting/media area border plus the detected knife
   (red) and crease (green) contours, scaled to fit a thumbnail. Lines that
   were seen but not classified as red/green are drawn faint gray so it's
   obvious what got excluded and why. */

const PREVIEW_MAX_PX = 320;
const REPORT_PREVIEW_MAX_PX = 420;
const DIM_PAD = 22; // equal white margin around the dashed box on all four sides

function buildPreviewCanvas(page, maxPx, dprOverride) {
  const canvas = document.createElement('canvas');
  drawPagePreview(canvas, page, maxPx, dprOverride);
  return canvas;
}

function drawPagePreview(canvas, page, maxPx = PREVIEW_MAX_PX, dprOverride) {
  const box = page.box;
  const dpr = dprOverride || window.devicePixelRatio || 1;
  const scale = maxPx / Math.max(box.widthPt, box.heightPt);
  const boxCssW = Math.max(1, box.widthPt * scale);
  const boxCssH = Math.max(1, box.heightPt * scale);
  const cssW = boxCssW + DIM_PAD * 2;
  const cssH = boxCssH + DIM_PAD * 2;

  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  const vt = box.transform; // PDF user space -> viewport(pt) space, rotation-aware
  function toCanvas([x, y]) {
    return [
      (vt[0] * x + vt[2] * y + vt[4]) * scale + DIM_PAD,
      (vt[1] * x + vt[3] * y + vt[5]) * scale + DIM_PAD,
    ];
  }

  function strokePaths(paths, color, lineWidth) {
    if (!paths || !paths.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const p of paths) {
      if (p.length < 2) continue;
      ctx.beginPath();
      const [sx, sy] = toCanvas(p[0]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < p.length; i++) {
        const [x, y] = toCanvas(p[i]);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // Lines present but not matched to red/green — light gray, drawn first.
  strokePaths(page.otherPaths, 'rgba(60,60,64,0.25)', 1);

  // Mounting/media area border.
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#a0a0a6';
  ctx.lineWidth = 1;
  ctx.strokeRect(DIM_PAD + 0.5, DIM_PAD + 0.5, boxCssW - 1, boxCssH - 1);
  ctx.setLineDash([]);

  strokePaths(page.greenPaths, '#1a9850', 1.4);
  strokePaths(page.redPaths, '#d63438', 1.4);

  // Dimension labels: width along the bottom edge, height along the right
  // edge — only these two sides are annotated (not top/left, to avoid
  // duplicating the same size twice). They sit inside the same equal
  // padding band that surrounds the rest of the box.
  const dimFont = `400 10px ${REPORT_FONT}`;
  ctx.fillStyle = '#86868b';
  ctx.font = dimFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${box.widthMm.toFixed(0)} мм`, DIM_PAD + boxCssW / 2, DIM_PAD + boxCssH + DIM_PAD / 2 + 3);

  ctx.save();
  ctx.translate(DIM_PAD + boxCssW + DIM_PAD / 2 + 3, DIM_PAD + boxCssH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText(`${box.heightMm.toFixed(0)} мм`, 0, 0);
  ctx.restore();
}

/* ---------- Copy to clipboard ---------- */

function buildPageSummaryText(displayTitle, page, price) {
  const totalAll = page.green + page.red;
  const totalCost = Math.round(totalAll * price);

  const lines = [];
  lines.push(`Файл: ${displayTitle}`);
  lines.push(formatSheetLabel(page.box));
  lines.push(`Цена за 1 м.п.: ${price} грн.`);
  lines.push(`Итоговая длина: ${totalAll.toFixed(2)} м.п.`);
  lines.push(`Стоимость штанцформы: ${totalCost} грн.`);
  return lines.join('\n');
}

async function copyTextToClipboard(text, feedbackEl) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand('copy'); } catch (e2) { /* nothing else to do */ }
    document.body.removeChild(textarea);
  }
  feedbackEl.textContent = 'Скопировано';
  feedbackEl.classList.add('show');
  setTimeout(() => feedbackEl.classList.remove('show'), 1800);
}

/* ---------- Report image export ----------
   Composites the cost block and every page's preview into a single PNG,
   drawn with the Canvas 2D API (no DOM screenshot library needed). */

const REPORT_FONT = '-apple-system, "Segoe UI", Arial, sans-serif';

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapTextLines(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawLabelWithAsterisk(ctx, text, centerX, baselineY, mainFont, asteriskFont, color, asteriskColor) {
  ctx.textAlign = 'left';
  ctx.font = mainFont;
  const w = ctx.measureText(text).width;
  const startX = centerX - w / 2;
  ctx.fillStyle = color;
  ctx.fillText(text, startX, baselineY);
  ctx.font = asteriskFont;
  ctx.fillStyle = asteriskColor;
  ctx.fillText('*', startX + w + 2, baselineY - 5);
  ctx.textAlign = 'center';
}

function drawSummaryTile(ctx, x, y, w, h, label, value, unit, dotColor) {
  roundRectPath(ctx, x, y, w, h, 14);
  ctx.fillStyle = '#f5f5f7';
  ctx.fill();
  ctx.textAlign = 'left';
  let labelX = x + 18;
  if (dotColor) {
    ctx.beginPath();
    ctx.arc(x + 22, y + 23, 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
    labelX = x + 32;
  }
  ctx.fillStyle = '#6e6e73';
  ctx.font = `500 12px ${REPORT_FONT}`;
  ctx.fillText(label, labelX, y + 27);
  ctx.fillStyle = '#1d1d1f';
  ctx.font = `300 26px ${REPORT_FONT}`;
  ctx.fillText(value, x + 18, y + 57);
  ctx.fillStyle = '#6e6e73';
  ctx.font = `400 11px ${REPORT_FONT}`;
  ctx.fillText(unit, x + 18, y + 74);
}

function generatePageReportCanvas(page, price, displayTitle) {
  const totalGreen = page.green;
  const totalRed = page.red;
  const totalAll = totalGreen + totalRed;
  const totalCost = Math.round(totalAll * price);
  const detectionLabel = formatDetectionLabel(lastResult && lastResult.detection);

  // Export at a fixed high pixel density regardless of the display's own
  // devicePixelRatio, so the PNG stays crisp on standard (non-Retina) screens too.
  const exportScale = Math.max(window.devicePixelRatio || 1, 2);
  const contentWidth = 640;
  const pad = 24;
  const innerWidth = contentWidth - pad * 2;

  const measureCtx = document.createElement('canvas').getContext('2d');

  const footnoteText = '* Приблизительная стоимость. Точная стоимость будет известна после просчёта у подрядчика.';
  measureCtx.font = `400 11px ${REPORT_FONT}`;
  const footnoteLines = wrapTextLines(measureCtx, footnoteText, innerWidth);
  const footnoteLineH = 15;

  const previewMax = Math.min(REPORT_PREVIEW_MAX_PX, innerWidth - 32 - 8);
  const previewCanvas = buildPreviewCanvas(page, previewMax, exportScale);
  const wCss = previewCanvas.width / exportScale;
  const hCss = previewCanvas.height / exportScale;

  const cardPad = 16;
  const formatH = 22;
  const infoBlockH = formatH + 12;
  const areaLineH = 15, areaLineGap = 2;
  const areaBlockH = 12 + areaLineH * 3 + areaLineGap * 2;
  const previewFramePad = 4;
  const pageCardH = cardPad * 2 + infoBlockH + hCss + previewFramePad * 2 + areaBlockH;

  let y = pad;

  const titleY = y + 20;
  y += 36;

  let detectionY = null;
  if (detectionLabel) {
    detectionY = y - 6;
    y += 16;
  }

  const priceLineY = y + 15;
  y += 34;

  const tileGap = 12;
  const tileW = (innerWidth - tileGap * 2) / 3;
  const tileH = 86;
  const tilesY = y;
  y += tileH + 24;

  const costBoxH = 130;
  const costBoxY = y;
  y += costBoxH + 14;

  const footnoteY = y;
  y += footnoteLines.length * footnoteLineH + 26;

  const pageCardY = y;
  y += pageCardH + pad;
  const totalHeight = y;

  const out = document.createElement('canvas');
  out.width = Math.round(contentWidth * exportScale);
  out.height = Math.round(totalHeight * exportScale);
  const ctx = out.getContext('2d');
  ctx.setTransform(exportScale, 0, 0, exportScale, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, contentWidth, totalHeight);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#1d1d1f';
  ctx.font = `600 20px ${REPORT_FONT}`;
  ctx.fillText(displayTitle, pad, titleY);

  if (detectionLabel) {
    ctx.fillStyle = '#8a8a8f';
    ctx.font = `400 12px ${REPORT_FONT}`;
    ctx.fillText(detectionLabel, pad, detectionY);
  }

  ctx.fillStyle = '#1d1d1f';
  ctx.font = `500 14px ${REPORT_FONT}`;
  ctx.fillText(`Стоимость ножа за 1 м.п.: ${price} грн.`, pad, priceLineY);

  drawSummaryTile(ctx, pad, tilesY, tileW, tileH, 'Биговка', totalGreen.toFixed(2), 'м.п.', '#1a9850');
  drawSummaryTile(ctx, pad + tileW + tileGap, tilesY, tileW, tileH, 'Нож', totalRed.toFixed(2), 'м.п.', '#d63438');
  drawSummaryTile(ctx, pad + (tileW + tileGap) * 2, tilesY, tileW, tileH, 'Общая длина', totalAll.toFixed(2), 'м.п.');

  const bx = pad, by = costBoxY, bw = innerWidth, bh = costBoxH;
  roundRectPath(ctx, bx, by, bw, bh, 20);
  ctx.fillStyle = '#242428';
  ctx.fill();

  drawLabelWithAsterisk(
    ctx, 'СТОИМОСТЬ ШТАНЦФОРМЫ', bx + bw / 2, by + 36,
    `600 13px ${REPORT_FONT}`, `600 9px ${REPORT_FONT}`,
    'rgba(255,255,255,0.65)', 'rgba(255,255,255,0.55)'
  );

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = `300 44px ${REPORT_FONT}`;
  ctx.fillText(`${totalCost} грн.`, bx + bw / 2, by + 86);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#b0b0b6';
  ctx.font = `400 11px ${REPORT_FONT}`;
  let fy = footnoteY + 11;
  footnoteLines.forEach((line) => {
    ctx.fillText(line, pad + innerWidth / 2, fy);
    fy += footnoteLineH;
  });

  roundRectPath(ctx, pad, pageCardY, innerWidth, pageCardH, 14);
  ctx.fillStyle = '#f5f5f7';
  ctx.fill();

  ctx.textAlign = 'center';
  const formatY = pageCardY + cardPad + 14;
  ctx.fillStyle = '#1d1d1f';
  ctx.font = `600 15px ${REPORT_FONT}`;
  ctx.fillText(formatSheetLabel(page.box), pad + innerWidth / 2, formatY);

  const frameW = wCss + previewFramePad * 2;
  const frameH = hCss + previewFramePad * 2;
  const frameX = pad + (innerWidth - frameW) / 2;
  const frameY = pageCardY + cardPad + infoBlockH;
  roundRectPath(ctx, frameX, frameY, frameW, frameH, 10);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#e5e5e7';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.drawImage(previewCanvas, 0, 0, previewCanvas.width, previewCanvas.height, frameX + previewFramePad, frameY + previewFramePad, wCss, hCss);

  ctx.fillStyle = '#6e6e73';
  ctx.font = `400 12px ${REPORT_FONT}`;
  let areaY = frameY + frameH + 12 + areaLineH - 4;
  formatAreaLines(page.area).forEach((line) => {
    ctx.fillText(line, pad + innerWidth / 2, areaY);
    areaY += areaLineH + areaLineGap;
  });

  return out;
}

function downloadCanvasAsPng(canvas, baseName) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}_otchet.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');
}

function copyCanvasToClipboard(canvas, feedbackEl) {
  // navigator.clipboard.write() must run synchronously within the click's user-activation
  // window; canvas.toBlob() is async, so the blob is wrapped in a Promise passed straight
  // into ClipboardItem (Chrome resolves it lazily) instead of awaiting toBlob() first.
  const blobPromise = new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
  navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
    .then(() => {
      feedbackEl.textContent = 'Изображение скопировано';
      feedbackEl.classList.add('show');
      setTimeout(() => feedbackEl.classList.remove('show'), 1800);
    })
    .catch((err) => {
      console.error('Clipboard image copy failed:', err);
      showError('Не удалось скопировать изображение в буфер обмена. Используйте кнопку «Скачать отчёт (PNG)».');
    });
}
