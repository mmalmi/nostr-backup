import { IRIS_APPS_ADDRESS, openSiteURL } from './helper-links.ts';

export function setupSiteOpener() {
  const catalog = document.querySelector<HTMLAnchorElement>('#irisApps')!;
  catalog.href = openSiteURL(IRIS_APPS_ADDRESS, false);
  const form = document.querySelector<HTMLFormElement>('#openSite');
  if (!form) return;
  const address = form.querySelector<HTMLInputElement>('input')!;
  const mode = form.querySelector<HTMLSelectElement>('select')!;
  mode.addEventListener('change', () => {
    catalog.href = openSiteURL(IRIS_APPS_ADDRESS, mode.value === 'local');
    address.setCustomValidity('');
  });
  address.addEventListener('input', () => address.setCustomValidity(''));
  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const url = openSiteURL(address.value, mode.value === 'local');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      address.setCustomValidity(error instanceof Error ? error.message : 'Enter a Hashtree address.');
      address.reportValidity();
    }
  });
}
