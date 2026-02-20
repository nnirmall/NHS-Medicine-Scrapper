import type { ProxyConfig } from './browser-manager.js';
import type { RunOptions } from './types.js';

export const createProxyConfig = (options: RunOptions): ProxyConfig | undefined => {
  if (!options.proxyServer) {
    return undefined;
  }

  return {
    server: options.proxyServer,
    ...(options.proxyUsername ? { username: options.proxyUsername } : {}),
    ...(options.proxyPassword ? { password: options.proxyPassword } : {}),
    ...(options.proxyBypass ? { bypass: options.proxyBypass } : {}),
  };
};
