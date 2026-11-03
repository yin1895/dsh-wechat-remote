/**
 * Turn the iLink login payload into something the panel can actually display.
 *
 * `get_bot_qrcode` answers with `qrcode_img_content` = a WeChat lite-app *link*
 *
 *   https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=be0e5087…&bot_type=3
 *
 * and not image bytes: the phone opens that page to confirm the binding, so the
 * link is the QR payload. Feeding it to `<img src="data:image/png;base64,…">`
 * draws nothing but an empty white square, which is exactly how the blank login
 * QR presented itself. Other servers may still hand back real image data; that
 * shape is passed through untouched.
 */

import { qrDataUri, qrSvg } from './qr.js';

/** Base64 prefixes of the image formats worth recognising (PNG, GIF, JPEG, WebP). */
const IMAGE_PREFIXES = ['iVBORw0KGgo', 'R0lGOD', '/9j/', 'UklGR'];

/** Whether a value is bare base64 image bytes rather than a link. */
function looksLikeBase64Image(value) {
  return value.length >= 64 && IMAGE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Resolve the login QR into a renderable form.
 *
 * @param {{ qrcode?: string, qrcodeImgContent?: string }} payload iLink's answer
 * @returns {{ kind: 'image'|'link'|'text'|'none', payload: string, image: string, svg: string, link: string|null }}
 *   `kind` describes where `payload` came from, `image` is a data URI ready for
 *   an `<img>` (empty when nothing can be rendered), and `link` carries the
 *   lite-app URL for the panel's fallback line.
 */
export function loginQrImage(payload = {}) {
  const { qrcode, qrcodeImgContent } = payload;
  const raw = typeof qrcodeImgContent === 'string' ? qrcodeImgContent.trim() : '';

  if (raw.startsWith('data:image/')) {
    return { kind: 'image', payload: raw, image: raw, svg: '', link: null };
  }
  if (looksLikeBase64Image(raw)) {
    return { kind: 'image', payload: raw, image: `data:image/png;base64,${raw}`, svg: '', link: null };
  }

  const link = /^https?:\/\//i.test(raw) ? raw : null;
  const target = link ?? (raw.length > 0 ? raw : typeof qrcode === 'string' ? qrcode : '');
  if (target.length === 0) {
    return { kind: 'none', payload: '', image: '', svg: '', link: null };
  }
  return {
    kind: link === null ? 'text' : 'link',
    payload: target,
    image: qrDataUri(target),
    svg: qrSvg(target),
    link,
  };
}
