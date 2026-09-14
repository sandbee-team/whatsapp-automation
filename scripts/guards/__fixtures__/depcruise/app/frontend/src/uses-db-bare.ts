// Fixture: no frontend may import @wp/db via a BARE specifier either - see
// uses-server-kit-bare.ts for why this form needs its own regex alternative.
import '@wp/db';
