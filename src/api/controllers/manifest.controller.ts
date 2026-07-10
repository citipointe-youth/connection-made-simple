import type { HttpRequest } from '../http/types';
import type { SettingsService } from '../../services/settings.service';

// Static public/manifest.json was deleted so this route is reachable — Express
// serves static files before the route table (see express-adapter.ts), so a
// same-path static file would otherwise always win.
export function makeManifestController(deps: { settings: SettingsService }) {
  return {
    async get(_req: HttpRequest) {
      const settings = await deps.settings.get();
      const b = settings.ministryConfig.branding;
      return {
        name: b.appName,
        short_name: b.shortName,
        description: 'Youth ministry connection platform',
        start_url: '/',
        display: 'standalone',
        background_color: '#f9fafb',
        theme_color: b.accent,
        orientation: 'portrait-primary',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      };
    },
  };
}
