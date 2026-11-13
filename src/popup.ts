import { mount } from 'svelte';
import Popup from './components/Popup.svelte';
import { el } from './ui.ts';

mount(Popup, { target: el('app') });
