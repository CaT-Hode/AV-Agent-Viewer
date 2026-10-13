export type WebAddressInference = 'navigation' | 'omnibox';

/** Omnibox policy, not a public-suffix database. Explicit navigation accepts
 * syntactically valid DNS/IDN suffixes without consulting this shortlist. */
const bareDomainSuffixes: ReadonlySet<string> = new Set(('com org net edu gov mil int io dev app ai cn co me info biz xyz online tech site cloud tools work page link wiki blog live store shop cc tv us uk de fr jp ca au nz in sg hk tw ch se no nl it es ru br za kr mx eu id fi dk be at pl pt ie il ae sa tr ua local localhost xn--fiqs8s xn--fiqz9s').split(' '));
export const documentSuffixes: ReadonlySet<string> = new Set(('md markdown pdf doc docx ppt pptx xls xlsx xlsm xlsb xltx xltm epub html htm txt rtf odt ods odp csv tsv json yaml yml xml toml ini log png jpg jpeg gif svg webp bmp ico zip').split(' '));
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const dnsLabel = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const completeIPv4 = (host: string) => {
  const parts = host.split('.');
  return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
};

/** Resolve user input only into a canonical HTTP(S) URL. Undefined leaves a
 * search term or local file path with its caller; it never converts file paths
 * into remote navigation. Ported IPv6 must use brackets; a bare IPv6 literal
 * is treated entirely as its host, without guessing a final segment as a port. */
export function normalizeWebAddress(input: string, inference: WebAddressInference = 'navigation'): string | undefined {
  if (typeof input !== 'string' || controls.test(input)) return;
  const value = input.trim();
  if (!value || /\s|\\/.test(value)) return;
  const explicit = /^https?:\/\//i.test(value);
  if (/^[a-z][\w+.-]*:\/\//i.test(value) && !explicit || /^https?:/i.test(value) && !explicit) return;
  let remainder = explicit ? value.slice(value.indexOf('://') + 3) : value.startsWith('//') ? value.slice(2) : value;
  const separator = remainder.search(/[/?#]/), authority = separator < 0 ? remainder : remainder.slice(0, separator), tail = separator < 0 ? '' : remainder.slice(separator);
  if (!authority || authority.includes('@')) return;

  let writtenHost: string, port = '', reconstructedAuthority = authority;
  if (authority.startsWith('[')) {
    const closing = authority.indexOf(']');
    if (closing < 0) return;
    writtenHost = authority.slice(0, closing + 1);
    port = authority.slice(closing + 1);
    if (port && !/^:\d+$/.test(port)) return;
  } else if ((authority.match(/:/g)?.length ?? 0) > 1) {
    if (explicit || !/^[a-f\d:]+$/i.test(authority)) return;
    writtenHost = '[' + authority + ']'; reconstructedAuthority = writtenHost;
  } else {
    const colon = authority.indexOf(':');
    writtenHost = colon < 0 ? authority : authority.slice(0, colon);
    port = colon < 0 ? '' : authority.slice(colon);
    if (port && !/^:\d+$/.test(port)) return;
  }
  if (port && Number(port.slice(1)) > 65535) return;
  let url: URL;
  try { url = new URL(explicit ? value : 'https://' + reconstructedAuthority + tail); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return;
  const host = url.hostname.toLowerCase().replace(/\.$/, ''), rawHost = writtenHost.toLowerCase().replace(/\.$/, '');
  const ipv6 = host.startsWith('[') && host.endsWith(']'), ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (ipv4 && (!completeIPv4(rawHost) || host !== rawHost)) return;
  if (!ipv6 && !ipv4) {
    const labels = host.split('.');
    if (host.length > 253 || !labels.every(label => dnsLabel.test(label))) return;
    const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
    if (!explicit && !local) {
      if (labels.length < 2 || !/[a-z]/i.test(labels.at(-1)!)) return;
      const suffix = labels.at(-1)!;
      if (inference === 'omnibox' && !host.startsWith('www.') && (documentSuffixes.has(suffix) || !bareDomainSuffixes.has(suffix))) return;
    }
    if (!explicit && local) url.protocol = 'http:';
  } else if (!explicit) url.protocol = 'http:';
  return url.href;
}
