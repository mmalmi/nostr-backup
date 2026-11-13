import { mount } from 'svelte';
import App from './components/App.svelte';
import { el } from './ui.ts';

mount(App, { target: el('app') });
