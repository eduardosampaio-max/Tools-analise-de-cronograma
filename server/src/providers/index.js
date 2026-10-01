import { config } from '../config.js';

export async function getProvider() {
  if (config.driveMode === 'google') {
    const { googleProvider } = await import('./googleProvider.js');
    return googleProvider;
  }
  const { localProvider } = await import('./localProvider.js');
  return localProvider;
}
