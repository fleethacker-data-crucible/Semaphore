// The leadership briefing as an email, for people to send themselves: Semaphore never sends mail.
// "Draft in Outlook" asks the server to create an unsent Outlook draft (server/Mail.ps1); "Save as
// email (.eml)" writes the same message as a file the default mail app opens as a draft (X-Unsent).
// The body is plain, readable HTML (inline styles only, no scripts, no images) with a text part,
// and the shared report goes with it as an attachment. Only analyst-reviewed answers are in it.

export interface BriefingMail {
  subject: string;
  title: string;
  /** "Monday 9 November 2026". */
  dateText: string;
  sentences: string[];
  numbers: Array<{ label: string; value: string; note?: string }>;
  alerts: string[];
  /** Name of the attached report file, when there is one. */
  attachment?: string;
  by: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function briefingMailHtml(m: BriefingMail): string {
  const p = 'margin:0 0 8px 0;';
  const h2 = 'font-size:15px;margin:18px 0 6px 0;';
  const list = (items: string[]) => `<ul style="margin:0 0 8px 0;padding-left:20px;">${items.map((t) => `<li style="margin:0 0 4px 0;">${esc(t)}</li>`).join('')}</ul>`;
  const parts: string[] = [];
  parts.push(`<h1 style="font-size:18px;margin:0 0 4px 0;">${esc(m.title)}</h1>`);
  parts.push(`<p style="${p}color:#555;">${esc(m.dateText)}. Only answers an analyst has reviewed are included.</p>`);
  if (m.alerts.length) parts.push(`<h2 style="${h2}">Alerts</h2>${list(m.alerts)}`);
  parts.push(`<h2 style="${h2}">What changed</h2>`);
  parts.push(m.sentences.length ? list(m.sentences) : `<p style="${p}">Nothing stood out in the reviewed answers.</p>`);
  if (m.numbers.length) {
    const rows = m.numbers
      .map((n) => `<tr><td style="padding:4px 12px 4px 0;border-bottom:1px solid #ddd;">${esc(n.label)}</td><td style="padding:4px 0;border-bottom:1px solid #ddd;text-align:right;font-weight:bold;">${esc(n.value)}</td><td style="padding:4px 0 4px 12px;border-bottom:1px solid #ddd;color:#555;">${esc(n.note ?? '')}</td></tr>`)
      .join('');
    parts.push(`<h2 style="${h2}">Headline numbers</h2><table style="border-collapse:collapse;font-size:14px;">${rows}</table>`);
  }
  if (m.attachment) parts.push(`<p style="${p}margin-top:16px;">The attached report (${esc(m.attachment)}) opens in any browser with the numbers as they stood; no database or server is needed to read it.</p>`);
  parts.push(`<p style="${p}color:#777;font-size:12px;">Prepared by ${esc(m.by)} with Semaphore.</p>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.subject)}</title></head><body style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1a1a1a;">${parts.join('')}</body></html>`;
}

export function briefingMailText(m: BriefingMail): string {
  const out: string[] = [m.title, m.dateText + '. Only answers an analyst has reviewed are included.', ''];
  if (m.alerts.length) out.push('Alerts', ...m.alerts.map((a) => `- ${a}`), '');
  out.push('What changed', ...(m.sentences.length ? m.sentences.map((s) => `- ${s}`) : ['Nothing stood out in the reviewed answers.']), '');
  if (m.numbers.length) out.push('Headline numbers', ...m.numbers.map((n) => `- ${n.label}: ${n.value}${n.note ? ` (${n.note})` : ''}`), '');
  if (m.attachment) out.push(`The attached report (${m.attachment}) opens in any browser with the numbers as they stood.`, '');
  out.push(`Prepared by ${m.by} with Semaphore.`);
  return out.join('\r\n');
}

// ---------------------------------------------------------------------------------------------
// .eml (RFC 5322 / MIME): multipart/mixed with a multipart/alternative body and the attachments.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]! + (b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!) + (c === undefined ? '=' : B64[c & 63]!);
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const wrap = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');

/** A header value: as is when it is printable ASCII, else RFC 2047 encoded-words (UTF-8, base64). */
export function headerValue(s: string): string {
  const clean = s.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    if (utf8(chunk + ch).length > 45) {
      words.push(`=?UTF-8?B?${base64(utf8(chunk))}?=`);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64(utf8(chunk))}?=`);
  return words.join('\r\n ');
}

export const EMAIL_RX = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** The addresses that look like addresses, without repeats, at most 50. */
export function cleanRecipients(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const a = raw.trim();
    if (EMAIL_RX.test(a) && !out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  }
  return out.slice(0, 50);
}

export interface EmlInput {
  to: readonly string[];
  subject: string;
  html: string;
  text: string;
  attachments?: ReadonlyArray<{ name: string; contentType: string; content: string }>;
  date?: Date;
  /** Fixed in tests; random otherwise. */
  boundary?: string;
}

/**
 * The message as an .eml file. X-Unsent: 1 makes Outlook (and other mail apps) open it as a draft
 * to check and send, not as a received message. There is no From: the mail app fills it in.
 */
export function composeEml(m: EmlInput): string {
  const b = m.boundary ?? `sem-${Math.random().toString(36).slice(2, 12)}`;
  const mixed = `${b}-mixed`;
  const alt = `${b}-alt`;
  const to = cleanRecipients(m.to);
  const date = (m.date ?? new Date()).toUTCString().replace('GMT', '+0000');
  const lines: string[] = [];
  if (to.length) lines.push(`To: ${to.join(', ')}`);
  lines.push(`Subject: ${headerValue(m.subject)}`, `Date: ${date}`, 'X-Unsent: 1', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${mixed}"`, '', 'This is a multi-part message in MIME format.', '');
  lines.push(`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '');
  lines.push(`--${alt}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap(base64(utf8(m.text))));
  lines.push(`--${alt}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap(base64(utf8(m.html))));
  lines.push(`--${alt}--`, '');
  for (const a of m.attachments ?? []) {
    const name = a.name.replace(/["\\\r\n]/g, '_');
    lines.push(`--${mixed}`, `Content-Type: ${a.contentType}; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', wrap(base64(utf8(a.content))));
  }
  lines.push(`--${mixed}--`, '');
  return lines.join('\r\n');
}
