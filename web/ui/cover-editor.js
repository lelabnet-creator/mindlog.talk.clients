// ui/cover-editor.js — modale de cadrage + compression pour la couverture publique.
// Image : pan + zoom → canvas → WebP 1080×1920 (≈100-300 ko).
// Vidéo : pan + zoom + trim → canvas captureStream → MediaRecorder VP9 sans audio,
//   10 s max (≈3 Mo). Évite les fichiers iPhone bruts >25 Mo qui étaient rejetés
//   silencieusement par la route POST /api/cover.
import { toast } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "../i18n.js";

const TARGET_W = 1080;
const TARGET_H = 1920;
const IMG_QUALITY = 0.85;
const VIDEO_MAX_SECONDS = 10;
const VIDEO_BITS_PER_SECOND = 2_500_000;

export async function openCoverEditor(file) {
  const isVideo = file.type.startsWith("video/");
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="panel cover-editor" role="dialog" aria-modal="true">
        <button type="button" class="close" id="ce-x" aria-label="${t("com_close")}">&times;</button>
        <h2>${t("cvedit_title")}</h2>
        <p class="sub">${t("cvedit_hint")} ${isVideo
          ? t("cvedit_video_hint")
          : t("cvedit_img_hint")}</p>
        <div class="ce-stage">
          <div class="ce-frame" id="ce-frame">
            ${isVideo
              ? `<video class="ce-media" id="ce-media" muted playsinline loop preload="metadata"></video>`
              : `<img class="ce-media" id="ce-media" alt="" />`}
            <div class="ce-loading" id="ce-loading">${t("com_loading")}</div>
          </div>
        </div>
        <div class="ce-controls">
          <label><span class="ce-lbl">${icon("image", 14)} ${t("cvedit_zoom")}</span>
            <input type="range" id="ce-zoom" min="100" max="400" value="100" />
          </label>
          ${isVideo ? `
          <label><span class="ce-lbl">${t("cvedit_start")}</span>
            <input type="range" id="ce-trim" min="0" max="0" step="0.1" value="0" />
            <span class="ce-trim-val" id="ce-trim-val">0,0 s</span>
          </label>` : ""}
        </div>
        <div class="ce-actions">
          <button type="button" class="btn" id="ce-cancel">${t("com_cancel")}</button>
          <button type="button" class="btn primary" id="ce-ok" disabled>${isVideo ? t("cvedit_encode_use") : t("cvedit_use")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const media = overlay.querySelector("#ce-media");
    const frame = overlay.querySelector("#ce-frame");
    const okBtn = overlay.querySelector("#ce-ok");
    const loading = overlay.querySelector("#ce-loading");

    // tx/ty : translation en pixels (frame coords). Drag 1:1 ressenti naturel.
    let zoom = 1, tx = 0, ty = 0;
    let natW = 0, natH = 0;
    let durationSec = 0, trimStart = 0;
    let ready = false;

    const applyTransform = () => {
      media.style.transform = `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${zoom})`;
    };
    const sizeMediaToFrame = () => {
      if (!natW || !natH) return;
      const fr = frame.getBoundingClientRect();
      const mediaAR = natW / natH;
      const frameAR = fr.width / fr.height;
      // Cover : on étire pour que la dimension la plus contraignante remplisse le cadre.
      let w, h;
      if (mediaAR > frameAR) { h = fr.height; w = h * mediaAR; }
      else { w = fr.width; h = w / mediaAR; }
      media.style.width = `${w}px`;
      media.style.height = `${h}px`;
      applyTransform();
    };

    const onReady = () => {
      if (ready) return; ready = true;
      if (isVideo) {
        natW = media.videoWidth; natH = media.videoHeight;
        durationSec = isFinite(media.duration) ? media.duration : 0;
        const trim = overlay.querySelector("#ce-trim");
        const trimVal = overlay.querySelector("#ce-trim-val");
        const tmax = Math.max(0, durationSec - VIDEO_MAX_SECONDS);
        trim.max = tmax.toFixed(1);
        trim.disabled = tmax <= 0;
        const fmt = (s) => `${s.toFixed(1).replace(".", ",")} s`;
        const refreshTrimLabel = () => {
          const end = Math.min(durationSec, trimStart + VIDEO_MAX_SECONDS);
          trimVal.textContent = `${fmt(trimStart)} → ${fmt(end)}`;
        };
        refreshTrimLabel();
        trim.addEventListener("input", () => {
          trimStart = Number(trim.value) || 0;
          media.currentTime = trimStart;
          refreshTrimLabel();
        });
        media.play().catch(() => { /* autoplay bloqué : aperçu figé, OK pour cadrer */ });
      } else {
        natW = media.naturalWidth; natH = media.naturalHeight;
      }
      if (!natW || !natH) { toast(t("cvedit_file_unreadable")); cleanup(); resolve(null); return; }
      sizeMediaToFrame();
      loading.style.display = "none";
      okBtn.disabled = false;
    };

    if (isVideo) {
      media.addEventListener("loadedmetadata", onReady, { once: true });
      media.addEventListener("error", () => { toast(t("cvedit_video_unreadable")); cleanup(); resolve(null); }, { once: true });
      media.src = url;
    } else {
      media.addEventListener("load", onReady, { once: true });
      media.addEventListener("error", () => { toast(t("cvedit_img_unreadable")); cleanup(); resolve(null); }, { once: true });
      media.src = url;
    }

    const onResize = () => sizeMediaToFrame();
    window.addEventListener("resize", onResize);

    overlay.querySelector("#ce-zoom").addEventListener("input", (e) => {
      zoom = Number(e.target.value) / 100;
      applyTransform();
    });

    // Pan via pointer events. .ce-media a pointer-events:none → le drag se passe sur .ce-frame.
    let drag = null;
    frame.addEventListener("pointerdown", (e) => {
      if (!ready) return;
      drag = { x: e.clientX, y: e.clientY, tx, ty };
      frame.setPointerCapture(e.pointerId);
    });
    frame.addEventListener("pointermove", (e) => {
      if (!drag) return;
      tx = drag.tx + (e.clientX - drag.x);
      ty = drag.ty + (e.clientY - drag.y);
      applyTransform();
    });
    const endDrag = (e) => {
      drag = null;
      try { frame.releasePointerCapture(e.pointerId); } catch { /* ignoré */ }
    };
    frame.addEventListener("pointerup", endDrag);
    frame.addEventListener("pointercancel", endDrag);

    let aborted = false;
    const cleanup = () => {
      aborted = true;
      window.removeEventListener("resize", onResize);
      URL.revokeObjectURL(url);
      overlay.remove();
    };
    overlay.querySelector("#ce-x").onclick = () => { cleanup(); resolve(null); };
    overlay.querySelector("#ce-cancel").onclick = () => { cleanup(); resolve(null); };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });

    okBtn.addEventListener("click", async () => {
      okBtn.disabled = true;
      const label = okBtn.textContent;
      okBtn.textContent = isVideo ? t("cvedit_encoding") : t("cvedit_compressing");
      try {
        const ctx = { media, frame, natW, natH, trimStart, durationSec, abortCheck: () => aborted };
        const out = isVideo ? await renderVideo(ctx) : await renderImage(ctx);
        if (aborted) return;
        cleanup();
        resolve(out);
      } catch (err) {
        if (!aborted) {
          toast(err?.message || t("cvedit_process_fail"));
          okBtn.disabled = false;
          okBtn.textContent = label;
        }
      }
    });
  });
}

// Calcule la zone source (en pixels natifs) à dessiner dans le canvas cible,
// d'après la position courante du média par rapport au cadre.
function sourceRect({ media, frame, natW, natH }) {
  const fr = frame.getBoundingClientRect();
  const mr = media.getBoundingClientRect();
  const sx = ((fr.left - mr.left) / mr.width) * natW;
  const sy = ((fr.top - mr.top) / mr.height) * natH;
  const sw = (fr.width / mr.width) * natW;
  const sh = (fr.height / mr.height) * natH;
  return { sx, sy, sw, sh };
}

async function renderImage(ctx) {
  const canvas = document.createElement("canvas");
  canvas.width = TARGET_W;
  canvas.height = TARGET_H;
  const c2d = canvas.getContext("2d");
  const { sx, sy, sw, sh } = sourceRect(ctx);
  c2d.drawImage(ctx.media, sx, sy, sw, sh, 0, 0, TARGET_W, TARGET_H);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/webp", IMG_QUALITY));
  if (!blob) throw new Error(t("cvedit_img_compress_fail"));
  return { blob, type: "image/webp", ext: "webp" };
}

async function renderVideo(ctx) {
  if (!window.MediaRecorder) throw new Error(t("cvedit_video_unsupported"));
  const mimeCandidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) throw new Error(t("cvedit_webm_unsupported"));

  const canvas = document.createElement("canvas");
  canvas.width = TARGET_W;
  canvas.height = TARGET_H;
  const c2d = canvas.getContext("2d");
  const rect = sourceRect(ctx);

  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  const { media, trimStart, durationSec } = ctx;
  media.muted = true; media.loop = false; media.pause();
  media.currentTime = trimStart;
  await new Promise((res) => media.addEventListener("seeked", res, { once: true }));

  const maxDur = Math.min(VIDEO_MAX_SECONDS, Math.max(0.1, (durationSec || VIDEO_MAX_SECONDS) - trimStart));
  let raf = 0, stopRequested = false;
  const startTs = performance.now();
  const draw = () => {
    if (stopRequested || ctx.abortCheck()) return;
    const elapsed = (performance.now() - startTs) / 1000;
    if (elapsed >= maxDur) {
      stopRequested = true;
      try { rec.state === "recording" && rec.stop(); } catch { /* ignoré */ }
      media.pause();
      return;
    }
    c2d.drawImage(media, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, TARGET_W, TARGET_H);
    raf = requestAnimationFrame(draw);
  };

  rec.start(200);
  await media.play().catch(() => {});
  draw();
  await stopped;
  cancelAnimationFrame(raf);
  if (ctx.abortCheck()) return null;
  const blob = new Blob(chunks, { type: "video/webm" });
  if (!blob.size) throw new Error(t("cvedit_video_empty"));
  return { blob, type: "video/webm", ext: "webm" };
}
