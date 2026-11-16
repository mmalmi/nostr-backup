import { mount } from 'svelte';
import Wallet from './components/Wallet.svelte';
import { el } from './ui.ts';

mount(Wallet, { target: el('app') });
