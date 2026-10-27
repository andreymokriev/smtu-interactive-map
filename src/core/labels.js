/**
 * Подписи помещений: спрайты с нарисованным на canvas текстом.
 * Спрайт всегда развёрнут к камере, поэтому номер читается при любом наклоне.
 */
import { CanvasTexture, SRGBColorSpace, Sprite, SpriteMaterial } from 'three';
import { COLORS, LABEL_SIZE } from '../config.js';

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_SIZE = 34;
const TEXTURE_SCALE = 2; // плотность текстуры, чтобы текст оставался резким

export function createLabelSprite(text, { color = COLORS.label, height = LABEL_SIZE } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `600 ${FONT_SIZE}px ${FONT_STACK}`;

  ctx.font = font;
  const textWidth = Math.ceil(ctx.measureText(text).width);

  const padX = 15;
  const padY = 8;
  const width = textWidth + padX * 2;
  const heightPx = Math.ceil(FONT_SIZE * 1.25) + padY * 2;

  canvas.width = width * TEXTURE_SCALE;
  canvas.height = heightPx * TEXTURE_SCALE;
  ctx.scale(TEXTURE_SCALE, TEXTURE_SCALE);

  // «таблетка» под текстом, чтобы номер читался на любом фоне
  ctx.beginPath();
  const radius = heightPx / 2;
  ctx.moveTo(radius, 0.75);
  ctx.lineTo(width - radius, 0.75);
  ctx.arc(width - radius, heightPx / 2, radius - 0.75, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(radius, heightPx - 0.75);
  ctx.arc(radius, heightPx / 2, radius - 0.75, Math.PI / 2, -Math.PI / 2);
  ctx.closePath();
  ctx.fillStyle = COLORS.labelBg;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = 'rgba(16, 22, 35, 0.12)';
  ctx.stroke();

  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, heightPx / 2 + 1);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;

  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity: 1,
  });

  const sprite = new Sprite(material);
  sprite.scale.set((height * width) / heightPx, height, 1);
  sprite.renderOrder = 3;
  sprite.userData.text = text;
  return sprite;
}
