// Fixture: no frontend may import @wp/server-kit via a BARE specifier
// either - proves frontend-never-server fires on the unresolvable/bare
// import form (CRITICAL 1a), not just the relative-path form covered by
// uses-server-kit.ts. There is no node_modules in this fixture tree, so
// this import can never resolve to a real file - dependency-cruiser
// records the raw specifier itself as `to`.
import '@wp/server-kit';
