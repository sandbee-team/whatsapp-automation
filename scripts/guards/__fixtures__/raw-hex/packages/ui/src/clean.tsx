import { tokens } from '@wp/design-tokens';

export function Clean() {
  return <div style={{ color: tokens.color.semantic.light.accent }}>clean</div>;
}

// Not a colour: an anchor fragment / DOM id lookup, and a hash-route string.
export function links() {
  document.getElementById('#root');
  return { href: '#main', route: '#/dashboard' };
}
