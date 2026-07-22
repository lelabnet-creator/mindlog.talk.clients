// Layouts presets : chacun définit la position de `main` et `pip` en
// coordonnées 0..1 du canvas. PIP_* = main plein écran + pip en incrustation.
// SPLIT_* = main et pip côte-à-côte (pas de chevauchement).
export const LAYOUTS = {
  "pip-br":  { main: { x: 0, y: 0, w: 1, h: 1 }, pip: { x: 0.72, y: 0.72, w: 0.25, h: 0.25 } },
  "pip-bl":  { main: { x: 0, y: 0, w: 1, h: 1 }, pip: { x: 0.03, y: 0.72, w: 0.25, h: 0.25 } },
  "pip-tr":  { main: { x: 0, y: 0, w: 1, h: 1 }, pip: { x: 0.72, y: 0.03, w: 0.25, h: 0.25 } },
  "pip-tl":  { main: { x: 0, y: 0, w: 1, h: 1 }, pip: { x: 0.03, y: 0.03, w: 0.25, h: 0.25 } },
  "split-h": { main: { x: 0,   y: 0, w: 0.5, h: 1 }, pip: { x: 0.5, y: 0,   w: 0.5, h: 1 } },
  "split-v": { main: { x: 0,   y: 0, w: 1, h: 0.5 }, pip: { x: 0,   y: 0.5, w: 1, h: 0.5 } },
};

// Composition vidéo broadcaster — Picture-in-Picture.
//
// Combine deux MediaStream (cam + partage d'écran) en un seul flux : `main`
// remplit le canvas, `pip` est dessinée par-dessus en incrustation. La sortie
// est un MediaStream issu de canvas.captureStream() + audio mixé via WebAudio,
// que l'on passe TEL QUEL au Broadcaster. Le mesh/encodage/ABR existants ne
// changent pas — la composition est invisible côté pipeline live.
//
// Le layout du PiP est en coordonnées relatives 0..1 (indépendant de la taille
// réelle du canvas) → la couche UI gère le drag, on lui dit juste où poser.
// Le swap inverse instantanément main ↔ pip sans réinitialiser les caméras
// (pas d'interruption du flux).

export class PipCompositor {
  constructor({ mainStream, pipStream, width = 1280, height = 720, fps = 30, onLog }) {
    this.mainStream = mainStream;
    this.pipStream = pipStream;
    this.onLog = onLog || (() => { });
    this.fps = fps;

    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d", { alpha: false });

    this.mainVideo = this._wireVideoEl(mainStream);
    this.pipVideo = this._wireVideoEl(pipStream);

    // Layout main + pip en coords 0..1. Par défaut, main remplit le canvas
    // et pip est une incrustation 25 % bas-droite. Les presets (LAYOUTS)
    // changent les deux rectangles d'un coup.
    this.mainLayout = { x: 0, y: 0, w: 1, h: 1 };
    this.pipLayout = { x: 0.72, y: 0.72, w: 0.25, h: 0.25 };

    // Audio. Si les deux sources ont du son → mix WebAudio. Sinon on prend
    // tel quel pour éviter d'instancier un AudioContext inutile (et garder
    // l'AEC / NS d'origine pour le micro).
    const mainAudio = mainStream.getAudioTracks();
    const pipAudio = pipStream.getAudioTracks();
    const audioTracks = [];
    if (mainAudio.length && pipAudio.length) {
      this.audioCtx = new AudioContext();
      this.audioDest = this.audioCtx.createMediaStreamDestination();
      for (const s of [mainStream, pipStream]) {
        try {
          const src = this.audioCtx.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
          src.connect(this.audioDest);
        } catch (e) { this.onLog("PIP audio mix KO: " + (e?.message || e)); }
      }
      audioTracks.push(...this.audioDest.stream.getAudioTracks());
    } else if (mainAudio.length) {
      audioTracks.push(...mainAudio);
    } else if (pipAudio.length) {
      audioTracks.push(...pipAudio);
    }

    const captured = this.canvas.captureStream(fps);
    this.videoTrack = captured.getVideoTracks()[0];
    this.outputStream = new MediaStream([this.videoTrack, ...audioTracks]);

    this.running = false;
  }

  _wireVideoEl(stream) {
    const v = document.createElement("video");
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    // Le play peut rejeter avant la première interaction utilisateur ; le
    // bouton « Démarrer » est lui-même un geste utilisateur, donc en pratique
    // ça passe — on log discrètement si jamais.
    v.play().catch((e) => this.onLog("PIP video play KO: " + (e?.message || e)));
    return v;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const draw = () => {
      if (!this.running) return;
      const { canvas, ctx, mainVideo, pipVideo, mainLayout, pipLayout } = this;
      // Fond noir : utile pour les splits qui ne couvrent pas tout le cadre.
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Main au layout demandé (full canvas pour PIP, demi-cadre pour SPLIT).
      if (mainVideo.readyState >= 2 && mainVideo.videoWidth) {
        const mx = Math.round(mainLayout.x * canvas.width);
        const my = Math.round(mainLayout.y * canvas.height);
        const mw = Math.round(mainLayout.w * canvas.width);
        const mh = Math.round(mainLayout.h * canvas.height);
        this._drawCover(mainVideo, mx, my, mw, mh);
      }
      // Pip par-dessus. En mode incrustation, on dessine un liseré pour le
      // détacher du fond ; en mode split (la pip touche les bords du canvas),
      // le liseré n'aurait pas de sens, on saute.
      if (pipVideo.readyState >= 2 && pipVideo.videoWidth) {
        const px = Math.round(pipLayout.x * canvas.width);
        const py = Math.round(pipLayout.y * canvas.height);
        const pw = Math.round(pipLayout.w * canvas.width);
        const ph = Math.round(pipLayout.h * canvas.height);
        const isIncrustation = pipLayout.w < 0.6 && pipLayout.h < 0.6;
        if (isIncrustation) {
          ctx.fillStyle = "rgba(0,0,0,0.85)";
          ctx.fillRect(px - 4, py - 4, pw + 8, ph + 8);
        }
        this._drawCover(pipVideo, px, py, pw, ph);
      }
      requestAnimationFrame(draw);
    };
    draw();
  }

  // Applique un preset (PIP coin, SPLIT…). N'altère pas les sources, juste
  // les rectangles de rendu — donc instantané, sans coupure de flux.
  setLayout(name) {
    const preset = LAYOUTS[name];
    if (!preset) return;
    this.mainLayout = { ...preset.main };
    this.pipLayout = { ...preset.pip };
    this.onLog(`PIP layout = ${name}`);
  }

  // Dessine la source en mode "cover" : remplit le rectangle cible sans
  // déformer, en croppant ce qui dépasse. Sans ça, une cam 16:9 dans un PiP
  // 4:3 (par exemple) s'écraserait.
  _drawCover(video, dx, dy, dw, dh) {
    const sw = video.videoWidth;
    const sh = video.videoHeight;
    if (!sw || !sh) return;
    const sourceRatio = sw / sh;
    const targetRatio = dw / dh;
    let sx, sy, sCropW, sCropH;
    if (sourceRatio > targetRatio) {
      sCropH = sh;
      sCropW = sh * targetRatio;
      sx = (sw - sCropW) / 2;
      sy = 0;
    } else {
      sCropW = sw;
      sCropH = sw / targetRatio;
      sx = 0;
      sy = (sh - sCropH) / 2;
    }
    this.ctx.drawImage(video, sx, sy, sCropW, sCropH, dx, dy, dw, dh);
  }

  // Échange instantanément main ↔ pip — pas de re-capture, pas de coupure.
  swap() {
    [this.mainStream, this.pipStream] = [this.pipStream, this.mainStream];
    [this.mainVideo, this.pipVideo] = [this.pipVideo, this.mainVideo];
    this.onLog("PIP : sources inversées");
  }

  // Layout en coordonnées 0..1. Bornes appliquées automatiquement pour rester
  // dans le cadre. Taille bornée entre 10 % et 90 % pour rester utilisable.
  setPipLayout(layout) {
    const w = Math.max(0.10, Math.min(0.95, layout.w ?? this.pipLayout.w));
    const h = Math.max(0.10, Math.min(0.95, layout.h ?? this.pipLayout.h));
    const x = Math.max(0, Math.min(1 - w, layout.x ?? this.pipLayout.x));
    const y = Math.max(0, Math.min(1 - h, layout.y ?? this.pipLayout.y));
    this.pipLayout = { x, y, w, h };
  }

  // Permet à l'ABR de réduire la résolution de sortie (priorité diffusion).
  // Resize du canvas → MediaRecorder encode moins de pixels par frame.
  setOutputSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    if (width <= 0 || height <= 0) return;
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  stop() {
    this.running = false;
    try { this.outputStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { this.audioCtx?.close(); } catch { /* ignore */ }
    // Libère cam + écran (sinon les indicateurs navigateur restent allumés).
    try { this.mainStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { this.pipStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  }
}
