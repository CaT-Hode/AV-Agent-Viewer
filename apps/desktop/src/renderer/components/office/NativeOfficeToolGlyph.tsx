import type { NativeOfficeToolIcon } from './native-command-icons';

export function NativeOfficeToolGlyph({ glyph }: { glyph: NativeOfficeToolIcon }) {
  const Icon = glyph.icon, Badge = glyph.badge;
  return <span className="native-office-tool-glyph" data-compound={!!Badge || undefined} aria-hidden="true">
    <Icon size={17} focusable="false" />
    {Badge && <Badge className="native-office-tool-badge" size={9} focusable="false" />}
  </span>;
}
