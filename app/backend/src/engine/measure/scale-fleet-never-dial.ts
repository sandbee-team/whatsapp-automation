import net from 'node:net';
import tls from 'node:tls';

/**
 * scale-fleet-never-dial.ts (P26 U2a) - installs the connect-layer guard
 * `mock-wa-peer.integration.test.ts#the_harness_never_dials_a_real_whatsapp_
 * host` uses, as a tiny sibling module so `scale-fleet-child.ts` stays under
 * max-lines. Patches `net.connect`/`net.createConnection`/
 * `net.Socket.prototype.connect`/`tls.connect` to THROW on any
 * `*.whatsapp.net`/`*.whatsapp.com` host, and counts ONLY attempts that
 * targeted such a host (never the child's own legitimate Postgres/Redis
 * connections, which also flow through `net.connect`) so a child process can
 * report `dialAttempts` in its `stats` message and a test can assert it is
 * exactly 0. Only installed behind `WP_SCALE_NEVER_DIAL_GUARD=1` - the child
 * never uses real sockets at all (FakeSock only), so this exists purely as
 * an assertable proof for the integration test, not a safety mechanism the
 * harness itself depends on.
 */

function isRealWhatsAppHost(hostname: string): boolean {
  return hostname.endsWith('whatsapp.net') || hostname.endsWith('whatsapp.com');
}

function hostFrom(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === 'object' && first !== null) {
    const opts = first as { host?: string; hostname?: string };
    return opts.host ?? opts.hostname;
  }
  return typeof args[1] === 'string' ? args[1] : undefined;
}

export interface NeverDialGuard {
  dialAttempts(): number;
  uninstall(): void;
}

/** Installs the guard; returns a handle to read the real-WhatsApp-host attempt count and uninstall. Never actually opens a real socket in this harness - the guard exists to PROVE that, not to enable it. */
export function installNeverDialGuard(): NeverDialGuard {
  let attempts = 0;
  const originalNetConnect = net.connect;
  const originalNetCreateConnection = net.createConnection;
  const originalProtoConnect = net.Socket.prototype.connect;
  const originalTlsConnect = tls.connect;

  const recordAndGuard = (args: readonly unknown[], api: string): void => {
    const host = hostFrom(args);
    if (host === undefined) return;
    if (isRealWhatsAppHost(host)) {
      attempts += 1;
      throw new Error(
        `scale-fleet never-dial guard (${api}): refusing to connect to a real WhatsApp host "${host}"`,
      );
    }
  };

  net.connect = ((...args: unknown[]) => {
    recordAndGuard(args, 'net.connect');
    return (originalNetConnect as unknown as (...a: unknown[]) => unknown)(...args);
  }) as typeof net.connect;

  net.createConnection = ((...args: unknown[]) => {
    recordAndGuard(args, 'net.createConnection');
    return (originalNetCreateConnection as unknown as (...a: unknown[]) => unknown)(...args);
  }) as typeof net.createConnection;

  net.Socket.prototype.connect = function patchedConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    recordAndGuard(args, 'net.Socket.prototype.connect');
    return (originalProtoConnect as unknown as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  tls.connect = ((...args: unknown[]) => {
    recordAndGuard(args, 'tls.connect');
    return (originalTlsConnect as unknown as (...a: unknown[]) => unknown)(...args);
  }) as typeof tls.connect;

  return {
    dialAttempts(): number {
      return attempts;
    },
    uninstall(): void {
      net.connect = originalNetConnect;
      net.createConnection = originalNetCreateConnection;
      net.Socket.prototype.connect = originalProtoConnect;
      tls.connect = originalTlsConnect;
    },
  };
}
