// 本文と独立した編集可能な星の文字。プレビューとXMLが同じ30fps値を使う。
export const SPARKLE_FPS = 30;
export const SPARKLE_TYPES = Object.freeze(['sweep', 'burst', 'cascade', 'celebration', 'twinkle']);
export const isSparkleType = value => SPARKLE_TYPES.includes(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = value => Math.round(value * 1e6) / 1e6;
const unit = index => ((Math.imul(index + 11, 2654435761) >>> 0) % 1009) / 1008;

function validate({ style, bounds, t, d, W, H }) {
  if (!isSparkleType(style.sparkle)) throw new Error('未対応のキラキラ演出です。');
  if (![W, H].every(value => Number.isInteger(value) && value > 0 && value <= 8192)) throw new Error('画面サイズが不正です。');
  if (![t, d].every(Number.isFinite) || t < 0 || d < 0 || t + d > 3600) throw new Error('キラキラの時間が不正です。');
  if (!bounds || ![bounds.width, bounds.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('本文の描画範囲が必要です。');
  if (!Array.isArray(style.pos) || style.pos.length !== 2 || !style.pos.every(Number.isFinite)
    || !Number.isFinite(style.size) || style.size <= 0 || style.size > 400) throw new Error('本文の位置またはサイズが不正です。');
}

function particleStyle(size, index, pos) {
  return {
    font: 'Segoe UI Symbol', family: 'Segoe UI Symbol', weight: 400, size, max_width: size * 3,
    pos, z: 20, in: 'none', out: 'none', out_d: 0, idle: 'none', char: '', rotate: 0,
    fill: index % 4 === 3 ? '#fff2bc' : '#ffffff',
    strokes: [{ w: round(size * .035), color: '#e6b450' }, { w: round(size * .065), color: '#66451c' }],
    shadows: [], line_spacing: 1,
  };
}

// centerは画面のpixel座標。scale/opacityは100基準、rotationは度。
// frameは各粒子の開始からのフレームで、終端の非表示キーも含む。
function samplesFor({ type, frames, index, x, y, dx, dy, radius, W, H }) {
  const marginX = W * .05 + radius, marginY = H * .05 + radius;
  return Array.from({ length: frames + 1 }, (_, frame) => {
    const progress = frame / frames;
    // 1〜2frameでも最低1frameは見える。開始と終端だけが0の空クリップを作らない。
    const visibleProgress = frames <= 2 ? .5 : (frame + .35) / frames;
    const pulse = Math.max(0, Math.sin(Math.PI * Math.min(1, visibleProgress)));
    let intensity = frame === frames ? 0 : (frames <= 2 ? 1 : pulse ** .65);
    if (frame < frames && frames > 2 && type === 'celebration') intensity = pulse ** .4;
    if (frame < frames && frames > 2 && type === 'twinkle') intensity = pulse ** .4 * (.12 + .88 * Math.sin(visibleProgress * Math.PI * 2) ** 2);
    const travel = type === 'burst' || type === 'celebration' ? 1 - (1 - progress) ** 2 : progress;
    const scale = type === 'celebration' ? .18 + 1.34 * intensity : type === 'twinkle' ? .25 + 1.1 * intensity : .42 + .76 * intensity;
    const rotation = type === 'celebration' ? -25 + progress * 115 : type === 'twinkle' ? Math.sin(progress * Math.PI * 2) * 27
      : type === 'cascade' ? 18 + progress * 52 : type === 'burst' ? progress * 78 : -15 + progress * 42;
    return {
      frame,
      scale: round(scale * 100),
      rotation: round((index % 2 ? -1 : 1) * rotation),
      center: {
        x: round(clamp(x + dx * travel, marginX, W - marginX)),
        y: round(clamp(y + dy * travel, marginY, H - marginY)),
      },
      opacity: round(intensity * (index % 4 === 3 ? 82 : 100)),
    };
  });
}

// 安全枠へのclampで下側の星が本文へ押し戻された場合、軌道ごと空いている辺へ回す。
// 毎フレーム別の辺を選ばず、1本の軌道を同じ辺で制限するため途中で飛び移らない。
function avoidText(motion, radius, rect, W, H) {
  const gap = 3, clearance = radius + gap;
  const intersects = ({ center }) => center.x + clearance > rect.left && center.x - clearance < rect.right
    && center.y + clearance > rect.top && center.y - clearance < rect.bottom;
  if (!motion.some(intersects)) return motion;
  const candidates = [
    { axis: 'y', limit: rect.top - clearance, upper: true, min: H * .05 + radius, max: H * .95 - radius },
    { axis: 'y', limit: rect.bottom + clearance, upper: false, min: H * .05 + radius, max: H * .95 - radius },
    { axis: 'x', limit: rect.left - clearance, upper: true, min: W * .05 + radius, max: W * .95 - radius },
    { axis: 'x', limit: rect.right + clearance, upper: false, min: W * .05 + radius, max: W * .95 - radius },
  ].filter(candidate => candidate.limit >= candidate.min && candidate.limit <= candidate.max);
  const paths = candidates.map(({ axis, limit, upper }) => {
    let cost = 0;
    const path = motion.map(sample => {
      const value = upper ? Math.min(sample.center[axis], limit) : Math.max(sample.center[axis], limit);
      cost += (value - sample.center[axis]) ** 2;
      return { ...sample, center: { ...sample.center, [axis]: round(value) } };
    });
    return { path, cost };
  }).sort((a, b) => a.cost - b.cost);
  // 画面いっぱいの本文で飾る余地がなければ、文字の上へ強制配置しない。
  return paths[0]?.path || null;
}

/**
 * @returns {Array<{id:string,text:string,fontName:string,style:object,t:number,d:number,
 *   startFrame:number,endFrame:number,motion:Array<{frame:number,scale:number,rotation:number,center:{x:number,y:number},opacity:number}>}>}
 * t/dは絶対タイムライン秒。boundsは本文の実描画幅・高さ、style.posはその中央。
 * 星は静止後の本文の周縁を飾る。通常は本文開始から0.2秒待ってから光る。
 */
export function getSparkleClips({ style, bounds, t = 0, d, W, H }) {
  if (style?.sparkle == null || style.sparkle === '' || style.sparkle === 'none') return [];
  validate({ style, bounds, t, d, W, H });
  const firstFrame = Math.round(t * SPARKLE_FPS), lastFrame = Math.round((t + d) * SPARKLE_FPS);
  const totalFrames = lastFrame - firstFrame;
  if (totalFrames < 1 || Math.min(W, H) < 24) return [];
  const type = style.sparkle, rich = type === 'celebration' || type === 'twinkle', count = rich ? 24 : type === 'sweep' ? 10 : 12;
  // 短い本文は遅延も短縮。丸め後の本文の外へ延長しない。
  const delay = Math.min(6, Math.floor(totalFrames / 5));
  const windowFrames = Math.min(totalFrames - delay, type === 'celebration' ? 72 : type === 'twinkle' ? 120 : type === 'burst' ? 36 : type === 'cascade' ? 78 : 60);
  const minimumLife = Math.min(windowFrames, type === 'celebration' ? 18 : type === 'twinkle' ? 14 : type === 'burst' ? 17 : 19);
  const spread = windowFrames - minimumLife;
  const halfWidth = Math.min(bounds.width / 2, W * .43), halfHeight = Math.min(bounds.height / 2, H * .35);
  const [cx, cy] = style.pos;
  const rect = { left: cx - bounds.width / 2, right: cx + bounds.width / 2, top: cy - bounds.height / 2, bottom: cy + bounds.height / 2 };
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1), variation = unit(index + (type === 'celebration' ? 113 : type === 'twinkle' ? 157 : type === 'burst' ? 37 : type === 'cascade' ? 71 : 0));
    const sizeFactor = type === 'celebration' ? (index % 2 ? .19 + variation * .1 : .39 + variation * .16)
      : type === 'twinkle' ? (index % 3 ? .18 + variation * .12 : .38 + variation * .11) : .25 + variation * .16;
    const size = round(Math.min(rich ? 68 : 52, Math.min(W, H) * (rich ? .061 : .045), Math.max(3, style.size * sizeFactor)));
    // 正方形の字面を回しても収まる半径。各演出の最大拡大率・外フチを含む。
    const maximumScale = type === 'celebration' ? 1.52 : type === 'twinkle' ? 1.35 : 1.18;
    const radius = (size * Math.SQRT1_2 + size * .065) * maximumScale;
    const gap = radius * 1.05 + Math.min(9, style.size * .06);
    let x, y, dx, dy, startOffset;
    if (type === 'sweep') {
      const side = index % 2 ? 1 : -1;
      x = cx + (ratio * 2 - 1) * halfWidth * .96;
      y = cy + side * (halfHeight + gap);
      dx = size * .55; dy = side * size * .18;
      startOffset = Math.round(ratio * spread);
    } else if (type === 'burst') {
      // 上下の列と左右の角から外へ広がる。本文の中央は空ける。
      const side = index % 2 ? 1 : -1, column = Math.floor(index / 2) / 5;
      x = cx + (column * 2 - 1) * (halfWidth + gap * .15);
      y = cy + side * (halfHeight + gap);
      dx = (column * 2 - 1) * size * .75; dy = side * size * .6;
      startOffset = Math.round((index % 4) / 3 * Math.min(8, spread));
    } else if (type === 'cascade') {
      // 上縁と左右の外側をゆっくり落ちる星。文字の中を横切らない。
      const edge = index % 3;
      if (edge === 0) {
        x = cx + (ratio * 2 - 1) * halfWidth * .9;
        y = cy - halfHeight - gap - size * .65;
        dx = size * .22; dy = size * .5;
      } else {
        const side = edge === 1 ? -1 : 1;
        x = cx + side * (halfWidth + gap);
        y = cy + (variation * 2 - 1) * halfHeight - size * .25;
        dx = side * size * .12; dy = size * .55;
      }
      startOffset = Math.round(ratio * spread);
    } else if (type === 'celebration') {
      // 12個ずつ2回、大小の星を上下と角から大きく弾ませる。
      const wave = Math.floor(index / 12), particle = index % 12, side = particle % 2 ? 1 : -1;
      const column = Math.floor(particle / 2) / 5, direction = column * 2 - 1;
      x = cx + direction * halfWidth * (wave ? .84 : .98);
      y = cy + side * (halfHeight + gap + wave * size * .16);
      dx = direction * size * 1.1; dy = side * size * .85;
      startOffset = Math.round(wave * spread * .68 + (particle % 4) / 3 * Math.min(8, spread * .24));
    } else {
      // 周囲8か所を3巡。1つの星が二度輝き、光る点を順々に移す。
      const perimeter = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
      const [sideX, sideY] = perimeter[[0, 4, 2, 6, 1, 5, 3, 7][index % 8]];
      x = cx + sideX * (halfWidth + (sideY ? gap * .1 : gap));
      y = cy + sideY * (halfHeight + gap);
      dx = (variation - .5) * size * .16; dy = sideY * size * .12;
      startOffset = Math.round(ratio * spread);
    }
    const startFrame = firstFrame + delay + startOffset;
    const frames = Math.min(windowFrames - startOffset, minimumLife + index % 4 * 2);
    const endFrame = startFrame + frames;
    const motion = avoidText(samplesFor({ type, frames, index, x, y, dx, dy, radius, W, H }), radius, rect, W, H);
    if (!motion) return null;
    return {
      id: `${type}-${index + 1}`, text: index % 4 === 3 ? '✧' : '✦', fontName: 'SegoeUISymbol',
      style: particleStyle(size, index, [motion[0].center.x, motion[0].center.y]),
      t: startFrame / SPARKLE_FPS, d: frames / SPARKLE_FPS, startFrame, endFrame, motion,
    };
  }).filter(Boolean);
}

// 再生・コマ送り・逆シーク・ループに状態を持たせず、同じ時刻は同じ表示にする。
export function sampleSparkleAt(clip, time) {
  if (!Number.isFinite(time)) return null;
  const frame = Math.floor(time * SPARKLE_FPS + 1e-7);
  if (frame < clip.startFrame || frame >= clip.endFrame) return null;
  return clip.motion[frame - clip.startFrame] || null;
}
