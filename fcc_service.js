// Classify FCC services consistently in both the importer and the public API.
// A TV translator call sign is not evidence of a radio translator service.
export function fccService(row = {}) {
  const call = String(row.call || '').trim().toUpperCase();
  const raw = String(row.service || '').trim().toUpperCase();
  const code = raw.replace(/[\s_.-]/g, '');
  if (/^[KW]\d{2}[A-Z]{2}(?:-D)?$/.test(call) ||
      /-(?:TV|DT|DTV|CD|LD|DCA|DTA|TVA|TVL|TT|TTV|TTA|CDT|EDT)$/.test(call)) return 'television';
  if (new Set(['TV', 'DT', 'DTV', 'DTS', 'DS', 'DC', 'DCA', 'CA', 'CD', 'LD', 'LPD', 'LPT', 'LPTV', 'TX', 'T', 'TT', 'TTV', 'TTA', 'TB', 'DRT']).has(code) ||
      /TELEVISION|\bTV\b/.test(raw)) return 'television';
  if (new Set(['AM', 'FM', 'FX', 'FL', 'FB', 'LPFM']).has(code) ||
      /\bRADIO\b|\b(?:AM|FM|LPFM)\b/.test(raw)) return 'radio';
  if (/^[KW]\d{3}[A-Z]{2}$/.test(call) || /-(?:AM|FM|FM\d+)$/.test(call) ||
      /^[KW][A-Z]{2,3}$/.test(call)) return 'radio';
  return '';
}

export function serviceMatches(row, service) {
  return service === 'all' || fccService(row) === service;
}
