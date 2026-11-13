import { mount } from 'svelte';
import Approve from './components/Approve.svelte';
import { el } from './ui.ts';

mount(Approve, { target: el('app') });
