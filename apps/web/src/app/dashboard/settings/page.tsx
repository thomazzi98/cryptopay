import type { Metadata } from 'next';

import { MerchantSettings } from './_settings/merchant-settings';

export const metadata: Metadata = {
  title: 'Settings',
};

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight text-text">Settings</h1>
        <p className="mt-1 text-sm text-text-muted">
          The configuration this API key is subject to, exactly as the API reports it.
        </p>
      </header>
      <MerchantSettings />
    </div>
  );
}
